import type { Sql } from "postgres";
import type { z } from "zod";

import {
  MemoryQuerySchema,
  MemoryRecordSchema
} from "../contracts/index.js";
import { RUNTIME_SCHEMA } from "../persistence/db.js";
import {
  compareRankedMemoryRecords,
  normalizeScopeOrder,
  rankMemoryRecord
} from "./ranking.js";

const EMBEDDING_DIMENSIONS = 1536;

type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

type MemoryRow = {
  agent_id: string | null;
  business_id: string | null;
  confidence: number | string;
  content: Record<string, unknown> | string;
  created_at: string | Date;
  keywords: string[];
  memory_class: MemoryRecord["memory_class"];
  memory_id: string;
  project_id: string | null;
  provenance: Record<string, unknown>[] | string;
  scope: MemoryRecord["scope"];
  source_ref: string;
  source_type: string;
  status: string;
  summary: string;
  supersedes_memory_id: string | null;
  title: string;
  updated_at: string | Date;
  version: number;
  vector_similarity?: number | null;
};

function schemaName(): string {
  return `"${RUNTIME_SCHEMA}"`;
}

function normalizeTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

function parseJsonValue<T>(value: T | string): T {
  if (typeof value !== "string") {
    return value;
  }

  return JSON.parse(value) as T;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function semanticText(record: Pick<MemoryRecord, "content" | "keywords" | "summary" | "title">): string {
  const content =
    typeof record.content === "string"
      ? record.content
      : JSON.stringify(record.content);

  return [record.title, record.summary, record.keywords.join(" "), content].join(
    " "
  );
}

function hashToken(seed: string): number {
  let hash = 0;

  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function createDeterministicEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

  for (const token of tokenize(text)) {
    for (let index = 0; index < 4; index += 1) {
      const bucket = hashToken(`${token}:${String(index)}`) % EMBEDDING_DIMENSIONS;
      const sign = hashToken(`${token}:sign:${String(index)}`) % 2 === 0 ? 1 : -1;

      vector[bucket] = (vector[bucket] ?? 0) + sign;
    }
  }

  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0)
  );

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return MemoryRecordSchema.parse({
    schema_version: "1.0",
    memory_id: row.memory_id,
    memory_class: row.memory_class,
    scope: row.scope,
    business_id: row.business_id,
    project_id: row.project_id,
    agent_id: row.agent_id,
    title: row.title,
    summary: row.summary,
    content: parseJsonValue(row.content),
    keywords: row.keywords,
    source_type: row.source_type,
    source_ref: row.source_ref,
    provenance: parseJsonValue(row.provenance),
    confidence:
      typeof row.confidence === "number"
        ? row.confidence
        : Number.parseFloat(row.confidence),
    version: row.version,
    supersedes_memory_id: row.supersedes_memory_id,
    status: row.status,
    created_at: normalizeTimestamp(row.created_at),
    updated_at: normalizeTimestamp(row.updated_at)
  });
}

function buildScopeClauses(query: MemoryQuery): {
  clauses: string[];
  parameters: (string | string[])[];
} {
  const clauses: string[] = [];
  const parameters: (string | string[])[] = [query.allowed_classes];
  let parameterIndex = 2;

  for (const scope of normalizeScopeOrder(
    query.scope_order,
    query.include_global_patterns
  )) {
    switch (scope) {
      case "project":
        if (query.business_id && query.project_id) {
          const businessParameter = String(parameterIndex);
          const projectParameter = String(parameterIndex + 1);

          clauses.push(
            `(scope = 'project' and business_id = $${businessParameter} and project_id = $${projectParameter})`
          );
          parameters.push(query.business_id, query.project_id);
          parameterIndex += 2;
        }
        break;
      case "business":
        if (query.business_id) {
          clauses.push(
            `(scope = 'business' and business_id = $${String(parameterIndex)})`
          );
          parameters.push(query.business_id);
          parameterIndex += 1;
        }
        break;
      case "agent":
        if (query.business_id) {
          const businessParameter = String(parameterIndex);
          const agentParameter = String(parameterIndex + 1);

          clauses.push(
            `(scope = 'agent' and business_id = $${businessParameter} and agent_id = $${agentParameter})`
          );
          parameters.push(query.business_id, query.requester_agent_id);
          parameterIndex += 2;
        }
        break;
      case "global_patterns":
        clauses.push(`(scope = 'global_patterns')`);
        break;
    }
  }

  return { clauses, parameters };
}

