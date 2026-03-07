import { randomUUID } from "node:crypto";

import { AgentResultSchema } from "../contracts/index.js";
import type {
  DelegationContractRecord,
  DurableStore,
  EventRecord,
  RunRecord,
  TaskRecord
} from "../persistence/repositories/durable-store.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { createMetrics, type Metrics } from "../observability/metrics.js";
import { evaluateRequiredChildren } from "./delegation-state.js";

type DelegationDependencies = {
  logger?: Logger;
  metrics?: Metrics;
  now?: () => string;
  store: DurableStore;
};

function eventId(): string {
  return `evt_${randomUUID()}`;
}

function taskId(): string {
  return `task_${randomUUID()}`;
}

function delegationId(): string {
  return `delegation_${randomUUID()}`;
}

async function loadChildStates(
  store: DurableStore,
  contract: DelegationContractRecord
): Promise<TaskRecord[]> {
  const tasks = await Promise.all(
    contract.childTaskIds.map(async (childTaskId) => store.getTask(childTaskId))
  );

  return tasks.filter((task): task is TaskRecord => task !== null);
}

export function createDelegationCoordinator(dependencies: DelegationDependencies) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const logger = dependencies.logger ?? createLogger(now);
  const metrics = dependencies.metrics ?? createMetrics();

  return {
    async delegateFromResult(input: {
      parentRun: RunRecord;
      parentTask: TaskRecord;
      result: unknown;
    }): Promise<{
      childTasks: { required: boolean; taskId: string }[];
      delegationId: string;
    }> {
      const result = AgentResultSchema.parse(input.result);

      if (result.outcome !== "delegated" || result.spawn.length === 0) {
        throw new Error("delegateFromResult requires a delegated AgentResult");
      }

      const timestamp = now();
      const childTasks: { required: boolean; taskId: string }[] = [];

      for (const spawn of result.spawn) {
        const childTaskId = taskId();

        await dependencies.store.insertTask({
          assignedAt: null,
          businessId: input.parentTask.businessId,
          completedAt: null,
          createdAt: timestamp,
          createdBy: input.parentTask.createdBy,
          message: spawn.message,
          parentTaskId: input.parentTask.taskId,
          priority: spawn.priority,
          projectId: input.parentTask.projectId,
          requestedAgentId: spawn.target_agent_id,
          rootTaskId: input.parentTask.rootTaskId,
          source: "delegation",
          sourceRef: input.parentRun.runId,
          stateId: "created",
          taskId: childTaskId,
          title: spawn.title,
          updatedAt: timestamp
        });

        await dependencies.store.insertEvent({
          agentId: spawn.target_agent_id,
          businessId: input.parentTask.businessId,
          causationId: input.parentRun.runId,
          correlationId: input.parentTask.taskId,
          createdAt: timestamp,
          dedupeKey: null,
          emittedBy: "xena.orchestration",
          eventId: eventId(),
          eventType: "task.created",
          payload: {
            parent_task_id: input.parentTask.taskId,
            required: spawn.required
          },
          projectId: input.parentTask.projectId,
          runId: null,
          taskId: childTaskId
        });

        childTasks.push({
          required: spawn.required,
          taskId: childTaskId
        });
      }

      const delegationContract: DelegationContractRecord = {
        childTaskIds: childTasks.map((child) => child.taskId),
        createdAt: timestamp,
        delegationId: delegationId(),
        expiresAt: null,
        mode: result.reentry_mode ?? "barrier",
        optionalChildren: childTasks
          .filter((child) => !child.required)
          .map((child) => ({ task_id: child.taskId })),
        parentRunId: input.parentRun.runId,
        parentTaskId: input.parentTask.taskId,
        reentryAgentId: result.agent_id,
        reentryObjective:
          result.reentry_objective ?? "Resume after child task completion",
        requiredChildren: childTasks
          .filter((child) => child.required)
          .map((child) => ({ task_id: child.taskId })),
        status: "pending",
        updatedAt: timestamp
      };

      await dependencies.store.insertDelegationContract(delegationContract);
      await dependencies.store.updateTaskState({
        completedAt: null,
        stateId: "awaiting_subtasks",
        taskId: input.parentTask.taskId,
        updatedAt: timestamp
      });

      logger.info("delegation.created", {
        child_task_count: childTasks.length,
        parent_run_id: input.parentRun.runId,
        parent_task_id: input.parentTask.taskId
      });
      metrics.increment("delegation.created", 1, {
        mode: delegationContract.mode
      });

      return {
        childTasks,
        delegationId: delegationContract.delegationId
      };
    },

    async recordChildCompletion(
      childTaskId: string
    ): Promise<{ reentryEvent: EventRecord | null }> {
      const contract =
        await dependencies.store.findPendingDelegationByChildTaskId(childTaskId);

      if (!contract) {
        return { reentryEvent: null };
      }

      const timestamp = now();
      const childStates = await loadChildStates(dependencies.store, contract);
      const taskStateById = new Map(
        childStates.map((childTask) => [childTask.taskId, childTask.stateId])
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

        logger.warn("delegation.failed", {
          delegation_id: contract.delegationId,
          parent_task_id: contract.parentTaskId
        });
        metrics.increment("delegation.failed");

        return { reentryEvent: null };
      }

      if (!requiredSatisfied) {
        return { reentryEvent: null };
      }

      await dependencies.store.updateDelegationStatus({
        delegationId: contract.delegationId,
        status: "satisfied",
        updatedAt: timestamp
      });

      const reentryEvent: EventRecord = {
        agentId: contract.reentryAgentId,
        businessId: null,
        causationId: contract.delegationId,
        correlationId: contract.parentTaskId,
        createdAt: timestamp,
        dedupeKey: null,
        emittedBy: "xena.orchestration",
        eventId: eventId(),
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

      logger.info("delegation.satisfied", {
        delegation_id: contract.delegationId,
        parent_task_id: contract.parentTaskId
      });
      metrics.increment("delegation.satisfied");

      return { reentryEvent };
    }
  };
}
