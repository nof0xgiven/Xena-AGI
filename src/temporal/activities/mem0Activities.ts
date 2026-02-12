import {
  createMem0Client,
  mem0Add as mem0AddImpl,
  mem0Delete as mem0DeleteImpl,
  mem0ListEntries,
  mem0Search as mem0SearchImpl,
  mem0SearchEntries,
} from "../../mem0.js";
import { loadWorkerEnv } from "../../env.js";
import { logger } from "../../logger.js";
import {
  getMemoryRetentionRule,
  isMemoryNamespace,
  MEMORY_NAMESPACES,
  MEMORY_RETENTION_RULES,
  selectContextPacks,
  type MemoryNamespace,
  type MemoryContextPack,
  type MemoryRetentionRule,
} from "../../memory/policy.js";
import {
  DEFAULT_USER_PREFERENCES,
  cloneUserPreferences,
  parseUserPreferencesFromMemoryContent,
  type UserPreferencesProfile,
} from "../../memory/userPreferences.js";

export type MemoryRecordType =
  | "workflow_artifact"
  | "decision"
  | "quality_signal"
  | "research_finding"
  | "qa_exchange"
  | "preference_profile"
  | "event";

export type MemoryRecordOutcome = "success" | "failed" | "blocked" | "in_progress" | "updated";

export type HybridMemoryLane =
  | "ticket_context"
  | "decision_history"
  | "quality_history"
  | "research_history"
  | "user_preferences";

export type HybridMemoryLaneSnapshot = {
  lane: HybridMemoryLane;
  namespace: MemoryNamespace;
  count: number;
};

export type HybridMemoryContextResult = {
  text: string;
  selected: MemoryContextPack[];
  totalTokens: number;
  lanes: HybridMemoryLaneSnapshot[];
};

export type DecisionSignature = {
  key: string;
  domain: string;
  selectedStrategy: string;
  triggerErrorKinds: string[];
  occurrences: number;
  lastSeenAt: string | null;
  avgQualityScore: number | null;
};

export type DecisionSignatureResult = {
  signatures: DecisionSignature[];
  text: string;
};

export type MemoryRetentionNamespaceResult = {
  namespace: MemoryNamespace;
  scanned: number;
  candidates: number;
  archived: number;
  deleted: number;
  skipped: number;
  errors: number;
};

export type MemoryRetentionResult = {
  dryRun: boolean;
  scanned: number;
  candidates: number;
  archived: number;
  deleted: number;
  skipped: number;
  errors: number;
  summary: string;
  namespaces: MemoryRetentionNamespaceResult[];
};

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldEnableGraphDefault(namespace: MemoryNamespace): boolean {
  const env = loadWorkerEnv();
  if (!parseBooleanEnv(env.MEM0_ENABLE_GRAPH)) return false;
  return (
    namespace === MEMORY_NAMESPACES.USER_PREFERENCES ||
    namespace === MEMORY_NAMESPACES.CODE_DECISIONS ||
    namespace === MEMORY_NAMESPACES.QUALITY_SIGNALS ||
    namespace === MEMORY_NAMESPACES.RESEARCH_FINDINGS
  );
}

function shouldInferDefault(namespace: MemoryNamespace, enableGraph: boolean): boolean {
  if (enableGraph) return true;
  return namespace === MEMORY_NAMESPACES.USER_PREFERENCES;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseKeyValue(content: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "im");
  const match = content.match(pattern);
  return match?.[1] ? normalizeWhitespace(match[1]) : null;
}

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((part) => part.trim()).filter((part) => part.length > 0))];
}

function isRelationshipQuery(query: string): boolean {
  return /\b(after|before|because|caused|trigger|switch|fallback|relationship|depends|when|if|then)\b/i.test(query);
}

function formatIsoDay(iso: string | null): string {
  if (!iso) return "unknown";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  return new Date(ms).toISOString().slice(0, 10);
}

function mem0() {
  const env = loadWorkerEnv();
  return createMem0Client({ apiKey: env.MEM0_API_KEY, baseUrl: env.MEM0_BASE_URL });
}

function userId(_projectKey: string) {
  // Cross-project stable identity so Xena remembers context, decisions, and preferences
  // across all projects. Project-specific filtering is handled via metadata.project on each entry.
  return "xena:operator";
}

