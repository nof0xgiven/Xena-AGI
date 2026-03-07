import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient } from "../../../src/persistence/db.js";
import {
  listAppliedMigrations,
  listRuntimeTables,
  resetRuntimeSchema,
  runMigrations
} from "../../../src/persistence/migrations.js";
import { createDurableStore } from "../../../src/persistence/repositories/durable-store.js";

describe.sequential("persistence migrations", () => {
  const sql = createDatabaseClient();

  beforeAll(async () => {
    await resetRuntimeSchema(sql);
  });

  afterAll(async () => {
    await resetRuntimeSchema(sql);
    await sql.end({ timeout: 1 });
  });

  it("bootstraps the durable schema from scratch and reruns safely", async () => {
    await runMigrations(sql);

    expect(await listRuntimeTables(sql)).toEqual(
      expect.arrayContaining([
        "agent_definitions",
        "artifacts",
        "dead_letters",
        "delegation_contracts",
        "events",
        "memory_records",
        "promotion_requests",
        "runs",
        "schema_migrations",
        "tasks"
      ])
    );

    await runMigrations(sql);

    expect(await listAppliedMigrations(sql)).toEqual(["0001_initial.sql"]);
  });

  it("enforces dedupe uniqueness and resolves lineage queries", async () => {
    await runMigrations(sql);

    const store = createDurableStore(sql);
    const now = new Date().toISOString();
    const rootTaskId = `task_${randomUUID()}`;
    const childTaskId = `task_${randomUUID()}`;
    const rootRunId = `run_${randomUUID()}`;
    const childRunId = `run_${randomUUID()}`;
    const sharedDedupeKey = `dedupe_${randomUUID()}`;

    await store.insertTask({
      taskId: rootTaskId,
      rootTaskId,
      parentTaskId: null,
      businessId: "business_alpha",
      projectId: "project_alpha",
      requestedAgentId: "agent_supervisor",
      title: "Root task",
      message: "Coordinate work",
      stateId: "created",
      priority: "normal",
      source: "integration_test",
      sourceRef: null,
      createdBy: "test",
      assignedAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    });
    await store.insertTask({
      taskId: childTaskId,
      rootTaskId,
      parentTaskId: rootTaskId,
      businessId: "business_alpha",
      projectId: "project_alpha",
      requestedAgentId: "agent_child",
      title: "Child task",
      message: "Execute work",
      stateId: "created",
      priority: "normal",
      source: "integration_test",
      sourceRef: null,
      createdBy: "test",
      assignedAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    });
    await store.insertRun({
      runId: rootRunId,
      taskId: rootTaskId,
      parentRunId: null,
      agentId: "agent_supervisor",
      triggerEventId: `evt_${randomUUID()}`,
      status: "queued",
      attempt: 1,
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "medium",
      startedAt: now,
      completedAt: null,
      durationMs: null,
      tokenUsage: null,
      costEstimate: null,
      retryMetadata: null,
      resultPayload: null
    });
    await store.insertRun({
      runId: childRunId,
      taskId: childTaskId,
      parentRunId: rootRunId,
      agentId: "agent_child",
      triggerEventId: `evt_${randomUUID()}`,
      status: "queued",
      attempt: 1,
      provider: "openai",
      model: "gpt-5-mini",
      reasoningEffort: "low",
      startedAt: now,
      completedAt: null,
      durationMs: null,
      tokenUsage: null,
      costEstimate: null,
      retryMetadata: null,
      resultPayload: null
    });

    await store.insertEvent({
      eventId: `evt_${randomUUID()}`,
      eventType: "task.created",
      taskId: rootTaskId,
      runId: null,
      agentId: "agent_supervisor",
      businessId: "business_alpha",
      projectId: "project_alpha",
      payload: { kind: "root" },
      emittedBy: "integration_test",
      correlationId: rootTaskId,
      causationId: null,
      dedupeKey: sharedDedupeKey,
      createdAt: now
    });

    await expect(
      store.insertEvent({
        eventId: `evt_${randomUUID()}`,
        eventType: "task.created",
        taskId: rootTaskId,
        runId: null,
        agentId: "agent_supervisor",
        businessId: "business_alpha",
        projectId: "project_alpha",
        payload: { kind: "duplicate" },
        emittedBy: "integration_test",
        correlationId: rootTaskId,
        causationId: null,
        dedupeKey: sharedDedupeKey,
        createdAt: now
      })
    ).rejects.toThrow(/dedupe/i);

    const lineage = await store.listTaskLineage(rootTaskId);

    expect(lineage.tasks.map((task) => task.taskId)).toEqual(
      expect.arrayContaining([rootTaskId, childTaskId])
    );
    expect(lineage.runs.map((run) => run.runId)).toEqual(
      expect.arrayContaining([rootRunId, childRunId])
    );
  });

  it("writes and reads dead letters", async () => {
    await runMigrations(sql);

    const store = createDurableStore(sql);
    const deadLetterId = `dead_${randomUUID()}`;

    await store.insertDeadLetter({
      deadLetterId,
      eventId: null,
      taskId: null,
      runId: null,
      classification: "invalid_payload",
      payload: { reason: "schema mismatch" },
      errorMessage: "payload rejected",
      createdAt: new Date().toISOString()
    });

    const deadLetter = await store.getDeadLetter(deadLetterId);

    expect(deadLetter).toMatchObject({
      deadLetterId,
      classification: "invalid_payload",
      errorMessage: "payload rejected"
    });
  });
});
