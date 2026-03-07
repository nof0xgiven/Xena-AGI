import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";
import type { z } from "zod";

import {
  ArtifactSchema,
  ContextBundleSchema,
  MemoryQuerySchema,
  MemoryRecordSchema,
  RunSchema,
  SCHEMA_VERSION,
  TaskSchema
} from "../contracts/index.js";
import { RUNTIME_SCHEMA } from "../persistence/db.js";
import {
  compareArtifacts,
  compareRankedMemoryRecords,
  normalizeScopeOrder,
  rankMemoryRecord
} from "../memory/ranking.js";
import { createMemoryService } from "../memory/service.js";

type Artifact = z.infer<typeof ArtifactSchema>;
type ContextBundle = z.infer<typeof ContextBundleSchema>;
type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
type Run = z.infer<typeof RunSchema>;
type Task = z.infer<typeof TaskSchema>;

type ArtifactRow = {
  artifact_id: string;
  created_at: string | Date;
  inline_payload: Record<string, unknown> | string | null;
  metadata: Record<string, unknown>;
  mime_type: string | null;
  name: string;
  path: string | null;
  run_id: string;
  storage_key: string | null;
  task_id: string;
  type: Artifact["type"];
  uri: string | null;
};

export type ContextBuilderInput = {
  allowed_memory_classes?: MemoryQuery["allowed_classes"];
  business?: Record<string, unknown>;
  constraints?: string[];
  include_global_patterns?: boolean;
  include_provenance?: boolean;
  max_artifacts?: number;
  max_memory_results?: number;
  memory_scope_order?: MemoryQuery["scope_order"];
  objective: string;
  project?: Record<string, unknown>;
  query_text: string;
  related_people?: Record<string, unknown>[];
  run: Run;
  task: Task;
};

type ContextBuilderDependencies = {
  createContextBundleId?: () => string;
  executeMemoryQuery: (query: MemoryQuery) => Promise<MemoryRecord[]>;
  loadArtifacts: (task: Task, run: Run) => Promise<Artifact[]>;
  now?: () => string;
};

function schemaName(): string {
  return `"${RUNTIME_SCHEMA}"`;
}

function normalizeTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

function mapArtifactRow(row: ArtifactRow): Artifact {
  return ArtifactSchema.parse({
    schema_version: SCHEMA_VERSION,
    artifact_id: row.artifact_id,
    task_id: row.task_id,
    run_id: row.run_id,
    type: row.type,
    name: row.name,
    path: row.storage_key ?? row.path,
    uri: row.uri,
    mime_type: row.mime_type,
    inline_payload: row.inline_payload,
    metadata: row.metadata,
    created_at: normalizeTimestamp(row.created_at)
  });
}

export function createContextBundleId(): string {
  return `ctx_${randomUUID()}`;
}

export function createContextBuilder(dependencies: ContextBuilderDependencies) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const makeContextBundleId =
    dependencies.createContextBundleId ?? createContextBundleId;

  return {
    async build(input: ContextBuilderInput): Promise<ContextBundle> {
      const task = TaskSchema.parse(input.task);
      const run = RunSchema.parse(input.run);
      const artifacts = (await dependencies.loadArtifacts(task, run))
        .map((artifact) => ArtifactSchema.parse(artifact))
        .sort((left, right) =>
          compareArtifacts(left, right, task.task_id, run.run_id)
        )
        .slice(0, input.max_artifacts ?? 10);
      const query: MemoryQuery = MemoryQuerySchema.parse({
        schema_version: SCHEMA_VERSION,
        query_id: `memqry_${randomUUID()}`,
        requester_agent_id: run.agent_id,
        task_id: task.task_id,
        business_id: task.business_id,
        project_id: task.project_id,
        query_text: input.query_text,
        scope_order: normalizeScopeOrder(
          input.memory_scope_order ?? [
            "project",
            "business",
            "agent",
            "global_patterns"
          ],
          input.include_global_patterns ?? true
        ),
        allowed_classes:
          input.allowed_memory_classes ?? ["episodic", "semantic", "procedural"],
        max_results: input.max_memory_results ?? 10,
        include_global_patterns: input.include_global_patterns ?? true,
        include_provenance: input.include_provenance ?? true,
        created_at: now()
      });
      const memory = (await dependencies.executeMemoryQuery(query))
        .map((record) => MemoryRecordSchema.parse(record))
        .map((record) => rankMemoryRecord(record, query))
        .sort(compareRankedMemoryRecords)
        .map((ranked) => ranked.record)
        .slice(0, query.max_results);

      return ContextBundleSchema.parse({
        schema_version: SCHEMA_VERSION,
        context_bundle_id: makeContextBundleId(),
        task,
        run,
        business: input.business ?? {
          business_id: task.business_id
        },
        project: input.project ?? {
          project_id: task.project_id
        },
        related_memory: memory,
        related_artifacts: artifacts,
        related_people: input.related_people ?? [],
        constraints: input.constraints ?? [],
        objective: input.objective,
        memory_scope_order: query.scope_order,
        generated_at: now()
      });
    }
  };
}

export function createDatabaseContextBuilder(sql: Sql) {
  const schema = schemaName();
  const memoryService = createMemoryService(sql);

  return createContextBuilder({
    async executeMemoryQuery(query) {
      return memoryService.executeQuery(query);
    },
    async loadArtifacts(task, run) {
      const rows = await sql.unsafe<ArtifactRow[]>(
        `
          with current_task as (
            select root_task_id
            from ${schema}.tasks
            where task_id = $1
            limit 1
          )
          select
            artifacts.artifact_id,
            artifacts.task_id,
            artifacts.run_id,
            artifacts.type,
            artifacts.name,
            artifacts.storage_key,
            artifacts.path,
            artifacts.uri,
            artifacts.mime_type,
            artifacts.inline_payload,
            artifacts.metadata,
            artifacts.created_at::text as created_at
          from ${schema}.artifacts as artifacts
          left join ${schema}.tasks as tasks
            on tasks.task_id = artifacts.task_id
          where artifacts.task_id = $1
             or artifacts.run_id = $2
             or tasks.root_task_id = (select root_task_id from current_task)
        `,
        [task.task_id, run.run_id]
      );

      return rows.map(mapArtifactRow);
    }
  });
}
