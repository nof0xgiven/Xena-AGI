import { randomUUID } from "node:crypto";

import { defaultAgentDefinitions } from "../agents/default-definitions.js";
import { AgentRegistry } from "../agents/registry.js";
import { loadProcessEnv } from "../config/env.js";
import {
  AgentInvocationPayloadSchema,
  SCHEMA_VERSION,
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
import { renderPromptFile } from "../prompts/render.js";
import { buildToolRegistry } from "../providers/tool-registry.js";
import { createDatabaseContextBuilder } from "../runtime/context-builder.js";
import {
  createFilesystemTools,
  serializeToolDefinitions
} from "../tools/filesystem.js";

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

function runId(): string {
  return `run_${randomUUID()}`;
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

async function triggerAgentRun(payload: {
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
    dependencies.registry ?? new AgentRegistry(defaultAgentDefinitions);
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

  return {
    async buildTaskProof(taskIdValue: string) {
      await runMigrations(sql);

      const task = await store.getTask(taskIdValue);

      if (!task) {
        return null;
      }

      const lineage = await store.listTaskLineage(task.rootTaskId);
      const events = await store.listEvents({
        taskId: taskIdValue
      });
      const taskRuns = lineage.runs.filter((run) => run.taskId === taskIdValue);
      const artifacts = await Promise.all(
        taskRuns.map(async (run) => store.listArtifactsForRun(run.runId))
      );
      const memoryRecords = await Promise.all(
        taskRuns.map(async (run) => store.listMemoryRecordsBySourceRef(run.runId))
      );
      const invocationEvent = events.find(
        (event) => event.eventType === "run.invocation_prepared"
      );
      const ingressEvent = events.find((event) => event.eventType === "ingress.received");
      const latestRun = taskRuns.at(-1) ?? null;

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
        runs: taskRuns,
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
      const agent = registry.resolve(envelope.agent_id ?? taskRequest.agent_id);
      const timestamp = now();
      const taskIdValue = envelope.task_id ?? taskId();
      const runIdValue = runId();
      const ingressEventId = eventId();
      const businessId = envelope.business_id ?? taskRequest.business_id;
      const projectId = envelope.project_id ?? taskRequest.project_id;

      await store.insertTask({
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
      });

      await store.insertEvent({
        agentId: agent.agent_id,
        businessId,
        causationId: null,
        correlationId: taskIdValue,
        createdAt: timestamp,
        dedupeKey: createIngressScopeKey(envelope),
        emittedBy: envelope.emitted_by,
        eventId: ingressEventId,
        eventType: "ingress.received",
        payload: jsonValue({
          api_input: taskRequest,
          envelope
        }),
        projectId,
        runId: null,
        taskId: taskIdValue
      });
      await store.insertRun({
        agentId: agent.agent_id,
        attempt: 1,
        completedAt: null,
        costEstimate: null,
        durationMs: null,
        model: agent.model,
        parentRunId: null,
        provider: agent.provider,
        reasoningEffort: agent.reasoning_effort,
        resultPayload: null,
        retryMetadata: null,
        runId: runIdValue,
        startedAt: timestamp,
        status: "running",
        taskId: taskIdValue,
        tokenUsage: null,
        triggerEventId: ingressEventId
      });

      const contextBuilder = createDatabaseContextBuilder(sql);
      const contextBundle = await contextBuilder.build({
        business: {
          business_id: businessId
        },
        objective: taskRequest.message,
        project: {
          project_id: projectId
        },
        query_text: taskRequest.message,
        run: {
          schema_version: SCHEMA_VERSION,
          run_id: runIdValue,
          task_id: taskIdValue,
          parent_run_id: null,
          agent_id: agent.agent_id,
          trigger_event_id: ingressEventId,
          status: "running",
          attempt: 1,
          provider: agent.provider,
          model: agent.model,
          reasoning_effort: agent.reasoning_effort,
          started_at: timestamp,
          completed_at: null,
          duration_ms: null,
          token_usage: null,
          cost_estimate: null
        },
        task: {
          schema_version: SCHEMA_VERSION,
          task_id: taskIdValue,
          root_task_id: taskIdValue,
          parent_task_id: null,
          business_id: businessId,
          project_id: projectId,
          requested_agent_id: agent.agent_id,
          title: taskRequest.title,
          message: taskRequest.message,
          state_id: "in_progress",
          priority: "high",
          source: "http_api",
          source_ref: taskRequest.source_ref ?? null,
          created_by: envelope.emitted_by,
          assigned_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
          completed_at: null
        }
      });
      const runtimeTools = buildToolRegistry(agent, createFilesystemTools());
      const promptInstructions = await renderPromptFile(agent.system_prompt_ref, {
        objective: taskRequest.message
      });
      const invocation = {
        schema_version: SCHEMA_VERSION,
        run_id: runIdValue,
        task_id: taskIdValue,
        agent,
        context_bundle: contextBundle,
        tool_registry: serializeToolDefinitions(runtimeTools),
        constraints: {
          max_tool_calls: agent.max_tool_calls
        },
        prompt: {
          instructions: promptInstructions
        }
      };

      await store.insertEvent({
        agentId: agent.agent_id,
        businessId,
        causationId: ingressEventId,
        correlationId: taskIdValue,
        createdAt: timestamp,
        dedupeKey: null,
        emittedBy: "xena.ingress",
        eventId: eventId(),
        eventType: "run.invocation_prepared",
        payload: jsonValue({
          agent,
          context_bundle: contextBundle,
          prompt: invocation.prompt,
          tool_registry: invocation.tool_registry
        }),
        projectId,
        runId: runIdValue,
        taskId: taskIdValue
      });

      const triggerResult = await runTask({
        invocation
      });

      await store.insertEvent({
        agentId: agent.agent_id,
        businessId,
        causationId: ingressEventId,
        correlationId: taskIdValue,
        createdAt: now(),
        dedupeKey: null,
        emittedBy: "xena.ingress",
        eventId: eventId(),
        eventType: "run.trigger_completed",
        payload: jsonValue(triggerResult),
        projectId,
        runId: runIdValue,
        taskId: taskIdValue
      });

      return {
        proof_url: `${env.publicBaseUrl}/tasks/${taskIdValue}/proof`,
        run_id: runIdValue,
        task_id: taskIdValue,
        webhook_status: 201
      };
    }
  };
}
