export const MEMORY_NAMESPACES = {
  WORKFLOW_STATE: "workflow.state",
  TICKET_CONTEXT: "ticket.context",
  CODE_DECISIONS: "code.decisions",
  QUALITY_SIGNALS: "quality.signals",
  RESEARCH_FINDINGS: "research.findings",
  USER_PREFERENCES: "user.preferences",
} as const;

export type MemoryNamespace = (typeof MEMORY_NAMESPACES)[keyof typeof MEMORY_NAMESPACES];

export type MemoryContextPack = {
  id: string;
  namespace: MemoryNamespace;
  content: string;
  relevance?: number;
  importance?: number;
  createdAt?: string;
  updatedAt?: string;
  tokenEstimate?: number;
  tags?: readonly string[];
  sourceRef?: string;
};

export type RankedMemoryContextPack = MemoryContextPack & {
  score: number;
  tokenEstimate: number;
};

export type ContextPackRankingWeights = {
  relevance: number;
  importance: number;
  recency: number;
  namespace: number;
};

export type ContextPackRankingOptions = {
  now?: Date;
  weights?: Partial<ContextPackRankingWeights>;
  namespacePriority?: Partial<Record<MemoryNamespace, number>>;
};

export type ContextPackDropReason = "below_score_threshold" | "token_budget" | "max_packs";

export type DroppedMemoryContextPack = RankedMemoryContextPack & {
  reason: ContextPackDropReason;
};

export type ContextPackSelectionOptions = ContextPackRankingOptions & {
  maxPacks?: number;
  maxTokens?: number;
  minScore?: number;
};

export type ContextPackSelection = {
  selected: RankedMemoryContextPack[];
  dropped: DroppedMemoryContextPack[];
  totalTokens: number;
  maxTokens: number;
  maxPacks: number;
};

export type MemoryRetentionAction = "keep" | "archive_then_delete" | "delete_only";

export type MemoryRetentionRule = {
  namespace: MemoryNamespace;
  retainDays: number;
  maxEntries: number;
  maxActionsPerRun: number;
  action: MemoryRetentionAction;
  preserveTypes?: readonly string[];
  minQualityScore?: number;
};

const MS_PER_DAY = 86_400_000;

const NAMESPACE_SET = new Set<MemoryNamespace>(Object.values(MEMORY_NAMESPACES) as MemoryNamespace[]);

const DEFAULT_NAMESPACE_PRIORITY = {
  [MEMORY_NAMESPACES.WORKFLOW_STATE]: 0.95,
  [MEMORY_NAMESPACES.TICKET_CONTEXT]: 0.9,
  [MEMORY_NAMESPACES.CODE_DECISIONS]: 0.85,
  [MEMORY_NAMESPACES.QUALITY_SIGNALS]: 0.8,
  [MEMORY_NAMESPACES.RESEARCH_FINDINGS]: 0.75,
  [MEMORY_NAMESPACES.USER_PREFERENCES]: 0.7,
} as const satisfies Record<MemoryNamespace, number>;

const DEFAULT_RANKING_WEIGHTS: ContextPackRankingWeights = {
  relevance: 0.45,
  importance: 0.25,
  recency: 0.2,
  namespace: 0.1,
};

const MEMORY_RETENTION_RULES_LIST: readonly MemoryRetentionRule[] = [
  {
    namespace: MEMORY_NAMESPACES.WORKFLOW_STATE,
    retainDays: 14,
    maxEntries: 600,
    maxActionsPerRun: 80,
    action: "delete_only",
    preserveTypes: ["workflow_artifact"],
  },
  {
    namespace: MEMORY_NAMESPACES.TICKET_CONTEXT,
    retainDays: 60,
    maxEntries: 800,
    maxActionsPerRun: 40,
    action: "archive_then_delete",
  },
  {
    namespace: MEMORY_NAMESPACES.CODE_DECISIONS,
    retainDays: 180,
    maxEntries: 600,
    maxActionsPerRun: 20,
    action: "archive_then_delete",
    preserveTypes: ["decision"],
  },
  {
    namespace: MEMORY_NAMESPACES.QUALITY_SIGNALS,
    retainDays: 120,
    maxEntries: 600,
    maxActionsPerRun: 20,
    action: "archive_then_delete",
    minQualityScore: 75,
  },
  {
    namespace: MEMORY_NAMESPACES.RESEARCH_FINDINGS,
    retainDays: 120,
    maxEntries: 500,
    maxActionsPerRun: 20,
    action: "archive_then_delete",
  },
  {
    namespace: MEMORY_NAMESPACES.USER_PREFERENCES,
    retainDays: 3650,
    maxEntries: 200,
    maxActionsPerRun: 0,
    action: "keep",
    preserveTypes: ["preference_profile"],
  },
] as const;

