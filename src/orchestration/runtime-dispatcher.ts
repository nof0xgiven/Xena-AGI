import { randomUUID } from "node:crypto";

import { defaultAgentDefinitions } from "../agents/default-definitions.js";
import { defaultAgentOverrides } from "../agents/default-overrides.js";
import { AgentRegistry } from "../agents/registry.js";
import type { RegisteredAgentDefinition } from "../agents/types.js";
import {
   AgentInvocationPayloadSchema,
   AgentResultSchema,
   SCHEMA_VERSION
} from "../contracts/index.js";
import { createDatabaseClient } from "../persistence/db.js";
import type {
   DurableStore,
   EventRecord,
   JsonValue,
   RunRecord,
   TaskRecord
} from "../persistence/repositories/durable-store.js";
import { renderPromptFile } from "../prompts/render.js";
import { buildToolRegistry } from "../providers/tool-registry.js";
import { createDatabaseContextBuilder } from "../runtime/context-builder.js";
import {
   createFilesystemTools,
   serializeToolDefinitions
} from "../tools/filesystem.js";
import { createDelegationCoordinator } from "./delegation.js";

type RuntimeDispatcherDependencies = {
   environment?: string;
   now?: () => string;
   registry?: AgentRegistry;
   runTask: (payload: { invocation: unknown }) => Promise<unknown>;
   sql: ReturnType<typeof createDatabaseClient>;
   store: DurableStore;
};

type DispatchTaskRunInput = {
   attempt: number;
   parentRunId: string | null;
   task: TaskRecord;
   triggerEvent: EventRecord;
};

type AgentInvocationPayload = ReturnType<typeof AgentInvocationPayloadSchema.parse>;
type AgentResult = ReturnType<typeof AgentResultSchema.parse>;

function jsonValue(value: unknown): JsonValue {
   return value as JsonValue;
}

function runId(): string {
   return `run_${randomUUID()}`;
}

function eventId(): string {
   return `evt_${randomUUID()}`;
}

function normalizeTimestamp(value: unknown): string | null {
   if (value === null || value === undefined) {
      return null;
   }

   if (typeof value === "string") {
      return value;
   }

   if (value instanceof Date) {
      return value.toISOString();
   }

   throw new Error("Expected timestamp values to be strings or Date instances");
}

