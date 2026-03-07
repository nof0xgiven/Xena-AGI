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

function findAgent(agentId: string) {
  const agent = defaultAgentDefinitions.find(
    (definition) => definition.agent_id === agentId
  );

  if (!agent) {
    throw new Error(`Expected agent definition for ${agentId}`);
  }

  return agent;
}

function seedParentState(input: {
  agentId: string;
  businessId: string;
  message: string;
  projectId: string;
  spawn: {
    message: string;
    priority: string;
    required: boolean;
    tags: string[];
    target_agent_id: string;
    title: string;
  }[];
  title: string;
}) {
  const agent = findAgent(input.agentId);
  const now = new Date().toISOString();
  const taskId = `task_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;

  return {
    event: {
      agentId: agent.agent_id,
      businessId: input.businessId,
      causationId: null,
      correlationId: taskId,
      createdAt: now,
      dedupeKey: `dedupe_${randomUUID()}`,
      emittedBy: "scenario_test",
      eventId,
      eventType: "task.run.requested",
      payload: {
        objective: input.message
      },
      projectId: input.projectId,
      runId,
      taskId
    },
    result: {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      task_id: taskId,
      agent_id: agent.agent_id,
      summary: `Delegating ${input.title}`,
      state_id: "awaiting_subtasks",
      outcome: "delegated",
      result: null,
      artifacts: [],
      spawn: input.spawn.map((spawn) => ({
        ...spawn,
        context_overrides: null,
        expected_output: null,
        tool_name: "spawn_task"
      })),
      reentry_mode: "barrier",
      reentry_objective: `Synthesize ${input.title}`,
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
      businessId: input.businessId,
      completedAt: null,
      createdAt: now,
      createdBy: "scenario_test",
      message: input.message,
      parentTaskId: null,
      priority: "high",
      projectId: input.projectId,
      requestedAgentId: agent.agent_id,
      rootTaskId: taskId,
      source: "scenario_test",
      sourceRef: null,
      stateId: "in_progress",
      taskId,
      title: input.title,
      updatedAt: now
    }
  };
}

describe.sequential("concurrent domain supervisors", () => {
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

  it("allows marketing and operations supervisors to delegate concurrently without cross-talk", async () => {
    const marketing = seedParentState({
      agentId: "agent_marketing_growth_hacker",
      businessId: "biz_marketing",
      message: "Coordinate launch campaign execution",
      projectId: "proj_marketing",
      spawn: [
        {
          message: "Create launch copy",
          priority: "high",
          required: true,
          tags: ["copy"],
          target_agent_id: "agent_marketing_content_creator",
          title: "Write launch copy"
        },
        {
          message: "Create launch social plan",
          priority: "high",
          required: true,
          tags: ["social"],
          target_agent_id: "agent_marketing_social_media_strategist",
          title: "Plan social rollout"
        }
      ],
      title: "Marketing launch"
    });
    const operations = seedParentState({
      agentId: "agent_operations_cmo",
      businessId: "biz_operations",
      message: "Coordinate operational rollout",
      projectId: "proj_operations",
      spawn: [
        {
          message: "Analyze rollout process",
          priority: "high",
          required: true,
          tags: ["process"],
          target_agent_id: "agent_operations_process_analyst",
          title: "Analyze rollout process"
        },
        {
          message: "Draft execution runbook",
          priority: "high",
          required: true,
          tags: ["runbook"],
          target_agent_id: "agent_operations_runbook_writer",
          title: "Draft runbook"
        }
      ],
      title: "Operations rollout"
    });

    for (const seed of [marketing, operations]) {
      await store.insertTask(seed.task);
      await store.insertRun(seed.run);
      await store.insertEvent(seed.event);
    }

    const [marketingDelegation, operationsDelegation] = await Promise.all([
      coordinator.delegateFromResult({
        parentRun: marketing.run,
        parentTask: marketing.task,
        result: marketing.result
      }),
      coordinator.delegateFromResult({
        parentRun: operations.run,
        parentTask: operations.task,
        result: operations.result
      })
    ]);

    expect(marketingDelegation.childTasks).toHaveLength(2);
    expect(operationsDelegation.childTasks).toHaveLength(2);

    await Promise.all(
      [...marketingDelegation.childTasks, ...operationsDelegation.childTasks].map(
        async (childTask) => {
          await store.updateTaskState({
            completedAt: new Date().toISOString(),
            stateId: "completed",
            taskId: childTask.taskId,
            updatedAt: new Date().toISOString()
          });
        }
      )
    );

    const outcomes = await Promise.all([
      ...marketingDelegation.childTasks.map((childTask) =>
        coordinator.recordChildCompletion(childTask.taskId)
      ),
      ...operationsDelegation.childTasks.map((childTask) =>
        coordinator.recordChildCompletion(childTask.taskId)
      )
    ]);
    const reentryEvents = await store.listEvents({
      eventType: "task.reentry_requested"
    });
    const marketingContract = await store.getDelegationContract(
      marketingDelegation.delegationId
    );
    const operationsContract = await store.getDelegationContract(
      operationsDelegation.delegationId
    );

    expect(
      outcomes.filter((outcome) => outcome.reentryEvent !== null)
    ).toHaveLength(2);
    expect(reentryEvents).toHaveLength(2);
    expect(reentryEvents.map((event) => event.taskId).sort()).toEqual(
      [marketing.task.taskId, operations.task.taskId].sort()
    );
    expect(marketingContract).toMatchObject({
      status: "satisfied"
    });
    expect(operationsContract).toMatchObject({
      status: "satisfied"
    });
  });
});