const MEMORY_RETENTION_RULES_MAP = new Map<MemoryNamespace, MemoryRetentionRule>(
  MEMORY_RETENTION_RULES_LIST.map((rule) => [rule.namespace, rule]),
);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseIsoTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function resolveTimestampMs(pack: MemoryContextPack): number | null {
  const updatedMs = parseIsoTimestampMs(pack.updatedAt);
  if (updatedMs !== null) return updatedMs;
  return parseIsoTimestampMs(pack.createdAt);
}

function normalizeWeight(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mergeWeights(overrides?: Partial<ContextPackRankingWeights>): ContextPackRankingWeights {
  return {
    relevance: normalizeWeight(overrides?.relevance ?? DEFAULT_RANKING_WEIGHTS.relevance),
    importance: normalizeWeight(overrides?.importance ?? DEFAULT_RANKING_WEIGHTS.importance),
    recency: normalizeWeight(overrides?.recency ?? DEFAULT_RANKING_WEIGHTS.recency),
    namespace: normalizeWeight(overrides?.namespace ?? DEFAULT_RANKING_WEIGHTS.namespace),
  };
}

export function isMemoryNamespace(value: string): value is MemoryNamespace {
  return NAMESPACE_SET.has(value as MemoryNamespace);
}

export const MEMORY_RETENTION_RULES: readonly MemoryRetentionRule[] = MEMORY_RETENTION_RULES_LIST;

export function getMemoryRetentionRule(namespace: MemoryNamespace): MemoryRetentionRule {
  return (
    MEMORY_RETENTION_RULES_MAP.get(namespace) ?? {
      namespace,
      retainDays: 90,
      maxEntries: 500,
      maxActionsPerRun: 20,
      action: "archive_then_delete",
    }
  );
}

export function estimateContextPackTokens(content: string): number {
  const normalized = normalizeText(content);
  if (!normalized) return 1;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function scoreContextPack(
  pack: MemoryContextPack,
  options: ContextPackRankingOptions = {},
): number {
  const nowMs = (options.now ?? new Date()).getTime();
  const mergedWeights = mergeWeights(options.weights);
  const mergedNamespacePriority: Record<MemoryNamespace, number> = {
    ...DEFAULT_NAMESPACE_PRIORITY,
    ...(options.namespacePriority ?? {}),
  };

  const relevance = clamp(pack.relevance ?? 0.5, 0, 1);
  const importance = clamp(pack.importance ?? 0.5, 0, 1);
  const namespacePriority = clamp(mergedNamespacePriority[pack.namespace] ?? 0.5, 0, 1);

  const timestampMs = resolveTimestampMs(pack);
  const recencyScore =
    timestampMs === null ? 0.5 : 1 / (1 + Math.max(0, nowMs - timestampMs) / MS_PER_DAY / 14);

  const totalWeight =
    mergedWeights.relevance +
    mergedWeights.importance +
    mergedWeights.recency +
    mergedWeights.namespace;

  if (totalWeight <= 0) return 0;

  return (
    (relevance * mergedWeights.relevance +
      importance * mergedWeights.importance +
      recencyScore * mergedWeights.recency +
      namespacePriority * mergedWeights.namespace) /
    totalWeight
  );
}

export function rankContextPacks(
  packs: readonly MemoryContextPack[],
  options: ContextPackRankingOptions = {},
): RankedMemoryContextPack[] {
  const ranked = packs.map((pack) => ({
    ...pack,
    score: scoreContextPack(pack, options),
    tokenEstimate: pack.tokenEstimate ?? estimateContextPackTokens(pack.content),
  }));

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const aMs = resolveTimestampMs(a);
    const bMs = resolveTimestampMs(b);
    if (aMs !== bMs) return (bMs ?? -Infinity) - (aMs ?? -Infinity);

    if ((b.importance ?? 0) !== (a.importance ?? 0)) {
      return (b.importance ?? 0) - (a.importance ?? 0);
    }

    return a.id.localeCompare(b.id);
  });

  return ranked;
}

export function selectContextPacks(
  packs: readonly MemoryContextPack[],
  options: ContextPackSelectionOptions = {},
): ContextPackSelection {
  const maxPacks = options.maxPacks ?? 8;
  const maxTokens = options.maxTokens ?? 1600;
  const minScore = clamp(options.minScore ?? 0, 0, 1);

  const ranked = rankContextPacks(packs, options);
  const selected: RankedMemoryContextPack[] = [];
  const dropped: DroppedMemoryContextPack[] = [];
  let totalTokens = 0;

  for (const pack of ranked) {
    if (pack.score < minScore) {
      dropped.push({ ...pack, reason: "below_score_threshold" });
      continue;
    }

    if (selected.length >= maxPacks) {
      dropped.push({ ...pack, reason: "max_packs" });
      continue;
    }

    if (totalTokens + pack.tokenEstimate > maxTokens) {
      dropped.push({ ...pack, reason: "token_budget" });
      continue;
    }

    selected.push(pack);
    totalTokens += pack.tokenEstimate;
  }

  return {
    selected,
    dropped,
    totalTokens,
    maxTokens,
    maxPacks,
  };
}
