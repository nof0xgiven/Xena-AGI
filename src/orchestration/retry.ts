import { randomUUID } from "node:crypto";

import type { DurableStore, EventRecord } from "../persistence/repositories/durable-store.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { createMetrics, type Metrics } from "../observability/metrics.js";

type RetryDependencies = {
  logger?: Logger;
  metrics?: Metrics;
  now?: () => string;
  store: DurableStore;
};

export function createRetryCoordinator(dependencies: RetryDependencies) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const logger = dependencies.logger ?? createLogger(now);
  const metrics = dependencies.metrics ?? createMetrics();

  return {
    async handleRetryOutcome(input: {
      classification: string;
      eventId: string;
      maxAttempts: number;
      retryable: boolean;
      runId: string;
      taskId: string;
    }): Promise<{ deadLetterId?: string; retryEvent?: EventRecord }> {
      const run = await dependencies.store.getRun(input.runId);

      if (!run) {
        throw new Error(`Run ${input.runId} not found`);
      }

      const timestamp = now();

      if (input.retryable && run.attempt < input.maxAttempts) {
        await dependencies.store.updateRunLifecycle({
          completedAt: null,
          costEstimate: run.costEstimate,
          durationMs: run.durationMs,
          resultPayload: run.resultPayload,
          retryMetadata: {
            classification: input.classification,
            next_attempt: run.attempt + 1,
            retryable: true
          },
          runId: input.runId,
          status: "retrying",
          tokenUsage: run.tokenUsage
        });

        const retryEvent: EventRecord = {
          agentId: run.agentId,
          businessId: null,
          causationId: input.eventId,
          correlationId: input.taskId,
          createdAt: timestamp,
          dedupeKey: null,
          emittedBy: "xena.retry",
          eventId: `evt_${randomUUID()}`,
          eventType: "run.retry_scheduled",
          payload: {
            classification: input.classification,
            next_attempt: run.attempt + 1
          },
          projectId: null,
          runId: input.runId,
          taskId: input.taskId
        };

        await dependencies.store.insertEvent(retryEvent);

        logger.info("retry.scheduled", {
          next_attempt: run.attempt + 1,
          run_id: input.runId
        });
        metrics.increment("retry.scheduled");

        return { retryEvent };
      }

      const deadLetterId = `dead_${randomUUID()}`;

      await dependencies.store.updateTaskState({
        completedAt: timestamp,
        stateId: "failed",
        taskId: input.taskId,
        updatedAt: timestamp
      });
      await dependencies.store.insertDeadLetter({
        classification: "retry_exhausted",
        createdAt: timestamp,
        deadLetterId,
        errorMessage: `Retry limit reached for ${input.classification}`,
        eventId: input.eventId,
        payload: {
          classification: input.classification,
          run_id: input.runId
        },
        runId: input.runId,
        taskId: input.taskId
      });

      logger.error("retry.exhausted", {
        classification: input.classification,
        run_id: input.runId
      });
      metrics.increment("retry.exhausted");

      return { deadLetterId };
    }
  };
}
