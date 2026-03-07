import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultAgentDefinitions } from "../../src/agents/default-definitions.js";
import { SCHEMA_VERSION } from "../../src/contracts/index.js";
import { createDelegationCoordinator } from "../../src/orchestration/delegation.js";
import { createDatabaseClient } from "../../src/persistence/db.js";
import {
  resetRuntimeSchema,
  runMigrations
} from "../../src/persistence/migrations.js";
import { createDurableStore } from "../../src/persistence/repositories/durable-store.js";

function defaultAgent() {
  const agent = defaultAgentDefinitions.find(
    (definition) => definition.agent_id === "agent_marketing_growth_hacker"
  );

  if (!agent) {
    throw new Error("Expected a default supervisor agent definition");
  }

  return agent;
}

function leafAgent() {
  const agent = defaultAgentDefinitions.find(
    (definition) => definition.agent_id === "agent_marketing_content_creator"
  );

  if (!agent) {
    throw new Error("Expected a default leaf agent definition");
  }

  return agent;
}

function seedParentState() {
  const agent = defaultAgent();
  const now = new Date().toISOString();
  const taskId = `task_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;

  return {
    event: {
      agentId: agent.agent_id,
      businessId: "biz_orchestration",
      causationId: null,
      correlationId: taskId,
      createdAt: now,
      dedupeKey: `dedupe_${randomUUID()}`,
      emittedBy: "scenario_test",
      eventId,
      eventType: "task.run.requested",
      payload: {
        objective: "Coordinate launch"
      },
      projectId: "proj_orchestration",
      runId,
      taskId
    },
    result: {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      task_id: taskId,
      agent_id: agent.agent_id,
      summary: "Delegating to specialists",
      state_id: "awaiting_subtasks",
      outcome: "delegated",
      result: null,
      artifacts: [],
      spawn: [
          {
            tool_name: "spawn_task",
            target_agent_id: "agent_marketing_content_creator",
            title: "Write launch copy",
            message: "Create launch copy",
            required: true,
          priority: "high",
          context_overrides: null,
          expected_output: null,
          tags: ["copy"]
        },
          {
            tool_name: "spawn_task",
            target_agent_id: "agent_marketing_social_media_strategist",
            title: "Design launch graphic",
            message: "Create launch creative",
            required: true,
          priority: "high",
          context_overrides: null,
          expected_output: null,
          tags: ["design"]
        },
          {
            tool_name: "spawn_task",
            target_agent_id: "agent_marketing_benchmark_analyst",
            title: "Gather benchmark references",
            message: "Collect competitor examples",
            required: false,
          priority: "medium",
          context_overrides: null,
          expected_output: null,
          tags: ["research"]
        }
      ],
      reentry_mode: "barrier",
      reentry_objective: "Synthesize child outputs",
      errors: [],
      memory_writes: [],
      completed_at: now
    },
    run: {
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
      runId,
      startedAt: now,
      status: "running",
      taskId,
      tokenUsage: null,
      triggerEventId: eventId
    },
    task: {
      assignedAt: now,
      businessId: "biz_orchestration",
      completedAt: null,
      createdAt: now,
      createdBy: "scenario_test",
      message: "Coordinate launch",
      parentTaskId: null,
      priority: "high",
      projectId: "proj_orchestration",
      requestedAgentId: agent.agent_id,
      rootTaskId: taskId,
      source: "scenario_test",
      sourceRef: null,
      stateId: "in_progress",
      taskId,
      title: "Launch coordination",
      updatedAt: now
    }
  };
}

describe.sequential("delegation and barrier re-entry", () => {
  const sql = createDatabaseClient();
  const store = createDurableStore(sql);
  const coordinator = createDelegationCoordinator({
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

  it("fans out three children, ignores optional completion, and re-enters after required children complete", async () => {
    const seed = seedParentState();

    await store.insertTask(seed.task);
    await store.insertRun(seed.run);
    await store.insertEvent(seed.event);

    const delegation = await coordinator.delegateFromResult({
      parentRun: seed.run,
      parentTask: seed.task,
      result: seed.result
    });

    const parentTask = await store.getTask(seed.task.taskId);
    const contract = await store.getDelegationContract(delegation.delegationId);
    const childCreatedEvents = await store.listEvents({
      eventType: "task.created"
    });

    expect(parentTask).toMatchObject({
      stateId: "awaiting_subtasks"
    });
    expect(contract).toMatchObject({
      status: "pending"
    });
    expect(delegation.childTasks).toHaveLength(3);
    expect(childCreatedEvents).toHaveLength(3);

    const optionalChild = delegation.childTasks.find((child) => !child.required);
    const requiredChildren = delegation.childTasks.filter((child) => child.required);

    if (!optionalChild) {
      throw new Error("Expected an optional child task");
    }

    await store.updateTaskState({
      completedAt: new Date().toISOString(),
      stateId: "completed",
      taskId: optionalChild.taskId,
      updatedAt: new Date().toISOString()
    });

    const optionalOutcome = await coordinator.recordChildCompletion(optionalChild.taskId);

    expect(optionalOutcome.reentryEvent).toBeNull();

    const firstRequiredChild = requiredChildren[0];
    const secondRequiredChild = requiredChildren[1];

    if (!firstRequiredChild || !secondRequiredChild) {
      throw new Error("Expected two required child tasks");
    }

    await store.updateTaskState({
      completedAt: new Date().toISOString(),
      stateId: "completed",
      taskId: firstRequiredChild.taskId,
      updatedAt: new Date().toISOString()
    });

    const firstCompletionOutcome = await coordinator.recordChildCompletion(
      firstRequiredChild.taskId
    );

    expect(firstCompletionOutcome.reentryEvent).toBeNull();

    await store.updateTaskState({
      completedAt: new Date().toISOString(),
      stateId: "completed",
      taskId: secondRequiredChild.taskId,
      updatedAt: new Date().toISOString()
    });

    const completionOutcome = await coordinator.recordChildCompletion(
      secondRequiredChild.taskId
    );
    const updatedContract = await store.getDelegationContract(
      delegation.delegationId
    );
    const reentryEvents = await store.listEvents({
      eventType: "task.reentry_requested",
      taskId: seed.task.taskId
    });

    expect(completionOutcome.reentryEvent).not.toBeNull();
    expect(updatedContract).toMatchObject({
      status: "satisfied"
    });
    expect(reentryEvents).toHaveLength(1);
  });

  it("moves the parent into awaiting_review when a required child fails", async () => {
    const seed = seedParentState();

    await store.insertTask(seed.task);
    await store.insertRun(seed.run);
    await store.insertEvent(seed.event);

    const delegation = await coordinator.delegateFromResult({
      parentRun: seed.run,
      parentTask: seed.task,
      result: seed.result
    });
    const requiredChild = delegation.childTasks.find((child) => child.required);

    if (!requiredChild) {
      throw new Error("Expected a required child task");
    }

    await store.updateTaskState({
      completedAt: new Date().toISOString(),
      stateId: "failed",
      taskId: requiredChild.taskId,
      updatedAt: new Date().toISOString()
    });

    const outcome = await coordinator.recordChildCompletion(requiredChild.taskId);
    const parentTask = await store.getTask(seed.task.taskId);
    const contract = await store.getDelegationContract(delegation.delegationId);

    expect(outcome.reentryEvent).toBeNull();
    expect(parentTask).toMatchObject({
      stateId: "awaiting_review"
    });
    expect(contract).toMatchObject({
      status: "failed"
    });
  });

  it("rejects delegation from leaf agents", async () => {
    const agent = leafAgent();
    const now = new Date().toISOString();
    const taskId = `task_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;

    const parentTask = {
      assignedAt: now,
      businessId: "biz_orchestration",
      completedAt: null,
      createdAt: now,
      createdBy: "scenario_test",
      message: "Attempt invalid delegation",
      parentTaskId: null,
      priority: "high",
      projectId: "proj_orchestration",
      requestedAgentId: agent.agent_id,
      rootTaskId: taskId,
      source: "scenario_test",
      sourceRef: null,
      stateId: "in_progress",
      taskId,
      title: "Invalid delegation",
      updatedAt: now
    } as const;
    const parentRun = {
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
      runId,
      startedAt: now,
      status: "running",
      taskId,
      tokenUsage: null,
      triggerEventId: eventId
    } as const;

    await store.insertTask(parentTask);
    await store.insertRun(parentRun);

    await expect(
      coordinator.delegateFromResult({
        parentRun,
        parentTask,
        result: {
          schema_version: SCHEMA_VERSION,
          run_id: runId,
          task_id: taskId,
          agent_id: agent.agent_id,
          summary: "Incorrectly delegating",
          state_id: "awaiting_subtasks",
          outcome: "delegated",
          result: null,
          artifacts: [],
          spawn: [
            {
              tool_name: "spawn_task",
              target_agent_id: "agent_marketing_social_media_strategist",
              title: "Delegate illegally",
              message: "Should be rejected",
              required: true,
              priority: "high",
              context_overrides: null,
              expected_output: null,
              tags: []
            }
          ],
          reentry_mode: "barrier",
          reentry_objective: "Should never happen",
          errors: [],
          memory_writes: [],
          completed_at: now
        }
      })
    ).rejects.toThrow(/not allowed to delegate/i);
  });

  it("rejects delegation to children outside allowed_delegate_to", async () => {
    const seed = seedParentState();

    await store.insertTask(seed.task);
    await store.insertRun(seed.run);
    await store.insertEvent(seed.event);

    await expect(
      coordinator.delegateFromResult({
        parentRun: seed.run,
        parentTask: seed.task,
        result: {
          ...seed.result,
          spawn: [
            {
              ...seed.result.spawn[0],
              target_agent_id: "agent_operations_process_analyst"
            }
          ]
        }
      })
    ).rejects.toThrow(/cannot delegate to/i);
  });
});
