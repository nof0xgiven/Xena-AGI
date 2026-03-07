import { randomUUID } from "node:crypto";

import type { z } from "zod";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  MemoryQuerySchema,
  MemoryRecordSchema,
  SCHEMA_VERSION
} from "../../../src/contracts/index.js";
import { createMemoryService } from "../../../src/memory/service.js";
import { createDatabaseClient } from "../../../src/persistence/db.js";
import {
  resetRuntimeSchema,
  runMigrations
} from "../../../src/persistence/migrations.js";

type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

function createMemoryRecord(
  overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "scope" | "memory_class">
): MemoryRecord {
  const { memory_class, scope, ...rest } = overrides;

  return {
    schema_version: SCHEMA_VERSION,
    memory_id: `memory_${randomUUID()}`,
    memory_class,
    scope,
    business_id: "business_alpha",
    project_id: "project_alpha",
    agent_id: null,
    title: "Launch knowledge",
    summary: "Useful launch guidance",
    content: {
      note: "generic content"
    },
    keywords: ["launch"],
    source_type: "test",
    source_ref: `run_${randomUUID()}`,
    provenance: [
      {
        task_id: "task_root"
      }
    ],
    confidence: 0.9,
    version: 1,
    supersedes_memory_id: null,
    status: "active",
    created_at: "2026-03-07T10:00:00.000Z",
    updated_at: "2026-03-07T10:00:00.000Z",
    ...rest
  };
}

function createMemoryQuery(overrides: Partial<MemoryQuery> = {}): MemoryQuery {
  return {
    schema_version: SCHEMA_VERSION,
    query_id: `memqry_${randomUUID()}`,
    requester_agent_id: "agent_marketing_growth_hacker",
    task_id: "task_root",
    business_id: "business_alpha",
    project_id: "project_alpha",
    query_text: "launch tactic",
    scope_order: ["project", "business", "agent", "global_patterns"],
    allowed_classes: ["episodic", "semantic", "procedural"],
    max_results: 10,
    include_global_patterns: true,
    include_provenance: true,
    created_at: "2026-03-07T10:00:00.000Z",
    ...overrides
  };
}

describe.sequential("memory service", () => {
  const sql = createDatabaseClient();
  const service = createMemoryService(sql);

  beforeEach(async () => {
    await resetRuntimeSchema(sql);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await resetRuntimeSchema(sql);
    await sql.end({ timeout: 1 });
  });

  it("returns local scopes before agent and global patterns, with provenance when requested", async () => {
    const projectRecord = createMemoryRecord({
      scope: "project",
      memory_class: "semantic",
      title: "Project launch plan",
      summary: "Launch tactic for project alpha"
    });
    const businessRecord = createMemoryRecord({
      scope: "business",
      memory_class: "procedural",
      project_id: null,
      title: "Business launch checklist",
      summary: "Launch tactic for all business work"
    });
    const agentRecord = createMemoryRecord({
      scope: "agent",
      memory_class: "episodic",
      project_id: null,
      agent_id: "agent_marketing_growth_hacker",
      title: "Personal heuristic",
      summary: "My preferred launch tactic"
    });
    const globalRecord = createMemoryRecord({
      scope: "global_patterns",
      memory_class: "procedural",
      business_id: null,
      project_id: null,
      title: "Global launch pattern",
      summary: "Abstract launch tactic"
    });
    const foreignRecord = createMemoryRecord({
      scope: "project",
      memory_class: "semantic",
      business_id: "business_other",
      project_id: "project_other",
      title: "Foreign project record",
      summary: "Should never be returned"
    });

    await service.upsertMemoryRecord(projectRecord);
    await service.upsertMemoryRecord(businessRecord);
    await service.upsertMemoryRecord(agentRecord);
    await service.upsertMemoryRecord(globalRecord);
    await service.upsertMemoryRecord(foreignRecord);

    const results = await service.executeQuery(createMemoryQuery());

    expect(results.map((result) => result.memory_id)).toEqual([
      projectRecord.memory_id,
      businessRecord.memory_id,
      agentRecord.memory_id,
      globalRecord.memory_id
    ]);
    expect(results[0]?.provenance).toEqual(projectRecord.provenance);
  });

  it("supports semantic fallback from content, trims results, and omits provenance when not requested", async () => {
    const semanticOnlyRecord = createMemoryRecord({
      scope: "project",
      memory_class: "semantic",
      title: "Campaign notes",
      summary: "Rollout guidance",
      content: {
        themes: ["launch", "tactic", "sequencing"]
      },
      keywords: ["campaign"]
    });
    const businessRecord = createMemoryRecord({
      scope: "business",
      memory_class: "procedural",
      project_id: null,
      title: "Business launch playbook",
      summary: "Broader launch practice"
    });
    const globalRecord = createMemoryRecord({
      scope: "global_patterns",
      memory_class: "procedural",
      business_id: null,
      project_id: null,
      title: "Global tactic",
      summary: "Should be filtered when global patterns are disabled"
    });

    await service.upsertMemoryRecord(semanticOnlyRecord);
    await service.upsertMemoryRecord(businessRecord);
    await service.upsertMemoryRecord(globalRecord);

    const results = await service.executeQuery(
      createMemoryQuery({
        include_global_patterns: false,
        include_provenance: false,
        max_results: 2
      })
    );

    expect(results.map((result) => result.memory_id)).toEqual([
      semanticOnlyRecord.memory_id,
      businessRecord.memory_id
    ]);
    expect(results[0]?.provenance).toEqual([]);
  });
});