export function createMemoryService(sql: Sql) {
  const schema = schemaName();

  return {
    async upsertMemoryRecord(candidate: MemoryRecord): Promise<MemoryRecord> {
      const record = MemoryRecordSchema.parse(candidate);
      const embedding = createDeterministicEmbedding(semanticText(record));

      await sql.unsafe(
        `
          insert into ${schema}.memory_records (
            memory_id,
            memory_class,
            scope,
            business_id,
            project_id,
            agent_id,
            title,
            summary,
            content,
            keywords,
            source_type,
            source_ref,
            provenance,
            confidence,
            version,
            supersedes_memory_id,
            status,
            embedding,
            created_at,
            updated_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::text[], $11, $12, $13::jsonb, $14, $15, $16, $17, $18::vector, $19, $20
          )
          on conflict (memory_id) do update set
            memory_class = excluded.memory_class,
            scope = excluded.scope,
            business_id = excluded.business_id,
            project_id = excluded.project_id,
            agent_id = excluded.agent_id,
            title = excluded.title,
            summary = excluded.summary,
            content = excluded.content,
            keywords = excluded.keywords,
            source_type = excluded.source_type,
            source_ref = excluded.source_ref,
            provenance = excluded.provenance,
            confidence = excluded.confidence,
            version = excluded.version,
            supersedes_memory_id = excluded.supersedes_memory_id,
            status = excluded.status,
            embedding = excluded.embedding,
            updated_at = excluded.updated_at
        `,
        [
          record.memory_id,
          record.memory_class,
          record.scope,
          record.business_id,
          record.project_id,
          record.agent_id,
          record.title,
          record.summary,
          JSON.stringify(record.content),
          record.keywords,
          record.source_type,
          record.source_ref,
          JSON.stringify(record.provenance),
          record.confidence,
          record.version,
          record.supersedes_memory_id,
          record.status,
          toVectorLiteral(embedding),
          record.created_at,
          record.updated_at
        ]
      );

      return record;
    },

    async executeQuery(candidate: MemoryQuery): Promise<MemoryRecord[]> {
      const query = MemoryQuerySchema.parse(candidate);
      const { clauses, parameters } = buildScopeClauses(query);
      const queryEmbedding = toVectorLiteral(
        createDeterministicEmbedding(query.query_text)
      );

      if (clauses.length === 0) {
        return [];
      }

      const rows = await sql.unsafe<MemoryRow[]>(
        `
          select
            memory_id,
            memory_class,
            scope,
            business_id,
            project_id,
            agent_id,
            title,
            summary,
            content,
            keywords,
            source_type,
            source_ref,
            provenance,
            confidence::float8 as confidence,
            version,
            supersedes_memory_id,
            status,
            case
              when embedding is null then null
              else greatest(0, 1 - (embedding <=> $${String(parameters.length + 1)}::vector))
            end as vector_similarity,
            created_at::text as created_at,
            updated_at::text as updated_at
          from ${schema}.memory_records
          where status = 'active'
            and memory_class = any($1::text[])
            and (${clauses.join(" or ")})
        `,
        [...parameters, queryEmbedding]
      );

      return rows
        .map((row) => {
          const record = toMemoryRecord(row);
          const ranked = rankMemoryRecord(record, query);
          const semanticScore = row.vector_similarity ?? ranked.semantic_score;

          return {
            ...ranked,
            combined_score: ranked.lexical_score * 2 + semanticScore,
            semantic_score: semanticScore
          };
        })
        .filter((ranked) => ranked.combined_score > 0)
        .sort(compareRankedMemoryRecords)
        .slice(0, query.max_results)
        .map((ranked) =>
          query.include_provenance
            ? ranked.record
            : {
                ...ranked.record,
                provenance: []
              }
        );
    }
  };
}
