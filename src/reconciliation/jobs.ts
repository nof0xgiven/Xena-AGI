import { randomUUID } from "node:crypto";

import {
  MemoryPromotionRequestSchema,
  MemoryRecordSchema,
  SCHEMA_VERSION
} from "../contracts/index.js";
import type {
  DurableStore,
  EventRecord,
  PromotionRequestRecord
} from "../persistence/repositories/durable-store.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { createMetrics, type Metrics } from "../observability/metrics.js";
import { evaluateRequiredChildren } from "../orchestration/delegation-state.js";

type ReconciliationDependencies = {
  logger?: Logger;
  metrics?: Metrics;
  now?: () => string;
  store: DurableStore;
};

const FORBIDDEN_GLOBAL_KEYS = new Set([
  "agent_id",
  "artifact_id",
  "business_id",
  "customer",
  "project_id",
  "run_id",
  "task_id"
]);

function toJsonValue(value: unknown) {
  return value as import("../persistence/repositories/durable-store.js").JsonValue;
}

function containsBusinessSpecificDetails(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsBusinessSpecificDetails(entry));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, nestedValue]) =>
        FORBIDDEN_GLOBAL_KEYS.has(key) || containsBusinessSpecificDetails(nestedValue)
    );
  }

  return false;
}

export function createReconciliationJobs(
  dependencies: ReconciliationDependencies
) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const logger = dependencies.logger ?? createLogger(now);
  const metrics = dependencies.metrics ?? createMetrics();

  return {
    async reconcileAwaitingSubtasks(): Promise<{
      reenteredTaskIds: string[];
      reviewedTaskIds: string[];
    }> {
      const timestamp = now();
      const contracts =
        await dependencies.store.listDelegationContractsByStatus("pending");
      const reenteredTaskIds: string[] = [];
      const reviewedTaskIds: string[] = [];

      for (const contract of contracts) {
        const childTasks = await Promise.all(
          contract.childTaskIds.map(async (childTaskId) =>
            dependencies.store.getTask(childTaskId)
          )
        );
        const taskStateById = new Map(
          childTasks
            .filter((task): task is NonNullable<typeof task> => task !== null)
            .map((task) => [task.taskId, task.stateId])
        );
        const { requiredFailed, requiredSatisfied } = evaluateRequiredChildren(
          contract.requiredChildren,
          taskStateById
        );

        if (requiredFailed) {
          await dependencies.store.updateDelegationStatus({
            delegationId: contract.delegationId,
            status: "failed",
            updatedAt: timestamp
          });
          await dependencies.store.updateTaskState({
            completedAt: null,
            stateId: "awaiting_review",
            taskId: contract.parentTaskId,
            updatedAt: timestamp
          });
          reviewedTaskIds.push(contract.parentTaskId);
          continue;
        }

        if (!requiredSatisfied) {
          continue;
        }

        const existingReentryEvents = await dependencies.store.listEvents({
          eventType: "task.reentry_requested",
          taskId: contract.parentTaskId
        });

        if (existingReentryEvents.length === 0) {
          const reentryEvent: EventRecord = {
            agentId: contract.reentryAgentId,
            businessId: null,
            causationId: contract.delegationId,
            correlationId: contract.parentTaskId,
            createdAt: timestamp,
            dedupeKey: null,
            emittedBy: "xena.reconciliation",
            eventId: `evt_${randomUUID()}`,
            eventType: "task.reentry_requested",
            payload: {
              delegation_id: contract.delegationId,
              objective: contract.reentryObjective
            },
            projectId: null,
            runId: contract.parentRunId,
            taskId: contract.parentTaskId
          };

          await dependencies.store.insertEvent(reentryEvent);
        }

        await dependencies.store.updateDelegationStatus({
          delegationId: contract.delegationId,
          status: "satisfied",
          updatedAt: timestamp
        });
        reenteredTaskIds.push(contract.parentTaskId);
      }

      logger.info("reconciliation.awaiting_subtasks", {
        reentered_task_count: reenteredTaskIds.length,
        reviewed_task_count: reviewedTaskIds.length
      });
      metrics.increment("reconciliation.awaiting_subtasks");

      return {
        reenteredTaskIds,
        reviewedTaskIds
      };
    },

    async createPromotionRequest(input: {
      abstractedContent: unknown;
      abstractedTitle: string;
      provenanceRefs: string[];
      redactionNotes: string | null;
      requestedByAgentId: string;
      sourceMemoryIds: string[];
    }) {
      const request = MemoryPromotionRequestSchema.parse({
        schema_version: SCHEMA_VERSION,
        promotion_request_id: `promote_${randomUUID()}`,
        source_memory_ids: input.sourceMemoryIds,
        requested_by_agent_id: input.requestedByAgentId,
        target_scope: "global_patterns",
        abstracted_title: input.abstractedTitle,
        abstracted_content: input.abstractedContent,
        redaction_notes: input.redactionNotes,
        provenance_refs: input.provenanceRefs,
        status: "pending_review",
        reviewed_by: null,
        reviewed_at: null,
        created_at: now()
      });
      const record: PromotionRequestRecord = {
        abstractedContent: toJsonValue(request.abstracted_content),
        abstractedTitle: request.abstracted_title,
        createdAt: request.created_at,
        promotionRequestId: request.promotion_request_id,
        provenanceRefs: request.provenance_refs,
        redactionNotes: request.redaction_notes,
        requestedByAgentId: request.requested_by_agent_id,
        reviewedAt: request.reviewed_at,
        reviewedBy: request.reviewed_by,
        sourceMemoryIds: request.source_memory_ids,
        status: request.status,
        targetScope: request.target_scope
      };

      await dependencies.store.insertPromotionRequest(record);

      return request;
    },

    async approvePromotionRequest(input: {
      promotionRequestId: string;
      reviewedBy: string;
    }) {
      const request = await dependencies.store.getPromotionRequest(
        input.promotionRequestId
      );

      if (!request) {
        throw new Error(
          `Promotion request ${input.promotionRequestId} does not exist`
        );
      }

      if (containsBusinessSpecificDetails(request.abstractedContent)) {
        await dependencies.store.updatePromotionRequest({
          promotionRequestId: request.promotionRequestId,
          reviewedAt: now(),
          reviewedBy: input.reviewedBy,
          status: "rejected"
        });

        throw new Error(
          "Promotion request still contains business-specific fields"
        );
      }

      const sourceMemories = await dependencies.store.listMemoryRecordsByIds(
        request.sourceMemoryIds
      );
      const promoted = MemoryRecordSchema.parse({
        schema_version: SCHEMA_VERSION,
        memory_id: `memory_${randomUUID()}`,
        memory_class: "procedural",
        scope: "global_patterns",
        business_id: null,
        project_id: null,
        agent_id: null,
        title: request.abstractedTitle,
        summary: request.abstractedTitle,
        content: request.abstractedContent,
        keywords: Array.from(
          new Set(
            sourceMemories.flatMap((memory) => memory.keywords).slice(0, 8)
          )
        ),
        source_type: "promotion_request",
        source_ref: request.promotionRequestId,
        provenance: [
          {
            source_memory_ids: request.sourceMemoryIds,
            provenance_refs: request.provenanceRefs
          }
        ],
        confidence: 0.9,
        version: 1,
        supersedes_memory_id: null,
        status: "active",
        created_at: now(),
        updated_at: now()
      });

      await dependencies.store.insertMemoryRecord({
        agentId: promoted.agent_id,
        businessId: promoted.business_id,
        confidence: promoted.confidence,
        content: toJsonValue(promoted.content),
        createdAt: promoted.created_at,
        keywords: promoted.keywords,
        memoryClass: promoted.memory_class,
        memoryId: promoted.memory_id,
        projectId: promoted.project_id,
        provenance: toJsonValue(promoted.provenance),
        scope: promoted.scope,
        sourceRef: promoted.source_ref,
        sourceType: promoted.source_type,
        status: promoted.status,
        summary: promoted.summary,
        supersedesMemoryId: promoted.supersedes_memory_id,
        title: promoted.title,
        updatedAt: promoted.updated_at,
        version: promoted.version
      });
      await dependencies.store.updatePromotionRequest({
        promotionRequestId: request.promotionRequestId,
        reviewedAt: now(),
        reviewedBy: input.reviewedBy,
        status: "approved"
      });

      logger.info("promotion.approved", {
        promotion_request_id: request.promotionRequestId
      });
      metrics.increment("promotion.approved");

      return promoted;
    }
  };
}
