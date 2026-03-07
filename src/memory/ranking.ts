import type { z } from "zod";

import {
  ArtifactSchema,
  MemoryQuerySchema,
  MemoryRecordSchema
} from "../contracts/index.js";

export const CANONICAL_MEMORY_SCOPE_ORDER = [
  "project",
  "business",
  "agent",
  "global_patterns"
] as const;

type Artifact = z.infer<typeof ArtifactSchema>;
type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export type RankedMemoryRecord = {
  combined_score: number;
  lexical_score: number;
  record: MemoryRecord;
  scope_priority: number;
  semantic_score: number;
};

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function uniqueTokenCount(tokens: string[]): number {
  return new Set(tokens).size;
}

function sharedTokenCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);

  return uniqueTokenCount(left.filter((token) => rightSet.has(token)));
}

function lexicalText(record: MemoryRecord): string {
  return [record.title, record.summary, record.keywords.join(" ")].join(" ");
}

function semanticText(record: MemoryRecord): string {
  const content =
    typeof record.content === "string"
      ? record.content
      : JSON.stringify(record.content);

  return [record.summary, record.keywords.join(" "), content].join(" ");
}

function scopePriority(
  scope: MemoryRecord["scope"],
  scopeOrder: readonly MemoryRecord["scope"][]
): number {
  const position = scopeOrder.indexOf(scope);

  return position === -1 ? Number.MAX_SAFE_INTEGER : position;
}

export function normalizeScopeOrder(
  requestedOrder: MemoryQuery["scope_order"],
  includeGlobalPatterns: boolean
): MemoryQuery["scope_order"] {
  const requested = new Set(requestedOrder);

  return CANONICAL_MEMORY_SCOPE_ORDER.filter((scope) => {
    if (scope === "global_patterns" && !includeGlobalPatterns) {
      return false;
    }

    return requested.has(scope);
  });
}

export function rankMemoryRecord(
  record: MemoryRecord,
  query: Pick<
    MemoryQuery,
    "include_global_patterns" | "query_text" | "scope_order"
  >
): RankedMemoryRecord {
  const scopeOrder = normalizeScopeOrder(
    query.scope_order,
    query.include_global_patterns
  );
  const queryTokens = tokenize(query.query_text);
  const lexicalTokens = tokenize(lexicalText(record));
  const semanticTokens = tokenize(semanticText(record));
  const lexicalMatches = sharedTokenCount(queryTokens, lexicalTokens);
  const semanticMatches = sharedTokenCount(queryTokens, semanticTokens);
  const lexicalScore =
    queryTokens.length === 0 ? 0 : lexicalMatches / queryTokens.length;
  const semanticScore =
    queryTokens.length === 0 ? 0 : semanticMatches / queryTokens.length;

  return {
    record,
    lexical_score: lexicalScore,
    semantic_score: semanticScore,
    combined_score: lexicalScore * 2 + semanticScore,
    scope_priority: scopePriority(record.scope, scopeOrder)
  };
}

export function compareRankedMemoryRecords(
  left: RankedMemoryRecord,
  right: RankedMemoryRecord
): number {
  if (left.scope_priority !== right.scope_priority) {
    return left.scope_priority - right.scope_priority;
  }

  if (left.combined_score !== right.combined_score) {
    return right.combined_score - left.combined_score;
  }

  if (left.lexical_score !== right.lexical_score) {
    return right.lexical_score - left.lexical_score;
  }

  if (left.semantic_score !== right.semantic_score) {
    return right.semantic_score - left.semantic_score;
  }

  const leftUpdated = new Date(left.record.updated_at).getTime();
  const rightUpdated = new Date(right.record.updated_at).getTime();

  if (leftUpdated !== rightUpdated) {
    return rightUpdated - leftUpdated;
  }

  return 0;
}

export function compareArtifacts(
  left: Artifact,
  right: Artifact,
  currentTaskId: string,
  currentRunId: string
): number {
  const leftPriority =
    left.run_id === currentRunId ? 0 : left.task_id === currentTaskId ? 1 : 2;
  const rightPriority =
    right.run_id === currentRunId ? 0 : right.task_id === currentTaskId ? 1 : 2;

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftCreatedAt = new Date(left.created_at).getTime();
  const rightCreatedAt = new Date(right.created_at).getTime();

  if (leftCreatedAt !== rightCreatedAt) {
    return rightCreatedAt - leftCreatedAt;
  }

  return 0;
}
