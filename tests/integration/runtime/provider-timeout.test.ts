import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultAgentDefinitions } from "../../../src/agents/default-definitions.js";
import { SCHEMA_VERSION } from "../../../src/contracts/index.js";
import { createDatabaseClient } from "../../../src/persistence/db.js";
import {
  resetRuntimeSchema,
  runMigrations
} from "../../../src/persistence/migrations.js";
import { createDurableStore } from "../../../src/persistence/repositories/durable-store.js";
import {
  type AgentProvider,
  ProviderTimeoutError
} from "../../../src/providers/openai-provider.js";
import { executeRun } from "../../../src/runtime/run-executor.js";

function defaultAgent() {
  const agent = defaultAgentDefinitions[0];

  if (!agent) {
    throw new Error("Expected a default agent definition");
  }

  return agent;
}

function seedInvocationState(attempt: number) {
  const agent = defaultAgent();
  const taskId = `task_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;
  const now = new Date().toISOString();

  const task = {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    root_task_id: taskId,
    parent_task_id: null,
    business_id: "biz_runtime",
    project_id: "proj_runtime",
    requested_agent_id: agent.agent_id,
    title: "Execute campaign task",
    message: "Create the next campaign artifact",
    state_id: "in_progress",
    priority: "high",
    source: "integration_test",
    source_ref: null,
    created_by: "test",
    assigned_at: now,
    created_at: now,
    updated_at: now,
    completed_at: null
  } as const;

  const run = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    parent_run_id: null,
    agent_id: agent.agent_id,
    trigger_event_id: eventId,
    status: "running",
    attempt,
    provider: agent.provider,
    model: agent.model,
    reasoning_effort: agent.reasoning_effort,
    started_at: now,
    completed_at: null,
    duration_ms: null,
    token_usage: null,
    cost_estimate: null
  } as const;

  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    event_type: "task.run.requested",
    task_id: taskId,
    run_id: runId,
    agent_id: agent.agent_id,
    business_id: task.business_id,
    project_id: task.project_id,
    payload: {
      objective: "Create a campaign artifact"
    },
    emitted_by: "integration_test",
    correlation_id: taskId,
    causation_id: null,
    dedupe_key: `dedupe_${randomUUID()}`,
    created_at: now
  } as const;

  const invocation = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    agent,
    context_bundle: {
      schema_version: SCHEMA_VERSION,
      context_bundle_id: `ctx_${randomUUID()}`,
      task,
      run,
      business: {
        business_id: task.business_id
      },
      project: {
        project_id: task.project_id
      },
      related_memory: [],
      related_artifacts: [],
      related_people: [],
      constraints: ["single_shot"],
      objective: "Create a campaign artifact",
      memory_scope_order: ["project", "business", "agent", "global_patterns"],
      generated_at: now
    },
    tool_registry: agent.tools.map((toolName) => ({
      description: `${toolName} tool`,
      name: toolName
    })),
    constraints: {
      max_tool_calls: agent.max_tool_calls
    },
    prompt: {
      instructions: "Return a valid AgentResult JSON object."
    }
  } as const;

  return { event, invocation, run, task };
}

describe.sequential("provider timeout handling", () => {
  const sql = createDatabaseClient();
  const store = createDurableStore(sql);
  const provider: AgentProvider = {
    name: "timeout",
    execute() {
      return Promise.reject(new ProviderTimeoutError("provider timed out"));
    }
  };

  beforeAll(async () => {
    await resetRuntimeSchema(sql);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await resetRuntimeSchema(sql);
    await sql.end({ timeout: 1 });
  });

  it("marks the run retrying when timeout happens before retry exhaustion", async () => {
    const { event, invocation, run, task } = seedInvocationState(1);

    await store.insertTask({
      assignedAt: task.assigned_at,
      businessId: task.business_id,
      completedAt: task.completed_at,
      createdAt: task.created_at,
      createdBy: task.created_by,
      message: task.message,
      parentTaskId: task.parent_task_id,
      priority: task.priority,
      projectId: task.project_id,
      requestedAgentId: task.requested_agent_id,
      rootTaskId: task.root_task_id,
      source: task.source,
      sourceRef: task.source_ref,
      stateId: task.state_id,
      taskId: task.task_id,
      title: task.title,
      updatedAt: task.updated_at
    });
    await store.insertRun({
      agentId: run.agent_id,
      attempt: run.attempt,
      completedAt: run.completed_at,
      costEstimate: run.cost_estimate,
      durationMs: run.duration_ms,
      model: run.model,
      parentRunId: run.parent_run_id,
      provider: run.provider,
      reasoningEffort: run.reasoning_effort,
      resultPayload: null,
      retryMetadata: null,
      runId: run.run_id,
      startedAt: run.started_at,
      status: run.status,
      taskId: run.task_id,
      tokenUsage: null,
      triggerEventId: run.trigger_event_id
    });
    await store.insertEvent({
      agentId: event.agent_id,
      businessId: event.business_id,
      causationId: event.causation_id,
      correlationId: event.correlation_id,
      createdAt: event.created_at,
      dedupeKey: event.dedupe_key,
      emittedBy: event.emitted_by,
      eventId: event.event_id,
      eventType: event.event_type,
      payload: event.payload,
      projectId: event.project_id,
      runId: event.run_id,
      taskId: event.task_id
    });

    const outcome = await executeRun({
      invocation,
      maxAttempts: 3,
      provider,
      store
    });

    expect(outcome.runStatus).toBe("retrying");

    const persistedRun = await store.getRun(invocation.run_id);

    expect(persistedRun).toMatchObject({
      status: "retrying"
    });
    expect(persistedRun?.retryMetadata).toMatchObject({
      classification: "provider_timeout",
      retryable: true
    });
  });

  it("marks the run timed_out and writes a dead letter when retries are exhausted", async () => {
    const { event, invocation, run, task } = seedInvocationState(3);

    await store.insertTask({
      assignedAt: task.assigned_at,
      businessId: task.business_id,
      completedAt: task.completed_at,
      createdAt: task.created_at,
      createdBy: task.created_by,
      message: task.message,
      parentTaskId: task.parent_task_id,
      priority: task.priority,
      projectId: task.project_id,
      requestedAgentId: task.requested_agent_id,
      rootTaskId: task.root_task_id,
      source: task.source,
      sourceRef: task.source_ref,
      stateId: task.state_id,
      taskId: task.task_id,
      title: task.title,
      updatedAt: task.updated_at
    });
    await store.insertRun({
      agentId: run.agent_id,
      attempt: run.attempt,
      completedAt: run.completed_at,
      costEstimate: run.cost_estimate,
      durationMs: run.duration_ms,
      model: run.model,
      parentRunId: run.parent_run_id,
      provider: run.provider,
      reasoningEffort: run.reasoning_effort,
      resultPayload: null,
      retryMetadata: null,
      runId: run.run_id,
      startedAt: run.started_at,
      status: run.status,
      taskId: run.task_id,
      tokenUsage: null,
      triggerEventId: run.trigger_event_id
    });
    await store.insertEvent({
      agentId: event.agent_id,
      businessId: event.business_id,
      causationId: event.causation_id,
      correlationId: event.correlation_id,
      createdAt: event.created_at,
      dedupeKey: event.dedupe_key,
      emittedBy: event.emitted_by,
      eventId: event.event_id,
      eventType: event.event_type,
      payload: event.payload,
      projectId: event.project_id,
      runId: event.run_id,
      taskId: event.task_id
    });

    const outcome = await executeRun({
      invocation,
      maxAttempts: 3,
      provider,
      store
    });

    expect(outcome.runStatus).toBe("timed_out");
    expect(outcome.deadLetterId).toBeDefined();

    const persistedRun = await store.getRun(invocation.run_id);
    const deadLetter = outcome.deadLetterId
      ? await store.getDeadLetter(outcome.deadLetterId)
      : null;

    expect(persistedRun).toMatchObject({
      status: "timed_out"
    });
    expect(deadLetter).toMatchObject({
      classification: "provider_timeout_exhausted"
    });
  });
});
