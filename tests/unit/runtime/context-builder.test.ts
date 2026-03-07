import type { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  ArtifactSchema,
  MemoryRecordSchema,
  RunSchema,
  SCHEMA_VERSION,
  TaskSchema
} from "../../../src/contracts/index.js";
import {
  createContextBuilder,
  createContextBundleId,
  type ContextBuilderInput
} from "../../../src/runtime/context-builder.js";

type Artifact = z.infer<typeof ArtifactSchema>;
type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
type Run = z.infer<typeof RunSchema>;
type Task = z.infer<typeof TaskSchema>;

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: "task_root",
    root_task_id: "task_root",
    parent_task_id: null,
    business_id: "business_alpha",
    project_id: "project_alpha",
    requested_agent_id: "agent_marketing_growth_hacker",
    title: "Root task",
    message: "Ship the launch",
    state_id: "created",
    priority: "high",
    source: "test",
    source_ref: null,
    created_by: "test",
    assigned_at: null,
    created_at: "2026-03-07T10:00:00.000Z",
    updated_at: "2026-03-07T10:00:00.000Z",
    completed_at: null,
    ...overrides
  };
}

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: "run_root",
    task_id: "task_root",
    parent_run_id: null,
    agent_id: "agent_marketing_growth_hacker",
    trigger_event_id: "evt_root",
    status: "queued",
    attempt: 1,
    provider: "openai",
    model: "gpt-5-mini",
    reasoning_effort: "medium",
    started_at: "2026-03-07T10:00:00.000Z",
    completed_at: null,
    duration_ms: null,
    token_usage: null,
    cost_estimate: null,
    ...overrides
  };
}

function createArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    schema_version: SCHEMA_VERSION,
    artifact_id: "artifact_alpha",
    task_id: "task_root",
    run_id: "run_root",
    type: "report",
    name: "Launch report",
    path: "artifacts/report.md",
    uri: null,
    mime_type: "text/markdown",
    inline_payload: null,
    metadata: {},
    created_at: "2026-03-07T10:00:00.000Z",
    ...overrides
  };
}

function createMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schema_version: SCHEMA_VERSION,
    memory_id: "memory_project",
    memory_class: "semantic",
    scope: "project",
    business_id: "business_alpha",
    project_id: "project_alpha",
    agent_id: null,
    title: "Launch memory",
    summary: "Launch tactic for the current project",
    content: {
      note: "launch"
    },
    keywords: ["launch"],
    source_type: "test",
    source_ref: "run_root",
    provenance: [],
    confidence: 0.8,
    version: 1,
    supersedes_memory_id: null,
    status: "active",
    created_at: "2026-03-07T10:00:00.000Z",
    updated_at: "2026-03-07T10:00:00.000Z",
    ...overrides
  };
}

function createInput(overrides: Partial<ContextBuilderInput> = {}): ContextBuilderInput {
  return {
    task: createTask(),
    run: createRun(),
    objective: "Assemble launch context",
    query_text: "launch tactic",
    business: {
      business_id: "business_alpha"
    },
    project: {
      project_id: "project_alpha"
    },
    related_people: [],
    constraints: ["single_shot"],
    max_artifacts: 1,
    max_memory_results: 2,
    include_global_patterns: true,
    include_provenance: true,
    ...overrides
  };
}

describe("context builder", () => {
  it("builds deterministic bundles with artifact-first trimming and canonical memory scope order", async () => {
    const builder = createContextBuilder({
      createContextBundleId: () => "ctx_fixed",
      executeMemoryQuery: () =>
        Promise.resolve([
          createMemoryRecord({
            memory_id: "memory_agent",
            scope: "agent",
            project_id: null,
            agent_id: "agent_marketing_growth_hacker",
            summary: "Agent hint"
          }),
          createMemoryRecord({
            memory_id: "memory_business",
            scope: "business",
            project_id: null,
            summary: "Business memory"
          }),
          createMemoryRecord({
            memory_id: "memory_project",
            scope: "project",
            summary: "Project memory"
          })
        ]),
      loadArtifacts: () =>
        Promise.resolve([
          createArtifact({
            artifact_id: "artifact_late",
            created_at: "2026-03-07T10:00:02.000Z",
            run_id: "run_other",
            task_id: "task_child",
            path: "artifacts/late.md"
          }),
          createArtifact({
            artifact_id: "artifact_current",
            created_at: "2026-03-07T10:00:01.000Z",
            run_id: "run_root",
            task_id: "task_root",
            path: "artifacts/current.md"
          })
        ]),
      now: () => "2026-03-07T11:00:00.000Z"
    });

    const bundle = await builder.build(createInput());

    expect(bundle.context_bundle_id).toBe("ctx_fixed");
    expect(bundle.related_artifacts.map((artifact) => artifact.artifact_id)).toEqual([
      "artifact_current"
    ]);
    expect(bundle.related_memory.map((memory) => memory.memory_id)).toEqual([
      "memory_project",
      "memory_business"
    ]);
    expect(bundle.memory_scope_order).toEqual([
      "project",
      "business",
      "agent",
      "global_patterns"
    ]);
  });

  it("produces the same ordering for the same inputs", async () => {
    const artifacts = [
      createArtifact({
        artifact_id: "artifact_b",
        path: "artifacts/b.md",
        created_at: "2026-03-07T10:00:00.000Z"
      }),
      createArtifact({
        artifact_id: "artifact_a",
        path: "artifacts/a.md",
        created_at: "2026-03-07T10:00:00.000Z"
      })
    ];
    const memories = [
      createMemoryRecord({
        memory_id: "memory_b",
        scope: "business",
        project_id: null,
        summary: "Business memory"
      }),
      createMemoryRecord({
        memory_id: "memory_a",
        scope: "project",
        summary: "Project memory"
      })
    ];
    const builder = createContextBuilder({
      createContextBundleId,
      executeMemoryQuery: () => Promise.resolve(memories),
      loadArtifacts: () => Promise.resolve(artifacts),
      now: () => "2026-03-07T11:00:00.000Z"
    });

    const first = await builder.build(
      createInput({
        max_artifacts: 2,
        max_memory_results: 2
      })
    );
    const second = await builder.build(
      createInput({
        max_artifacts: 2,
        max_memory_results: 2
      })
    );

    expect(first.related_artifacts.map((artifact) => artifact.artifact_id)).toEqual([
      "artifact_b",
      "artifact_a"
    ]);
    expect(second.related_artifacts.map((artifact) => artifact.artifact_id)).toEqual([
      "artifact_b",
      "artifact_a"
    ]);
    expect(first.related_memory.map((memory) => memory.memory_id)).toEqual([
      "memory_a",
      "memory_b"
    ]);
    expect(second.related_memory.map((memory) => memory.memory_id)).toEqual([
      "memory_a",
      "memory_b"
    ]);
  });
});
