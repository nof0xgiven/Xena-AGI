import { randomUUID } from "node:crypto";

import {
  AgentResultSchema,
  ArtifactSchema,
  MemoryRecordSchema
} from "../contracts/index.js";
import type { DurableStore } from "../persistence/repositories/durable-store.js";
import type { JsonValue } from "../persistence/repositories/durable-store.js";
import { classifyProviderError } from "../providers/openai-provider.js";
import type { RuntimeToolArtifact } from "../providers/tool-registry.js";

function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function calculateDurationMs(
  startedAt: string,
  completedAt: string | null
): number | null {
  if (!completedAt) {
    return null;
  }

  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);

  if (Number.isNaN(started) || Number.isNaN(completed)) {
    return null;
  }

  return Math.max(0, completed - started);
}

function mergeArtifacts(
  result: unknown,
  artifacts: RuntimeToolArtifact[]
): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const candidate = result as {
    artifacts?: unknown;
  };
  const currentArtifacts = Array.isArray(candidate.artifacts)
    ? (candidate.artifacts as unknown[])
    : ([] as unknown[]);

  return {
    ...candidate,
    artifacts: [...currentArtifacts, ...artifacts]
  };
}

export async function persistSuccessfulExecution(input: {
  generatedArtifacts?: RuntimeToolArtifact[];
  store: DurableStore;
  runId: string;
  taskId: string;
  startedAt: string;
  tokenUsage: JsonValue;
  costEstimate: number | null;
  result: unknown;
}): Promise<void> {
  const validatedResult = AgentResultSchema.parse(
    mergeArtifacts(input.result, input.generatedArtifacts ?? [])
  );

  for (const artifact of validatedResult.artifacts) {
    const validatedArtifact = ArtifactSchema.parse(artifact);

    await input.store.insertArtifact({
      artifactId: validatedArtifact.artifact_id,
      createdAt: validatedArtifact.created_at,
      inlinePayload: toJsonValue(validatedArtifact.inline_payload),
      metadata: toJsonValue(validatedArtifact.metadata),
      mimeType: validatedArtifact.mime_type,
      name: validatedArtifact.name,
      path: validatedArtifact.path,
      runId: validatedArtifact.run_id,
      storageKey: validatedArtifact.path,
      taskId: validatedArtifact.task_id,
      type: validatedArtifact.type,
      uri: validatedArtifact.uri
    });
  }

  for (const memoryWrite of validatedResult.memory_writes) {
    const validatedMemory = MemoryRecordSchema.parse(memoryWrite);

    await input.store.insertMemoryRecord({
      agentId: validatedMemory.agent_id,
      businessId: validatedMemory.business_id,
      confidence: validatedMemory.confidence,
      content: toJsonValue(validatedMemory.content),
      createdAt: validatedMemory.created_at,
      keywords: validatedMemory.keywords,
      memoryClass: validatedMemory.memory_class,
      memoryId: validatedMemory.memory_id,
      projectId: validatedMemory.project_id,
      provenance: toJsonValue(validatedMemory.provenance),
      scope: validatedMemory.scope,
      sourceRef: validatedMemory.source_ref,
      sourceType: validatedMemory.source_type,
      status: validatedMemory.status,
      summary: validatedMemory.summary,
      supersedesMemoryId: validatedMemory.supersedes_memory_id,
      title: validatedMemory.title,
      updatedAt: validatedMemory.updated_at,
      version: validatedMemory.version
    });
  }

  await input.store.updateRunLifecycle({
    completedAt: validatedResult.completed_at,
    costEstimate: input.costEstimate,
    durationMs: calculateDurationMs(input.startedAt, validatedResult.completed_at),
    resultPayload: toJsonValue(validatedResult),
    retryMetadata: null,
    runId: input.runId,
    status: "succeeded",
    tokenUsage: input.tokenUsage
  });

  await input.store.updateTaskState({
    completedAt:
      validatedResult.state_id === "completed"
        ? validatedResult.completed_at
        : null,
    stateId: validatedResult.state_id,
    taskId: input.taskId,
    updatedAt: validatedResult.completed_at
  });
}

export async function persistExecutionFailure(input: {
  store: DurableStore;
  runId: string;
  taskId: string;
  eventId: string;
  startedAt: string;
  completedAt: string;
  resultPayload: JsonValue;
  tokenUsage: JsonValue;
  costEstimate: number | null;
  error: unknown;
  retrying: boolean;
  exhaustedTimeout: boolean;
  nextAttempt: number | null;
}): Promise<{ deadLetterId?: string; runStatus: string }> {
  const classification = classifyProviderError(input.error);
  const runStatus = input.retrying
    ? "retrying"
    : input.exhaustedTimeout
      ? "timed_out"
      : "failed";
  const retryMetadata = {
    classification: classification.classification,
    next_attempt: input.nextAttempt,
    retryable: classification.retryable
  };

  await input.store.updateRunLifecycle({
    completedAt: input.retrying ? null : input.completedAt,
    costEstimate: input.costEstimate,
    durationMs: calculateDurationMs(input.startedAt, input.completedAt),
    resultPayload: input.resultPayload,
    retryMetadata: toJsonValue(retryMetadata),
    runId: input.runId,
    status: runStatus,
    tokenUsage: input.tokenUsage
  });

  if (input.retrying) {
    return {
      runStatus
    };
  }

  const deadLetterId = `dead_${randomUUID()}`;

  await input.store.insertDeadLetter({
    classification: input.exhaustedTimeout
      ? "provider_timeout_exhausted"
      : classification.classification,
    createdAt: input.completedAt,
    deadLetterId,
    errorMessage:
      input.error instanceof Error ? input.error.message : "Execution failed",
    eventId: input.eventId,
    payload:
      input.resultPayload ?? {
        error: input.error instanceof Error ? input.error.message : "Execution failed"
      },
    runId: input.runId,
    taskId: input.taskId
  });

  return {
    deadLetterId,
    runStatus
  };
}