function timestampMs(iso: string | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

const MAX_RETENTION_SCAN_PER_NAMESPACE = 1200;
const DEFAULT_RETENTION_PAGE_SIZE = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function memoryEntryTimestampMs(entry: {
  createdAt?: string;
  updatedAt?: string;
  metadata: Record<string, unknown>;
}): number {
  const metadataRecordedAt = asString(entry.metadata.recordedAt);
  return Math.max(timestampMs(entry.updatedAt), timestampMs(entry.createdAt), timestampMs(metadataRecordedAt ?? undefined));
}

function toMemoryExcerpt(value: string, maxLength = 220): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function metadataType(entry: { metadata: Record<string, unknown> }): string {
  return asString(entry.metadata.type) ?? "unknown";
}

function metadataIntent(entry: { metadata: Record<string, unknown> }): string {
  return asString(entry.metadata.intent) ?? "unknown";
}

function isPinnedEntry(entry: { metadata: Record<string, unknown> }): boolean {
  return entry.metadata.retentionPinned === true;
}

function entryQualityScore(entry: { metadata: Record<string, unknown> }): number | null {
  const direct = asNumber(entry.metadata.qualityScore);
  if (direct !== null) return direct;
  const text = asString(entry.metadata.qualityScore);
  if (!text) return null;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldPreserveEntryByRule(
  entry: {
    metadata: Record<string, unknown>;
  },
  rule: MemoryRetentionRule,
): boolean {
  if (rule.action === "keep") return true;
  if (isPinnedEntry(entry)) return true;
  const type = metadataType(entry);
  if (rule.preserveTypes?.includes(type)) return true;

  if (typeof rule.minQualityScore === "number") {
    const quality = entryQualityScore(entry);
    if (quality !== null && quality >= rule.minQualityScore) return true;
  }

  return false;
}

function identifyRetentionCandidates(opts: {
  entries: Array<{
    id?: string;
    memory: string;
    metadata: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }>;
  rule: MemoryRetentionRule;
  nowMs: number;
}): Array<{
  id: string;
  memory: string;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  reason: "stale" | "overflow";
}> {
  const withId = opts.entries.filter((entry): entry is typeof entry & { id: string } => typeof entry.id === "string" && entry.id.trim().length > 0);
  const sortedNewest = withId
    .slice()
    .sort((left, right) => memoryEntryTimestampMs(right) - memoryEntryTimestampMs(left));
  const overflowIds = new Set(sortedNewest.slice(opts.rule.maxEntries).map((entry) => entry.id));
  const staleThresholdMs = opts.nowMs - opts.rule.retainDays * 24 * 60 * 60 * 1000;

  const candidates = sortedNewest
    .slice()
    .sort((left, right) => memoryEntryTimestampMs(left) - memoryEntryTimestampMs(right))
    .map((entry) => {
      const ts = memoryEntryTimestampMs(entry);
      const stale = ts <= staleThresholdMs;
      const overflow = overflowIds.has(entry.id);
      if (!stale && !overflow) return null;
      if (shouldPreserveEntryByRule(entry, opts.rule)) return null;
      return {
        ...entry,
        reason: stale ? "stale" as const : "overflow" as const,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return candidates.slice(0, Math.max(0, opts.rule.maxActionsPerRun));
}

async function listEntriesForNamespace(opts: {
  projectKey: string;
  namespace: MemoryNamespace;
  appId?: string;
}): Promise<
  Array<{
    id?: string;
    memory: string;
    metadata: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }>
> {
  const pages: Array<{
    id?: string;
    memory: string;
    metadata: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }> = [];
  let page = 1;

  while (pages.length < MAX_RETENTION_SCAN_PER_NAMESPACE) {
    const listed = await mem0ListEntries({
      mem0: mem0(),
      userId: userId(opts.projectKey),
      namespace: opts.namespace,
      appId: opts.appId,
      page,
      pageSize: DEFAULT_RETENTION_PAGE_SIZE,
    });
    if (listed.entries.length === 0) break;
    for (const entry of listed.entries) {
      pages.push(entry);
      if (pages.length >= MAX_RETENTION_SCAN_PER_NAMESPACE) break;
    }
    if (listed.nextPage === null) {
      if (listed.entries.length < DEFAULT_RETENTION_PAGE_SIZE) break;
      page += 1;
      continue;
    }
    page = listed.nextPage;
  }

  return pages;
}

export async function mem0Search(opts: {
  projectKey: string;
  issueIdentifier: string;
  query: string;
  namespace?: string;
  metadataFilters?: Record<string, unknown>;
  agentId?: string;
  appId?: string;
  runId?: string;
}): Promise<string> {
  try {
    const namespace =
      typeof opts.namespace === "string" && isMemoryNamespace(opts.namespace)
        ? opts.namespace
        : undefined;

    return await mem0SearchImpl({
      mem0: mem0(),
      query: opts.query,
      userId: userId(opts.projectKey),
      limit: 10,
      namespace,
      metadataFilters: opts.metadataFilters,
      agentId: opts.agentId,
      appId: opts.appId,
      runId: opts.runId,
    });
  } catch (err) {
    // Memory enriches prompts but must not take the whole system down.
    logger.warn({ err }, "mem0Search failed; continuing without memory");
    return "";
  }
}

export async function mem0SearchContext(opts: {
  projectKey: string;
  issueIdentifier: string;
  query: string;
  namespace?: string;
  maxPacks?: number;
  maxTokens?: number;
}): Promise<{ selected: MemoryContextPack[]; text: string; totalTokens: number }> {
  try {
    const namespace: MemoryNamespace =
      typeof opts.namespace === "string" && isMemoryNamespace(opts.namespace)
        ? opts.namespace
        : MEMORY_NAMESPACES.TICKET_CONTEXT;

    const entries = await mem0SearchEntries({
      mem0: mem0(),
      query: opts.query,
      userId: userId(opts.projectKey),
      limit: 20,
      namespace,
    });

    const packs: MemoryContextPack[] = entries.map((entry, index) => ({
      id: entry.id ?? `${opts.issueIdentifier}:${namespace}:${index + 1}`,
      namespace,
      content: entry.memory,
      relevance: clamp(entry.score ?? 0.7, 0, 1),
      importance: 0.6,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      tags: [
        opts.issueIdentifier,
        typeof entry.metadata.type === "string" ? entry.metadata.type : "unknown",
      ],
      sourceRef: typeof entry.metadata.issue === "string" ? entry.metadata.issue : undefined,
    }));

    const selected = selectContextPacks(packs, {
      maxPacks: opts.maxPacks ?? 8,
      maxTokens: opts.maxTokens ?? 1600,
      minScore: 0,
    });

    const text = selected.selected.map((p) => `- ${p.content}`).join("\n");

    return {
      selected: selected.selected,
      text,
      totalTokens: selected.totalTokens,
    };
  } catch (err) {
    logger.warn({ err }, "mem0SearchContext failed; continuing without context packs");
    return {
      selected: [],
      text: "",
      totalTokens: 0,
    };
  }
}

export async function mem0SearchHybridContext(opts: {
  projectKey: string;
  issueIdentifier: string;
  query: string;
  intent?: string;
  stage?: string;
  maxPacks?: number;
  maxTokens?: number;
  appId?: string;
  runId?: string;
  agentId?: string;
}): Promise<HybridMemoryContextResult> {
  try {
    const relationQuery = isRelationshipQuery(opts.query);
    const appId = opts.appId ?? "xena";
    const baseQuery = [opts.query, opts.intent ? `intent:${opts.intent}` : "", opts.stage ? `stage:${opts.stage}` : ""]
      .filter((part) => part.length > 0)
      .join("\n");

    const laneConfigs: Array<{
      lane: HybridMemoryLane;
      namespace: MemoryNamespace;
      limit: number;
      query: string;
      metadataFilters?: Record<string, unknown>;
      importance: number;
      scopedToRun: boolean;
    }> = [
      {
        lane: "ticket_context",
        namespace: MEMORY_NAMESPACES.TICKET_CONTEXT,
        limit: 14,
        query: baseQuery,
        importance: 0.65,
        scopedToRun: true,
      },
      {
        lane: "decision_history",
        namespace: MEMORY_NAMESPACES.CODE_DECISIONS,
        limit: relationQuery ? 18 : 10,
        query: relationQuery ? `${baseQuery}\nfocus: strategy decisions and fallback transitions` : baseQuery,
        metadataFilters: { type: "decision" },
        importance: 0.9,
        scopedToRun: false,
      },
      {
        lane: "quality_history",
        namespace: MEMORY_NAMESPACES.QUALITY_SIGNALS,
        limit: relationQuery ? 18 : 10,
        query: relationQuery ? `${baseQuery}\nfocus: quality outcomes and failure patterns` : baseQuery,
        metadataFilters: { type: "quality_signal" },
        importance: 0.86,
        scopedToRun: false,
      },
      {
        lane: "research_history",
        namespace: MEMORY_NAMESPACES.RESEARCH_FINDINGS,
        limit: 8,
        query: baseQuery,
        metadataFilters: { type: "research_finding" },
        importance: 0.72,
        scopedToRun: false,
      },
      {
        lane: "user_preferences",
        namespace: MEMORY_NAMESPACES.USER_PREFERENCES,
        limit: 6,
        query: "xena user preferences profile defaults",
        metadataFilters: { type: "preference_profile" },
        importance: 0.95,
        scopedToRun: false,
      },
    ];

    const laneEntries = await Promise.all(
      laneConfigs.map(async (lane) => {
        const entries = await mem0SearchEntries({
          mem0: mem0(),
          query: lane.query,
          userId: userId(opts.projectKey),
          namespace: lane.namespace,
          limit: lane.limit,
          appId,
          runId: lane.scopedToRun ? opts.runId : undefined,
          agentId: lane.scopedToRun ? opts.agentId : undefined,
          metadataFilters: lane.metadataFilters,
        });
        return { lane, entries };
      }),
    );

    const packRows: Array<{ lane: HybridMemoryLane; pack: MemoryContextPack }> = [];
    for (const { lane, entries } of laneEntries) {
      for (const entry of entries) {
        const tagType = asString(entry.metadata.type) ?? "unknown";
        packRows.push({
          lane: lane.lane,
          pack: {
            id: entry.id ?? `${opts.issueIdentifier}:${lane.namespace}:${packRows.length + 1}`,
            namespace: lane.namespace,
            content: entry.memory,
            relevance: clamp(entry.score ?? 0.7, 0, 1),
            importance: lane.importance,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            tags: [opts.issueIdentifier, lane.lane, tagType],
            sourceRef: asString(entry.metadata.issue) ?? undefined,
          },
        });
      }
    }

    const selected = selectContextPacks(
      packRows.map((row) => row.pack),
      {
        maxPacks: opts.maxPacks ?? 14,
        maxTokens: opts.maxTokens ?? 2200,
        minScore: 0,
      },
    );

    const selectedIdSet = new Set(selected.selected.map((pack) => pack.id));
    const selectedRows = packRows.filter((row) => selectedIdSet.has(row.pack.id));

    const laneCounts = new Map<HybridMemoryLane, number>();
    for (const config of laneConfigs) laneCounts.set(config.lane, 0);
    for (const row of selectedRows) laneCounts.set(row.lane, (laneCounts.get(row.lane) ?? 0) + 1);

    const laneSnapshots: HybridMemoryLaneSnapshot[] = laneConfigs.map((config) => ({
      lane: config.lane,
      namespace: config.namespace,
      count: laneCounts.get(config.lane) ?? 0,
    }));

    const laneLabels: Record<HybridMemoryLane, string> = {
      ticket_context: "Ticket Context",
      decision_history: "Decision History",
      quality_history: "Quality History",
      research_history: "Research History",
      user_preferences: "User Preferences",
    };

    const sections: string[] = [];
    for (const lane of laneConfigs.map((config) => config.lane)) {
      const rows = selectedRows.filter((row) => row.lane === lane);
      if (rows.length === 0) continue;
      sections.push(`### ${laneLabels[lane]}`);
      for (const row of rows) sections.push(`- ${row.pack.content}`);
      sections.push("");
    }

    return {
      text: sections.join("\n").trim(),
      selected: selected.selected,
      totalTokens: selected.totalTokens,
      lanes: laneSnapshots,
    };
  } catch (err) {
    logger.warn({ err }, "mem0SearchHybridContext failed; continuing without hybrid context");
    return {
      text: "",
      selected: [],
      totalTokens: 0,
      lanes: [],
    };
  }
}

export async function mem0GetDecisionSignatures(opts: {
  projectKey: string;
  issueIdentifier: string;
  query?: string;
  stage?: string;
  intent?: string;
  limit?: number;
}): Promise<DecisionSignatureResult> {
  try {
    const query = [opts.query ?? "", opts.stage ? `stage:${opts.stage}` : "", opts.intent ? `intent:${opts.intent}` : ""]
      .filter((part) => part.length > 0)
      .join("\n");

    const preferredEntries = await mem0SearchEntries({
      mem0: mem0(),
      query: query || `${opts.issueIdentifier} adaptive decision signatures`,
      userId: userId(opts.projectKey),
      namespace: MEMORY_NAMESPACES.CODE_DECISIONS,
      appId: "xena",
      limit: opts.limit ?? 40,
      metadataFilters: { type: "decision" },
    });

    const entries =
      preferredEntries.length > 0
        ? preferredEntries
        : await mem0SearchEntries({
            mem0: mem0(),
            query: query || `${opts.issueIdentifier} adaptive decision signatures`,
            userId: userId(opts.projectKey),
            namespace: MEMORY_NAMESPACES.CODE_DECISIONS,
            appId: "xena",
            limit: opts.limit ?? 40,
          });

    const aggregate = new Map<
      string,
      {
        domain: string;
        selectedStrategy: string;
        triggerErrorKinds: string[];
        occurrences: number;
        lastSeenAt: string | null;
        qualitySum: number;
        qualityCount: number;
      }
    >();

    for (const entry of entries) {
      const domain =
        parseKeyValue(entry.memory, "domain") ??
        asString(entry.metadata.stage) ??
        asString(entry.metadata.intent) ??
        "unknown";
      const selectedStrategy =
        parseKeyValue(entry.memory, "selected_strategy") ??
        parseKeyValue(entry.memory, "selectedStrategy") ??
        asString(entry.metadata.selectedStrategy);
      if (!selectedStrategy) continue;

      const triggerErrorKinds = parseCsv(
        parseKeyValue(entry.memory, "trigger_error_kinds") ??
          parseKeyValue(entry.memory, "triggerErrorKinds") ??
          asString(entry.metadata.triggerErrorKinds),
      );

      const signatureKey = `${domain}|${selectedStrategy}|${triggerErrorKinds.join(",")}`;
      const existing = aggregate.get(signatureKey);
      const qualityScore = asNumber(entry.metadata.qualityScore) ?? asNumber(Number.parseFloat(parseKeyValue(entry.memory, "quality_score") ?? ""));
      const seenAt =
        entry.updatedAt ??
        entry.createdAt ??
        asString(entry.metadata.recordedAt) ??
        null;

      if (!existing) {
        aggregate.set(signatureKey, {
          domain,
          selectedStrategy,
          triggerErrorKinds,
          occurrences: 1,
          lastSeenAt: seenAt,
          qualitySum: qualityScore ?? 0,
          qualityCount: qualityScore === null ? 0 : 1,
        });
        continue;
      }

      existing.occurrences += 1;
      if (
        seenAt &&
        (!existing.lastSeenAt || Date.parse(seenAt) > Date.parse(existing.lastSeenAt))
      ) {
        existing.lastSeenAt = seenAt;
      }
      if (qualityScore !== null) {
        existing.qualitySum += qualityScore;
        existing.qualityCount += 1;
      }
    }

    const signatures: DecisionSignature[] = [...aggregate.entries()]
      .map(([key, value]) => ({
        key,
        domain: value.domain,
        selectedStrategy: value.selectedStrategy,
        triggerErrorKinds: value.triggerErrorKinds,
        occurrences: value.occurrences,
        lastSeenAt: value.lastSeenAt,
        avgQualityScore: value.qualityCount > 0 ? value.qualitySum / value.qualityCount : null,
      }))
      .sort((left, right) => {
        if (right.occurrences !== left.occurrences) return right.occurrences - left.occurrences;
        const rightSeen = right.lastSeenAt ? Date.parse(right.lastSeenAt) : Number.NEGATIVE_INFINITY;
        const leftSeen = left.lastSeenAt ? Date.parse(left.lastSeenAt) : Number.NEGATIVE_INFINITY;
        if (rightSeen !== leftSeen) return rightSeen - leftSeen;
        const rightQuality = right.avgQualityScore ?? Number.NEGATIVE_INFINITY;
        const leftQuality = left.avgQualityScore ?? Number.NEGATIVE_INFINITY;
        if (rightQuality !== leftQuality) return rightQuality - leftQuality;
        return left.key.localeCompare(right.key);
      })
      .slice(0, 8);

    const lines = signatures.map((signature) => {
      const quality = signature.avgQualityScore === null ? "n/a" : signature.avgQualityScore.toFixed(1);
      const triggers =
        signature.triggerErrorKinds.length > 0 ? signature.triggerErrorKinds.join(", ") : "none";
      return `- domain=${signature.domain}; strategy=${signature.selectedStrategy}; occurrences=${signature.occurrences}; trigger_error_kinds=${triggers}; avg_quality=${quality}; last_seen=${formatIsoDay(signature.lastSeenAt)}`;
    });

    return {
      signatures,
      text: lines.join("\n"),
    };
  } catch (err) {
    logger.warn({ err }, "mem0GetDecisionSignatures failed; continuing without signatures");
    return {
      signatures: [],
      text: "",
    };
  }
}

export async function mem0DistillMemorySnapshot(opts: {
  projectKey: string;
  issueIdentifier: string;
  query: string;
  stage: string;
  intent: string;
  runId?: string;
}): Promise<{ summary: string; recorded: boolean }> {
  try {
    const signatures = await mem0GetDecisionSignatures({
      projectKey: opts.projectKey,
      issueIdentifier: opts.issueIdentifier,
      query: opts.query,
      stage: opts.stage,
      intent: opts.intent,
      limit: 40,
    });
    const hybrid = await mem0SearchHybridContext({
      projectKey: opts.projectKey,
      issueIdentifier: opts.issueIdentifier,
      query: opts.query,
      stage: opts.stage,
      intent: opts.intent,
      runId: opts.runId,
      appId: "xena",
      maxPacks: 14,
      maxTokens: 2200,
    });

    const laneSummary = hybrid.lanes
      .filter((lane) => lane.count > 0)
      .map((lane) => `${lane.lane}:${lane.count}`)
      .join(", ");

    const topSignatures = signatures.signatures
      .slice(0, 3)
      .map((signature) => {
        const quality = signature.avgQualityScore === null ? "n/a" : signature.avgQualityScore.toFixed(1);
        return `- ${signature.domain} -> ${signature.selectedStrategy} (x${signature.occurrences}, quality=${quality})`;
      });

    const summary = [
      "[memory_distillation_v1]",
      `issue: ${opts.issueIdentifier}`,
      `stage: ${opts.stage}`,
      `intent: ${opts.intent}`,
      `lane_coverage: ${laneSummary || "none"}`,
      `hybrid_tokens: ${hybrid.totalTokens}`,
      "top_decision_signatures:",
      ...(topSignatures.length > 0 ? topSignatures : ["- none"]),
      `captured_at: ${new Date().toISOString()}`,
    ].join("\n");

    await mem0Add({
      projectKey: opts.projectKey,
      issueIdentifier: opts.issueIdentifier,
      namespace: MEMORY_NAMESPACES.WORKFLOW_STATE,
      content: summary,
      type: "event",
      intent: "memory_distillation_snapshot",
      stage: opts.stage,
      outcome: "updated",
      source: "activity.mem0.distill",
      runId: opts.runId,
      agentId: "activity.mem0",
      appId: "xena",
      infer: false,
      enableGraph: false,
      tags: ["memory", "distillation", "snapshot"],
      metadata: {
        distillVersion: "v1",
        signatureCount: signatures.signatures.length,
        hybridTokens: hybrid.totalTokens,
      },
    });

    return { summary, recorded: true };
  } catch (err) {
    logger.warn({ err }, "mem0DistillMemorySnapshot failed; continuing without distillation snapshot");
    return { summary: "", recorded: false };
  }
}

export async function mem0ApplyRetentionPolicy(opts: {
  projectKey: string;
  issueIdentifier?: string;
  runId?: string;
  dryRun?: boolean;
  appId?: string;
  agentId?: string;
}): Promise<MemoryRetentionResult> {
  const issueIdentifier = opts.issueIdentifier?.trim() || `MEMORY-${opts.projectKey.toUpperCase()}`;
  const dryRun = opts.dryRun === true;
  const namespaces: MemoryRetentionNamespaceResult[] = [];
  let scanned = 0;
  let candidates = 0;
  let archived = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;
  const nowMs = Date.now();

  for (const rule of MEMORY_RETENTION_RULES) {
    const nsResult: MemoryRetentionNamespaceResult = {
      namespace: rule.namespace,
      scanned: 0,
      candidates: 0,
      archived: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
    };

    try {
      const entries = await listEntriesForNamespace({
        projectKey: opts.projectKey,
        namespace: rule.namespace,
        appId: opts.appId,
      });
      nsResult.scanned = entries.length;
      const ruleConfig = getMemoryRetentionRule(rule.namespace);
      const candidateRows = identifyRetentionCandidates({
        entries,
        rule: ruleConfig,
        nowMs,
      });
      nsResult.candidates = candidateRows.length;
      nsResult.skipped = Math.max(0, nsResult.scanned - nsResult.candidates);

      for (const candidate of candidateRows) {
        try {
          if (dryRun) {
            if (ruleConfig.action === "archive_then_delete") {
              nsResult.archived += 1;
              nsResult.deleted += 1;
            } else if (ruleConfig.action === "delete_only") {
              nsResult.deleted += 1;
            } else {
              nsResult.skipped += 1;
            }
            continue;
          }

          if (ruleConfig.action === "archive_then_delete") {
            await mem0Add({
              projectKey: opts.projectKey,
              issueIdentifier,
              namespace: MEMORY_NAMESPACES.WORKFLOW_STATE,
              content: [
                "[memory_archive_v1]",
                `source_namespace: ${rule.namespace}`,
                `source_memory_id: ${candidate.id}`,
                `reason: ${candidate.reason}`,
                `source_type: ${metadataType(candidate)}`,
                `source_intent: ${metadataIntent(candidate)}`,
                `source_created_at: ${candidate.createdAt ?? "unknown"}`,
                `source_updated_at: ${candidate.updatedAt ?? "unknown"}`,
                `source_excerpt: ${toMemoryExcerpt(candidate.memory)}`,
                `archived_at: ${nowIso()}`,
              ].join("\n"),
              type: "event",
              intent: "memory_retention_archive",
              stage: "maintenance",
              outcome: "updated",
              source: "activity.mem0.retention",
              runId: opts.runId,
              agentId: opts.agentId ?? "activity.mem0",
              appId: opts.appId ?? "xena",
              infer: false,
              enableGraph: false,
              tags: ["memory", "retention", "archive", rule.namespace],
              metadata: {
                archivedMemoryId: candidate.id,
                sourceNamespace: rule.namespace,
                reason: candidate.reason,
                retentionAction: ruleConfig.action,
                retentionDryRun: dryRun,
              },
            });
            nsResult.archived += 1;
          }

          if (ruleConfig.action === "archive_then_delete" || ruleConfig.action === "delete_only") {
            await mem0DeleteImpl({
              mem0: mem0(),
              memoryId: candidate.id,
            });
            nsResult.deleted += 1;
          }
        } catch (err) {
          nsResult.errors += 1;
          logger.warn(
            {
              err,
              namespace: rule.namespace,
              memoryId: candidate.id,
              reason: candidate.reason,
              dryRun,
            },
            "mem0 retention action failed for memory entry",
          );
        }
      }
    } catch (err) {
      nsResult.errors += 1;
      logger.warn({ err, namespace: rule.namespace, dryRun }, "mem0 retention namespace scan failed");
    }

    scanned += nsResult.scanned;
    candidates += nsResult.candidates;
    archived += nsResult.archived;
    deleted += nsResult.deleted;
    skipped += nsResult.skipped;
    errors += nsResult.errors;
    namespaces.push(nsResult);
  }

  const summary = [
    "[memory_retention_v1]",
    `dry_run: ${dryRun}`,
    `scanned: ${scanned}`,
    `candidates: ${candidates}`,
    `archived: ${archived}`,
    `deleted: ${deleted}`,
    `skipped: ${skipped}`,
    `errors: ${errors}`,
    "namespaces:",
    ...namespaces.map(
      (ns) =>
        `- ${ns.namespace}: scanned=${ns.scanned}; candidates=${ns.candidates}; archived=${ns.archived}; deleted=${ns.deleted}; skipped=${ns.skipped}; errors=${ns.errors}`,
    ),
    `captured_at: ${nowIso()}`,
  ].join("\n");

  await mem0Add({
    projectKey: opts.projectKey,
    issueIdentifier,
    namespace: MEMORY_NAMESPACES.WORKFLOW_STATE,
    content: summary,
    type: "event",
    intent: "memory_retention_run",
    stage: "maintenance",
    outcome: errors > 0 ? "blocked" : "updated",
    source: "activity.mem0.retention",
    runId: opts.runId,
    agentId: opts.agentId ?? "activity.mem0",
    appId: opts.appId ?? "xena",
    infer: false,
    enableGraph: false,
    tags: ["memory", "retention", dryRun ? "dry-run" : "applied"],
    metadata: {
      retentionVersion: "v1",
      dryRun,
      scanned,
      candidates,
      archived,
      deleted,
      skipped,
      errors,
      rules: MEMORY_RETENTION_RULES.map((rule) => ({
        namespace: rule.namespace,
        action: rule.action,
        retainDays: rule.retainDays,
        maxEntries: rule.maxEntries,
      })),
    },
  });

  return {
    dryRun,
    scanned,
    candidates,
    archived,
    deleted,
    skipped,
    errors,
    summary,
    namespaces,
  };
}

export async function mem0GetUserPreferences(opts: { projectKey: string }): Promise<UserPreferencesProfile> {
  try {
    const preferredEntries = await mem0SearchEntries({
      mem0: mem0(),
      query: "xena user preferences profile defaults",
      userId: userId(opts.projectKey),
      limit: 25,
      namespace: MEMORY_NAMESPACES.USER_PREFERENCES,
      appId: "xena",
      metadataFilters: {
        type: "preference_profile",
      },
    });
    const entries =
      preferredEntries.length > 0
        ? preferredEntries
        : await mem0SearchEntries({
            mem0: mem0(),
            query: "xena user preferences profile defaults",
            userId: userId(opts.projectKey),
            limit: 25,
            namespace: MEMORY_NAMESPACES.USER_PREFERENCES,
            appId: "xena",
          });

    entries.sort((left, right) => {
      const rightTs = Math.max(timestampMs(right.updatedAt), timestampMs(right.createdAt));
      const leftTs = Math.max(timestampMs(left.updatedAt), timestampMs(left.createdAt));
      return rightTs - leftTs;
    });

    for (const entry of entries) {
      const parsed = parseUserPreferencesFromMemoryContent(entry.memory);
      if (parsed) return parsed;
    }

    return cloneUserPreferences(DEFAULT_USER_PREFERENCES);
  } catch (err) {
    logger.warn({ err }, "mem0GetUserPreferences failed; continuing with defaults");
    return cloneUserPreferences(DEFAULT_USER_PREFERENCES);
  }
}

export async function mem0Add(opts: {
  projectKey: string;
  issueIdentifier: string;
  content: string;
  namespace?: string;
  type?: MemoryRecordType;
  intent?: string;
  stage?: string;
  outcome?: MemoryRecordOutcome;
  source?: string;
  runId?: string;
  agentId?: string;
  appId?: string;
  confidence?: number;
  qualityScore?: number;
  playbookId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  infer?: boolean;
  enableGraph?: boolean;
}): Promise<void> {
  try {
    const namespace: MemoryNamespace =
      typeof opts.namespace === "string" && isMemoryNamespace(opts.namespace)
        ? opts.namespace
        : MEMORY_NAMESPACES.TICKET_CONTEXT;
    const enableGraph = typeof opts.enableGraph === "boolean" ? opts.enableGraph : shouldEnableGraphDefault(namespace);
    const infer = typeof opts.infer === "boolean" ? opts.infer : shouldInferDefault(namespace, enableGraph);

    const normalizedTags =
      opts.tags
        ?.map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .slice(0, 24) ?? [];

    await mem0AddImpl({
      mem0: mem0(),
      content: opts.content,
      userId: userId(opts.projectKey),
      metadata: {
        type: opts.type ?? "workflow_artifact",
        intent: opts.intent,
        stage: opts.stage,
        outcome: opts.outcome,
        source: opts.source,
        confidence:
          typeof opts.confidence === "number" && Number.isFinite(opts.confidence)
            ? clamp(opts.confidence, 0, 1)
            : undefined,
        qualityScore:
          typeof opts.qualityScore === "number" && Number.isFinite(opts.qualityScore)
            ? clamp(opts.qualityScore, 0, 100)
            : undefined,
        playbookId: typeof opts.playbookId === "string" && opts.playbookId.trim().length > 0 ? opts.playbookId.trim() : undefined,
        tags: normalizedTags,
        recordedAt: new Date().toISOString(),
        issue: opts.issueIdentifier,
        project: opts.projectKey,
        ...(opts.metadata ?? {}),
      },
      namespace,
      infer,
      enableGraph,
      runId: opts.runId,
      agentId: opts.agentId,
      appId: opts.appId,
    });
  } catch (err) {
    logger.warn({ err }, "mem0Add failed; continuing");
  }
}
