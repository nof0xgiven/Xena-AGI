import {
  TRUST_EVENT_PROFILES,
  TRUST_SCORE_DEFAULTS,
  type TrustEvent,
  type TrustEventType,
  type TrustScoreBreakdownItem,
  type TrustScoreSnapshot,
} from "./events.js";

const MS_PER_DAY = 86_400_000;

export type TrustScoreComputationOptions = {
  baseline?: number;
  minScore?: number;
  maxScore?: number;
  halfLifeDays?: number;
  now?: Date;
  typeWeights?: Partial<Record<TrustEventType, number>>;
};

export type TrustBand = "low" | "guarded" | "high";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveEventWeight(
  event: TrustEvent,
  overrides: Partial<Record<TrustEventType, number>>,
): number {
  if (isFiniteNumber(event.weightOverride)) return event.weightOverride;
  const override = overrides[event.type];
  if (isFiniteNumber(override)) return override;
  return TRUST_EVENT_PROFILES[event.type].weight;
}

export function classifyTrustBand(score: number): TrustBand {
  if (score < 40) return "low";
  if (score < 70) return "guarded";
  return "high";
}

export function computeTrustScore(
  workflowId: string,
  events: readonly TrustEvent[],
  options: TrustScoreComputationOptions = {},
): TrustScoreSnapshot {
  const baseline = options.baseline ?? TRUST_SCORE_DEFAULTS.baseline;
  const minScore = options.minScore ?? TRUST_SCORE_DEFAULTS.min;
  const maxScore = options.maxScore ?? TRUST_SCORE_DEFAULTS.max;
  const halfLifeDays = clamp(options.halfLifeDays ?? TRUST_SCORE_DEFAULTS.halfLifeDays, 1, 365);
  const halfLifeMs = halfLifeDays * MS_PER_DAY;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  const breakdownByType = new Map<TrustEventType, { count: number; contribution: number }>();

  let positiveEventCount = 0;
  let negativeEventCount = 0;
  let neutralEventCount = 0;
  let ignoredEventCount = 0;
  let validEventCount = 0;
  let contributionTotal = 0;
  let recencyFactorTotal = 0;
  let earliestMs: number | null = null;
  let latestMs: number | null = null;

  for (const event of events) {
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) {
      ignoredEventCount += 1;
      continue;
    }

    validEventCount += 1;
    earliestMs = earliestMs === null ? occurredMs : Math.min(earliestMs, occurredMs);
    latestMs = latestMs === null ? occurredMs : Math.max(latestMs, occurredMs);

    const ageMs = Math.max(0, nowMs - occurredMs);
    const recencyFactor = Math.pow(0.5, ageMs / halfLifeMs);
    recencyFactorTotal += recencyFactor;

    const profile = TRUST_EVENT_PROFILES[event.type];
    if (profile.polarity === "positive") positiveEventCount += 1;
    if (profile.polarity === "negative") negativeEventCount += 1;
    if (profile.polarity === "neutral") neutralEventCount += 1;

    const weight = resolveEventWeight(event, options.typeWeights ?? {});
    const multiplier = clamp(event.value ?? 1, 0, 10);
    const contribution = weight * multiplier * recencyFactor;

    contributionTotal += contribution;

    const next = breakdownByType.get(event.type) ?? { count: 0, contribution: 0 };
    next.count += 1;
    next.contribution += contribution;
    breakdownByType.set(event.type, next);
  }

  const depthConfidence = 1 - Math.exp(-validEventCount / 8);
  const freshnessConfidence = validEventCount > 0 ? recencyFactorTotal / validEventCount : 0;
  const confidence = round(clamp(depthConfidence * 0.65 + freshnessConfidence * 0.35, 0, 1), 4);

  const score = round(clamp(baseline + contributionTotal, minScore, maxScore), 2);

  const breakdown: TrustScoreBreakdownItem[] = Array.from(breakdownByType.entries())
    .map(([type, value]) => ({
      type,
      count: value.count,
      contribution: round(value.contribution, 4),
    }))
    .sort(
      (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.type.localeCompare(b.type),
    );

  return {
    workflowId,
    score,
    baseline,
    confidence,
    eventCount: validEventCount,
    positiveEventCount,
    negativeEventCount,
    neutralEventCount,
    ignoredEventCount,
    windowStartAt: earliestMs === null ? null : new Date(earliestMs).toISOString(),
    windowEndAt: latestMs === null ? null : new Date(latestMs).toISOString(),
    computedAt: now.toISOString(),
    breakdown,
  };
}