export function createRuntimeDispatcher(
   dependencies: RuntimeDispatcherDependencies
) {
   const now = dependencies.now ?? (() => new Date().toISOString());
   const registry =
      dependencies.registry ??
      new AgentRegistry(defaultAgentDefinitions, defaultAgentOverrides);

   const resolveAgent = (task: TaskRecord): RegisteredAgentDefinition =>
      registry.resolve(task.requestedAgentId, undefined, {
         businessId: task.businessId,
         ...(dependencies.environment ? { environment: dependencies.environment } : {}),
         projectId: task.projectId
      });

   const dispatchTaskRun = async (input: DispatchTaskRunInput) => {
      const timestamp = now();
      const agent = resolveAgent(input.task);
      const runIdValue = runId();
      const normalizedTask = {
         ...input.task,
         assignedAt: normalizeTimestamp(input.task.assignedAt),
         completedAt: normalizeTimestamp(input.task.completedAt),
         createdAt: normalizeTimestamp(input.task.createdAt) ?? timestamp,
         updatedAt: normalizeTimestamp(input.task.updatedAt) ?? timestamp
      };

      await dependencies.store.updateTaskState({
         completedAt: null,
         stateId: "in_progress",
         taskId: input.task.taskId,
         updatedAt: timestamp
      });

      await dependencies.store.insertRun({
         agentId: agent.agent_id,
         attempt: input.attempt,
         completedAt: null,
         costEstimate: null,
         durationMs: null,
         model: agent.model,
         parentRunId: input.parentRunId,
         provider: agent.provider,
         reasoningEffort: agent.reasoning_effort,
         resultPayload: null,
         retryMetadata: null,
         runId: runIdValue,
         startedAt: timestamp,
         status: "running",
         taskId: input.task.taskId,
         tokenUsage: null,
         triggerEventId: input.triggerEvent.eventId
      });

      const contextBuilder = createDatabaseContextBuilder(dependencies.sql);
      const contextBundle = await contextBuilder.build({
         business: {
            business_id: input.task.businessId
         },
         objective: input.task.message,
         project: {
            project_id: input.task.projectId
         },
         query_text: input.task.message,
         run: {
            schema_version: SCHEMA_VERSION,
            run_id: runIdValue,
            task_id: input.task.taskId,
            parent_run_id: input.parentRunId,
            agent_id: agent.agent_id,
            trigger_event_id: input.triggerEvent.eventId,
            status: "running",
            attempt: input.attempt,
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
            task_id: input.task.taskId,
            root_task_id: input.task.rootTaskId,
            parent_task_id: input.task.parentTaskId,
            business_id: input.task.businessId,
            project_id: input.task.projectId,
            requested_agent_id: agent.agent_id,
            title: input.task.title,
            message: input.task.message,
            state_id: "in_progress",
            priority: input.task.priority,
            source: input.task.source,
            source_ref: input.task.sourceRef,
            created_by: input.task.createdBy,
            assigned_at: normalizedTask.assignedAt,
            created_at: normalizedTask.createdAt,
            updated_at: timestamp,
            completed_at: null
         }
      });
      const runtimeTools = buildToolRegistry(agent, createFilesystemTools());
      const promptInstructions = await renderPromptFile(agent.system_prompt_ref, {
         objective: input.task.message
      });
      const invocation: AgentInvocationPayload = {
         schema_version: SCHEMA_VERSION,
         run_id: runIdValue,
         task_id: input.task.taskId,
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

      await dependencies.store.insertEvent({
         agentId: agent.agent_id,
         businessId: input.task.businessId,
         causationId: input.triggerEvent.eventId,
         correlationId: input.task.rootTaskId,
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
         projectId: input.task.projectId,
         runId: runIdValue,
         taskId: input.task.taskId
      });

      const triggerResult = await dependencies.runTask({
         invocation
      });

      await dependencies.store.insertEvent({
         agentId: agent.agent_id,
         businessId: input.task.businessId,
         causationId: input.triggerEvent.eventId,
         correlationId: input.task.rootTaskId,
         createdAt: now(),
         dedupeKey: null,
         emittedBy: "xena.ingress",
         eventId: eventId(),
         eventType: "run.trigger_completed",
         payload: jsonValue(triggerResult),
         projectId: input.task.projectId,
         runId: runIdValue,
         taskId: input.task.taskId
      });

      return {
         invocation,
         runId: runIdValue,
         triggerResult
      };
   };

   const handleSuccessfulRun = async (input: {
      invocation: unknown;
      persistedRun: RunRecord;
      result: unknown;
   }): Promise<void> => {
      const invocation = AgentInvocationPayloadSchema.parse(input.invocation);
      const result: AgentResult = AgentResultSchema.parse(input.result);
      const task = await dependencies.store.getTask(invocation.task_id);

      if (!task) {
         throw new Error(`Task ${invocation.task_id} does not exist`);
      }

      const coordinator = createDelegationCoordinator({
         ...(dependencies.environment ? { environment: dependencies.environment } : {}),
         now,
         registry,
         store: dependencies.store
      });

      if (result.outcome === "delegated" && result.spawn.length > 0) {
         const delegation = await coordinator.delegateFromResult({
            parentRun: input.persistedRun,
            parentTask: task,
            result
         });

         for (const child of delegation.childTasks) {
            const childTask = await dependencies.store.getTask(child.taskId);

            if (!childTask) {
               throw new Error(`Delegated child task ${child.taskId} does not exist`);
            }

            const childTriggerEvent = (await dependencies.store.listEvents({
               taskId: child.taskId
            })).find((event) => event.eventType === "task.created");

            if (!childTriggerEvent) {
               throw new Error(`Missing task.created event for child task ${child.taskId}`);
            }

            await dispatchTaskRun({
               attempt: 1,
               parentRunId: input.persistedRun.runId,
               task: childTask,
               triggerEvent: childTriggerEvent
            });
         }

         return;
      }

      if (task.parentTaskId === null || task.source !== "delegation") {
         return;
      }

      const completion = await coordinator.recordChildCompletion(task.taskId);

      if (!completion.reentryEvent) {
         return;
      }

      if (!completion.reentryEvent.taskId || !completion.reentryEvent.runId) {
         throw new Error("Re-entry event must include parent task and run identifiers");
      }

      const parentTask = await dependencies.store.getTask(completion.reentryEvent.taskId);
      const parentRun = await dependencies.store.getRun(completion.reentryEvent.runId);

      if (!parentTask) {
         throw new Error(`Parent task ${completion.reentryEvent.taskId} does not exist`);
      }

      if (!parentRun) {
         throw new Error(`Parent run ${completion.reentryEvent.runId} does not exist`);
      }

      await dispatchTaskRun({
         attempt: parentRun.attempt + 1,
         parentRunId: parentRun.runId,
         task: parentTask,
         triggerEvent: completion.reentryEvent
      });
   };

   return {
      dispatchTaskRun,
      handleSuccessfulRun
   };
}
