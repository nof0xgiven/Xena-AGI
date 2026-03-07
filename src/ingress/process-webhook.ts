import { randomUUID } from "node:crypto";

import { defaultAgentDefinitions } from "../agents/default-definitions.js";
import { defaultAgentOverrides } from "../agents/default-overrides.js";
import { AgentRegistry } from "../agents/registry.js";
import { loadProcessEnv } from "../config/env.js";
import {
   AgentInvocationPayloadSchema,
   WebhookEnvelopeSchema,
   type WebhookEnvelope
} from "../contracts/index.js";
import {
   classifyIngressAttempt,
   createIngressScopeKey
} from "./idempotency.js";
import { createDatabaseClient } from "../persistence/db.js";
import { runMigrations } from "../persistence/migrations.js";
import {
   createDurableStore,
   type DurableStore
} from "../persistence/repositories/durable-store.js";
import { createRuntimeDispatcher } from "../orchestration/runtime-dispatcher.js";

type ProcessWebhookResult = {
   proof_url: string | null;
   run_id: string | null;
   task_id: string;
   webhook_status: number;
};

type ProcessWebhookDependencies = {
   now?: () => string;
   registry?: AgentRegistry;
   runTask?: (payload: { invocation: unknown }) => Promise<unknown>;
   sql?: ReturnType<typeof createDatabaseClient>;
   store?: DurableStore;
};

type TaskRequestPayload = {
   agent_id: string;
   business_id: string;
   idempotency_key?: string;
   message: string;
   project_id: string;
   source_ref?: string | null;
   title: string;
};

function jsonValue(value: unknown) {
   return value as import("../persistence/repositories/durable-store.js").JsonValue;
}

function taskId(): string {
   return `task_${randomUUID()}`;
}


function eventId(): string {
   return `evt_${randomUUID()}`;
}

function parseTaskRequestPayload(envelope: WebhookEnvelope): TaskRequestPayload {
   const payload = envelope.payload;

   if (!("task_request" in payload)) {
      throw new Error("Webhook payload must include task_request");
   }

   return payload.task_request as TaskRequestPayload;
}

function extractExistingEnvelopePayload(event: {
   payload: unknown;
}): WebhookEnvelope | undefined {
   if (
      !event.payload ||
      typeof event.payload !== "object" ||
      !("envelope" in event.payload)
   ) {
      return undefined;
   }

   return event.payload.envelope as WebhookEnvelope;
}

export async function triggerAgentRun(payload: {
   invocation: unknown;
}, options: {
   apiUrl?: string;
   secretKey: string;
}) {
   const invocation = AgentInvocationPayloadSchema.parse(payload.invocation);
   const triggerSdk = await import("@trigger.dev/sdk/v3");
   const triggerClientConfig: {
      baseURL?: string;
      secretKey: string;
   } = {
      secretKey: options.secretKey
   };

   if (options.apiUrl) {
      triggerClientConfig.baseURL = options.apiUrl;
   }

   triggerSdk.configure(triggerClientConfig);

   const handle = await triggerSdk.tasks.trigger("run-agent", {
      invocation
   }, {
      idempotencyKey: invocation.run_id
   });
   const run = await triggerSdk.runs.poll(handle.id, {
      pollIntervalMs: 250
   });

   return {
      handle_id: handle.id,
      output: jsonValue(run.output ?? null),
      status: run.status,
      task_identifier: run.taskIdentifier
   };
}

