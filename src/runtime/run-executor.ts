import { AgentInvocationPayloadSchema, AgentResultSchema } from "../contracts/index.js";
import type { DurableStore } from "../persistence/repositories/durable-store.js";
import type { JsonValue } from "../persistence/repositories/durable-store.js";
import {
  classifyProviderError,
  type AgentProvider,
  ProviderExecutionError
} from "../providers/openai-provider.js";
import {
  persistExecutionFailure,
  persistSuccessfulExecution
} from "./result-persistence.js";

type ExecuteRunInput = {
  invocation: unknown;
  provider: AgentProvider;
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

  try {
    const providerResult = await input.provider.execute({
      invocation
    });
    const validatedResult = AgentResultSchema.parse(providerResult.result);

    assertAgentResultIdentity(invocation, validatedResult);
    assertRunningTransition("succeeded");

    await persistSuccessfulExecution({
      costEstimate: providerResult.costEstimate ?? null,
      result: validatedResult,
      runId: invocation.run_id,
      startedAt: persistedRun.startedAt,
      store: input.store,
      taskId: invocation.task_id,
      tokenUsage: (providerResult.tokenUsage ?? null) as JsonValue
    });

    return {
      runStatus: "succeeded"
    };
  } catch (error) {
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
