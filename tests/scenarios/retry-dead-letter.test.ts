import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultAgentDefinitions } from "../../src/agents/default-definitions.js";
import { SCHEMA_VERSION } from "../../src/contracts/index.js";
import { createDelegationCoordinator } from "../../src/orchestration/delegation.js";
import { createRetryCoordinator } from "../../src/orchestration/retry.js";
import { createDatabaseClient } from "../../src/persistence/db.js";
import {
  resetRuntimeSchema,
  runMigrations
} from "../../src/persistence/migrations.js";
import { createDurableStore } from "../../src/persistence/repositories/durable-store.js";
import { createReconciliationJobs } from "../../src/reconciliation/jobs.js";

function defaultAgent() {
  const agent = defaultAgentDefinitions[1];

  if (!agent) {
    throw new Error("Expected a default supervisor agent definition");
  }

  return agent;
}

function seedRetryState(attempt: number) {
  const agent = defaultAgent();
  const now = new Date().toISOString();
  const taskId = `task_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;

  return {
    event: {
      agentId: agent.agent_id,
      businessId: "biz_retry",
      causationId: null,
      correlationId: taskId,
      createdAt: now,
      dedupeKey: `dedupe_${randomUUID()}`,
      emittedBy: "scenario_test",
      eventId,
      eventType: "task.run.requested",
      payload: {
        objective: "Retry run"
      },
      projectId: "proj_retry",
      runId,
      taskId
    },
    run: {
      agentId: agent.agent_id,
      attempt,
      completedAt: null,
      costEstimate: null,
      durationMs: null,
      model: agent.model,
      parentRunId: null,
      provider: agent.provider,
      reasoningEffort: agent.reasoning_effort,
      resultPayload: null,
      retryMetadata: null,
      runId,
      startedAt: now,
      status: "timed_out",
      taskId,
      tokenUsage: null,
      triggerEventId: eventId
    },
    task: {
      assignedAt: now,
      businessId: "biz_retry",
      completedAt: null,
      createdAt: now,
      createdBy: "scenario_test",
      message: "Handle retry flow",
      parentTaskId: null,
      priority: "high",
      projectId: "proj_retry",
      requestedAgentId: agent.agent_id,
      rootTaskId: taskId,
      source: "scenario_test",
      sourceRef: null,
      stateId: "in_progress",
      taskId,
      title: "Retry coordination",
      updatedAt: now
    }
  };
}

describe.sequential("retry and reconciliation", () => {
  const sql = createDatabaseClient();
  const store = createDurableStore(sql);
  const retryCoordinator = createRetryCoordinator({
    store
  });
  const reconciliationJobs = createReconciliationJobs({
    store
  });
  const delegationCoordinator = createDelegationCoordinator({
    store
  });

  beforeAll(async () => {
    await resetRuntimeSchema(sql);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await resetRuntimeSchema(sql);
    await sql.end({ timeout: 1 });
  });

  it("writes a dead letter and fails the task when retries are exhausted", async () => {
    const seed = seedRetryState(3);

    await store.insertTask(seed.task);
    await store.insertRun(seed.run);
    await store.insertEvent(seed.event);

    const outcome = await retryCoordinator.handleRetryOutcome({
      classification: "provider_timeout",
      eventId: seed.event.eventId,
      maxAttempts: 3,
      retryable: true,
      runId: seed.run.runId,
      taskId: seed.task.taskId
    });

    const task = await store.getTask(seed.task.taskId);
    const deadLetter = outcome.deadLetterId
      ? await store.getDeadLetter(outcome.deadLetterId)
      : null;
    const retryEvents = await store.listEvents({
      eventType: "run.retry_scheduled",
      taskId: seed.task.taskId
    });

    expect(task).toMatchObject({
      stateId: "failed"
    });
    expect(deadLetter).toMatchObject({
      classification: "retry_exhausted"
    });
    expect(retryEvents).toHaveLength(0);
  });

  it("reconciles stale awaiting_subtasks parents and emits reentry events", async () => {
    const agent = defaultAgent();
    const now = new Date().toISOString();
    const parentTaskId = `task_${randomUUID()}`;
    const parentRunId = `run_${randomUUID()}`;
    const parentEventId = `evt_${randomUUID()}`;

    await store.insertTask({
      assignedAt: now,
      businessId: "biz_reconcile",
      completedAt: null,
      createdAt: now,
      createdBy: "scenario_test",
      message: "Coordinate specialist work",
      parentTaskId: null,
      priority: "high",
      projectId: "proj_reconcile",
      requestedAgentId: agent.agent_id,
      rootTaskId: parentTaskId,
      source: "scenario_test",
      sourceRef: null,
      stateId: "in_progress",
      taskId: parentTaskId,
      title: "Reconcile subtasks",
      updatedAt: now
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
      runId: parentRunId,
      startedAt: now,
      status: "running",
      taskId: parentTaskId,
      tokenUsage: null,
      triggerEventId: parentEventId
    });
    await store.insertEvent({
      agentId: agent.agent_id,
      businessId: "biz_reconcile",
      causationId: null,
      correlationId: parentTaskId,
      createdAt: now,
      dedupeKey: `dedupe_${randomUUID()}`,
      emittedBy: "scenario_test",
      eventId: parentEventId,
      eventType: "task.run.requested",
      payload: {
        objective: "Coordinate specialist work"
      },
      projectId: "proj_reconcile",
      runId: parentRunId,
      taskId: parentTaskId
    });

    const delegation = await delegationCoordinator.delegateFromResult({
      parentRun: {
        ...seedRetryState(1).run,
        runId: parentRunId,
        taskId: parentTaskId,
        triggerEventId: parentEventId
      },
      parentTask: {
        ...seedRetryState(1).task,
        taskId: parentTaskId,
        rootTaskId: parentTaskId
      },
      result: {
        schema_version: SCHEMA_VERSION,
        run_id: parentRunId,
        task_id: parentTaskId,
        agent_id: agent.agent_id,
        summary: "Delegate to two required specialists",
        state_id: "awaiting_subtasks",
        outcome: "delegated",
        result: null,
        artifacts: [],
        spawn: [
          {
            tool_name: "spawn_task",
            target_agent_id: "agent_writer",
            title: "Write copy",
            message: "Create copy",
            required: true,
            priority: "high",
            context_overrides: null,
            expected_output: null,
            tags: []
          },
          {
            tool_name: "spawn_task",
            target_agent_id: "agent_designer",
            title: "Design creative",
            message: "Create image",
            required: true,
            priority: "high",
            context_overrides: null,
            expected_output: null,
            tags: []
          }
        ],
        reentry_mode: "barrier",
        reentry_objective: "Synthesize results",
        errors: [],
        memory_writes: [],
        completed_at: now
      }
    });

    for (const child of delegation.childTasks) {
      await store.updateTaskState({
        completedAt: new Date().toISOString(),
        stateId: "completed",
        taskId: child.taskId,
        updatedAt: new Date().toISOString()
      });
    }

    const reconciliation = await reconciliationJobs.reconcileAwaitingSubtasks();
    const reentryEvents = await store.listEvents({
      eventType: "task.reentry_requested",
      taskId: parentTaskId
    });

    expect(reconciliation.reenteredTaskIds).toContain(parentTaskId);
    expect(reentryEvents).toHaveLength(1);
  });
});