export function createWebhookProcessor(
   dependencies: ProcessWebhookDependencies = {}
) {
   const env = loadProcessEnv({
      requireTrigger: true
   });
   const now = dependencies.now ?? (() => new Date().toISOString());
   const sql = dependencies.sql ?? createDatabaseClient();
   const store = dependencies.store ?? createDurableStore(sql);
   const registry =
      dependencies.registry ??
      new AgentRegistry(defaultAgentDefinitions, defaultAgentOverrides);
   const runTask =
      dependencies.runTask ??
      (async (payload: { invocation: unknown }) => {
         if (!env.trigger.secretKey) {
            throw new Error("Trigger secret key is required to invoke run-agent");
         }

         return triggerAgentRun(payload, {
            ...(env.trigger.apiUrl ? { apiUrl: env.trigger.apiUrl } : {}),
            secretKey: env.trigger.secretKey
         });
      });
   const runtimeDispatcher = createRuntimeDispatcher({
      environment: env.nodeEnv,
      now,
      registry,
      runTask,
      sql,
      store
   });

   return {
      async buildTaskProof(taskIdValue: string) {
         await runMigrations(sql);

         const task = await store.getTask(taskIdValue);

         if (!task) {
            return null;
         }
         const lineage = await store.listTaskLineage(task.rootTaskId);

         const lineageTaskIds = lineage.tasks.map((lineageTask) => lineageTask.taskId);
         const events = await store.listEvents({
            taskIds: lineageTaskIds
         });
         const artifacts = await Promise.all(
            lineage.runs.map(async (run) => store.listArtifactsForRun(run.runId))
         );
         const memoryRecords = await Promise.all(
            lineage.runs.map(async (run) => store.listMemoryRecordsBySourceRef(run.runId))
         );
         const rootTask =
            lineage.tasks.find((lineageTask) => lineageTask.taskId === task.rootTaskId) ?? task;
         const rootEvents = events.filter((event) => event.taskId === rootTask.taskId);
         const rootRuns = lineage.runs.filter((run) => run.taskId === rootTask.taskId);
         const invocationEvent = rootEvents.find(
            (event) => event.eventType === "run.invocation_prepared"
         );
         const ingressEvent = rootEvents.find((event) => event.eventType === "ingress.received");
         const latestRun = rootRuns.at(-1) ?? null;

         return {
            agent:
               invocationEvent && typeof invocationEvent.payload === "object" && invocationEvent.payload
                  ? (invocationEvent.payload as { agent?: unknown }).agent ?? null
                  : null,
            api_input:
               ingressEvent && typeof ingressEvent.payload === "object" && ingressEvent.payload
                  ? (ingressEvent.payload as { api_input?: unknown }).api_input ?? null
                  : null,
            artifacts: artifacts.flat(),
            context_bundle:
               invocationEvent && typeof invocationEvent.payload === "object" && invocationEvent.payload
                  ? (invocationEvent.payload as { context_bundle?: unknown }).context_bundle ?? null
                  : null,
            events,
            memory_records: memoryRecords.flat(),
            prompt:
               invocationEvent && typeof invocationEvent.payload === "object" && invocationEvent.payload
                  ? ((invocationEvent.payload as { prompt?: { instructions?: string } }).prompt
                     ?.instructions ?? null)
                  : null,
            result: latestRun?.resultPayload ?? null,
            runs: lineage.runs,
            task,
            tool_executions: events
               .filter((event) => event.eventType === "run.tool_executed")
               .map((event) => event.payload),
            tool_registry:
               invocationEvent && typeof invocationEvent.payload === "object" && invocationEvent.payload
                  ? (invocationEvent.payload as { tool_registry?: unknown[] }).tool_registry ?? []
                  : []
         };
      },

      async process(envelopeCandidate: unknown): Promise<ProcessWebhookResult> {
         await runMigrations(sql);

         const envelope = WebhookEnvelopeSchema.parse(envelopeCandidate);
         const existingEvent = (await store.listEvents()).find(
            (event) => event.dedupeKey === createIngressScopeKey(envelope)
         );
         const decision = classifyIngressAttempt(
            existingEvent ? extractExistingEnvelopePayload(existingEvent) : undefined,
            envelope
         );

         if (decision.kind === "conflict") {
            throw new Error(decision.reason);
         }

         if (decision.kind === "duplicate" && existingEvent?.taskId) {
            return {
               proof_url: `${env.publicBaseUrl}/tasks/${existingEvent.taskId}/proof`,
               run_id: existingEvent.runId,
               task_id: existingEvent.taskId,
               webhook_status: 200
            };
         }

         const taskRequest = parseTaskRequestPayload(envelope);
         const businessId = envelope.business_id ?? taskRequest.business_id;
         const projectId = envelope.project_id ?? taskRequest.project_id;
         const agent = registry.resolve(envelope.agent_id ?? taskRequest.agent_id, undefined, {
            businessId,
            environment: env.nodeEnv,
            projectId
         });
         const timestamp = now();
         const taskIdValue = envelope.task_id ?? taskId();

         const rootTask = {
            assignedAt: timestamp,
            businessId,
            completedAt: null,
            createdAt: timestamp,
            createdBy: envelope.emitted_by,
            message: taskRequest.message,
            parentTaskId: null,
            priority: "high",
            projectId,
            requestedAgentId: agent.agent_id,
            rootTaskId: taskIdValue,
            source: "http_api",
            sourceRef: taskRequest.source_ref ?? null,
            stateId: "in_progress",
            taskId: taskIdValue,
            title: taskRequest.title,
            updatedAt: timestamp
         };

         await store.insertTask(rootTask);

         const ingressEvent = {
            agentId: agent.agent_id,
            businessId,
            causationId: null,
            correlationId: taskIdValue,
            createdAt: timestamp,
            dedupeKey: createIngressScopeKey(envelope),
            emittedBy: envelope.emitted_by,
            eventId: eventId(),
            eventType: "ingress.received",
            payload: jsonValue({
               api_input: taskRequest,
               envelope
            }),
            projectId,
            runId: null,
            taskId: taskIdValue
         };

         await store.insertEvent(ingressEvent);

         const dispatchedRun = await runtimeDispatcher.dispatchTaskRun({
            attempt: 1,
            parentRunId: null,
            task: rootTask,
            triggerEvent: ingressEvent
         });

         return {
            proof_url: `${env.publicBaseUrl}/tasks/${taskIdValue}/proof`,
            run_id: dispatchedRun.runId,
            task_id: taskIdValue,
            webhook_status: 201
         };
      }
   };
}
