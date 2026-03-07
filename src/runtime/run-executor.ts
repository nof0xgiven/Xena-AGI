import { randomUUID } from "node:crypto";

import {
   AgentInvocationPayloadSchema,
   AgentResultSchema,
   SCHEMA_VERSION
} from "../contracts/index.js";
import type {
   DurableStore,
   JsonValue,
   RunRecord
} from "../persistence/repositories/durable-store.js";
import {
   classifyProviderError,
   type AgentProvider,
   ProviderExecutionError
} from "../providers/openai-provider.js";
import type { RuntimeToolDefinition } from "../providers/tool-registry.js";
import {
   persistExecutionFailure,
   persistSuccessfulExecution
} from "./result-persistence.js";

type ExecuteRunInput = {
   invocation: unknown;
   onSuccessfulRun?: (input: {
      invocation: ReturnType<typeof AgentInvocationPayloadSchema.parse>;
      persistedRun: RunRecord;
      result: ReturnType<typeof AgentResultSchema.parse>;
   }) => Promise<void>;
   provider: AgentProvider;
   runtimeTools?: RuntimeToolDefinition[];
   store: DurableStore;
   maxAttempts: number;
};

type ExecuteRunOutcome = {
   deadLetterId?: string;
   runStatus: string;
};

const LEGAL_RUNNING_TRANSITIONS = new Set([
   "succeeded",
   "failed",
   "timed_out",
   "retrying"
]);
const TASK_STATE_VALUES = new Set([
   "created",
   "backlog",
   "in_progress",
   "awaiting_subtasks",
   "awaiting_review",
   "qa_validation",
   "completed",
   "failed",
   "blocked"
]);
const AGENT_OUTCOME_VALUES = new Set([
   "success",
   "delegated",
   "blocked",
   "failed",
   "needs_review"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
   return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readLooseObjectOrNull(value: unknown): Record<string, unknown> | null {
   if (value === null) {
      return null;
   }

   return isRecord(value) ? value : null;
}

function readArray(value: unknown): unknown[] {
   return Array.isArray(value) ? value : [];
}

function hasCompactResultShape(candidate: Record<string, unknown>): boolean {
   return [
      "summary",
      "message",
      "state_id",
      "status",
      "outcome",
      "result",
      "output"
   ].some((key) => key in candidate);
}

function deriveTaskState(candidate: Record<string, unknown>): string {
   const explicitState = readString(candidate.state_id);

   if (explicitState && TASK_STATE_VALUES.has(explicitState)) {
      return explicitState;
   }

   switch (readString(candidate.status)) {
      case "blocked":
         return "blocked";
      case "failed":
      case "error":
         return "failed";
      case "in_progress":
      case "running":
         return "in_progress";
      case "needs_review":
      case "awaiting_review":
         return "awaiting_review";
      default:
         return "completed";
   }
}

function deriveOutcome(candidate: Record<string, unknown>): string {
   const explicitOutcome = readString(candidate.outcome);

   if (explicitOutcome && AGENT_OUTCOME_VALUES.has(explicitOutcome)) {
      return explicitOutcome;
   }

   switch (readString(candidate.status)) {
      case "blocked":
         return "blocked";
      case "delegated":
         return "delegated";
      case "failed":
      case "error":
         return "failed";
      case "needs_review":
      case "awaiting_review":
         return "needs_review";
      default:
         return "success";
   }
}

function normalizeAgentResultCandidate(input: {
   candidate: unknown;
   invocation: ReturnType<typeof AgentInvocationPayloadSchema.parse>;
}): unknown {
   if (!isRecord(input.candidate) || !hasCompactResultShape(input.candidate)) {
      return input.candidate;
   }

   const summary =
      readString(input.candidate.summary) ??
      readString(input.candidate.message) ??
      `Completed ${input.invocation.context_bundle.task.title}`;
   const status = deriveTaskState(input.candidate);
   const outcome = deriveOutcome(input.candidate);
   const compactResult =
      readLooseObjectOrNull(input.candidate.result) ??
      readLooseObjectOrNull(input.candidate.output) ??
      {
         ...(readString(input.candidate.status)
            ? { status: input.candidate.status }
            : {}),
         ...(readString(input.candidate.message)
            ? { message: input.candidate.message }
            : {})
      };

   return {
      schema_version: SCHEMA_VERSION,
      run_id: input.invocation.run_id,
      task_id: input.invocation.task_id,
      agent_id: input.invocation.agent.agent_id,
      summary,
      state_id: status,
      outcome,
      result: compactResult,
      artifacts: [],
      spawn: readArray(input.candidate.spawn),
      reentry_mode: readString(input.candidate.reentry_mode) ?? null,
      reentry_objective: readString(input.candidate.reentry_objective) ?? null,
      errors: readArray(input.candidate.errors),
      memory_writes: readArray(input.candidate.memory_writes),
      completed_at: readString(input.candidate.completed_at) ?? new Date().toISOString()
   };
}

function assertRunningTransition(nextStatus: string): void {
   if (!LEGAL_RUNNING_TRANSITIONS.has(nextStatus)) {
      throw new Error(`Illegal run state transition from running to ${nextStatus}`);
   }
}

function assertAgentResultIdentity(
   invocation: ReturnType<typeof AgentInvocationPayloadSchema.parse>,
   result: ReturnType<typeof AgentResultSchema.parse>
): void {
   if (result.run_id !== invocation.run_id) {
      throw new Error("AgentResult.run_id must match the invocation run_id");
   }

   if (result.task_id !== invocation.task_id) {
      throw new Error("AgentResult.task_id must match the invocation task_id");
   }

   if (result.agent_id !== invocation.agent.agent_id) {
      throw new Error("AgentResult.agent_id must match the invocation agent_id");
   }
}

export async function executeRun(
   input: ExecuteRunInput
): Promise<ExecuteRunOutcome> {
   const invocation = AgentInvocationPayloadSchema.parse(input.invocation);
   const persistedRun = await input.store.getRun(invocation.run_id);

   if (!persistedRun) {
      throw new Error(`Run ${invocation.run_id} does not exist`);
   }

   if (persistedRun.status !== "running") {
      throw new Error(
         `Run ${invocation.run_id} must be in running state before execution`
      );
   }
   let successCommitted = false;

   try {
      const providerExecuteInput: Parameters<typeof input.provider.execute>[0] = {
         invocation,
         toolContext: {
            agentId: invocation.agent.agent_id,
            runId: invocation.run_id,
            taskId: invocation.task_id
         }
      };

      if (input.runtimeTools) {
         providerExecuteInput.runtimeTools = input.runtimeTools;
      }

      const providerResult = await input.provider.execute(providerExecuteInput);
      let validatedResult: ReturnType<typeof AgentResultSchema.parse>;

      try {
         validatedResult = AgentResultSchema.parse(providerResult.result);
      } catch (error) {
         if (error instanceof Error && error.name === "ZodError") {
            validatedResult = AgentResultSchema.parse(
               normalizeAgentResultCandidate({
                  candidate: providerResult.result,
                  invocation
               })
            );
         } else {
            throw error;
         }
      }

      assertAgentResultIdentity(invocation, validatedResult);
      assertRunningTransition("succeeded");

      for (const toolExecution of providerResult.toolExecutions ?? []) {
         await input.store.insertEvent({
            agentId: invocation.agent.agent_id,
            businessId: invocation.context_bundle.task.business_id,
            causationId: persistedRun.triggerEventId,
            correlationId: invocation.task_id,
            createdAt: toolExecution.recordedAt,
            dedupeKey: null,
            emittedBy: "xena.runtime",
            eventId: `evt_${randomUUID()}`,
            eventType: "run.tool_executed",
            payload: toolExecution.trace,
            projectId: invocation.context_bundle.task.project_id,
            runId: invocation.run_id,
            taskId: invocation.task_id
         });
      }

      await persistSuccessfulExecution({
         costEstimate: providerResult.costEstimate ?? null,
         generatedArtifacts: (providerResult.toolExecutions ?? []).flatMap(
            (toolExecution) => toolExecution.artifacts ?? []
         ),
         result: validatedResult,
         runId: invocation.run_id,
         startedAt: persistedRun.startedAt,
         store: input.store,
         taskId: invocation.task_id,
         tokenUsage: (providerResult.tokenUsage ?? null) as JsonValue
      });
      successCommitted = true;

      await input.store.insertEvent({
         agentId: invocation.agent.agent_id,
         businessId: invocation.context_bundle.task.business_id,
         causationId: persistedRun.triggerEventId,
         correlationId: invocation.task_id,
         createdAt: new Date().toISOString(),
         dedupeKey: null,
         emittedBy: "xena.runtime",
         eventId: `evt_${randomUUID()}`,
         eventType: "run.completed",
         payload: {
            run_status: "succeeded"
         },
         projectId: invocation.context_bundle.task.project_id,
         runId: invocation.run_id,
         taskId: invocation.task_id
      });

      if (input.onSuccessfulRun) {
         await input.onSuccessfulRun({
            invocation,
            persistedRun,
            result: validatedResult
         });
      }

      return {
         runStatus: "succeeded"
      };
   } catch (error) {
      if (successCommitted) {
         throw error;
      }
      if (!(error instanceof Error)) {
         throw error;
      }

      if (error.name === "ZodError" || error.message.includes("AgentResult")) {
         assertRunningTransition("failed");

         return persistExecutionFailure({
            completedAt: new Date().toISOString(),
            costEstimate: null,
            error: new ProviderExecutionError(
               `invalid_agent_result: ${error.message}`,
               {
                  classification: "invalid_agent_result",
                  retryable: false
               }
            ),
            eventId: persistedRun.triggerEventId,
            exhaustedTimeout: false,
            nextAttempt: null,
            resultPayload: null,
            retrying: false,
            runId: invocation.run_id,
            startedAt: persistedRun.startedAt,
            store: input.store,
            taskId: invocation.task_id,
            tokenUsage: null
         });
      }

      const classification = classifyProviderError(error);
      const exhaustedTimeout =
         classification.classification === "provider_timeout" &&
         persistedRun.attempt >= input.maxAttempts;
      const retrying =
         classification.retryable &&
         classification.classification === "provider_timeout" &&
         persistedRun.attempt < input.maxAttempts;

      assertRunningTransition(retrying ? "retrying" : exhaustedTimeout ? "timed_out" : "failed");

      return persistExecutionFailure({
         completedAt: new Date().toISOString(),
         costEstimate: null,
         error,
         eventId: persistedRun.triggerEventId,
         exhaustedTimeout,
         nextAttempt: retrying ? persistedRun.attempt + 1 : null,
         resultPayload: null,
         retrying,
         runId: invocation.run_id,
         startedAt: persistedRun.startedAt,
         store: input.store,
         taskId: invocation.task_id,
         tokenUsage: null
      });
   }
}
