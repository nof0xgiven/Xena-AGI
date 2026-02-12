export const TRUST_EVENTS_FILENAME = "trust-events.jsonl" as const;

export const TRUST_SCORE_DEFAULTS = {
  min: 0,
  max: 100,
  baseline: 50,
  halfLifeDays: 21,
} as const;

export const TRUST_EVENT_TYPES = [
  "planning.accepted",
  "planning.rejected",
  "execution.completed",
  "execution.failed",
  "tests.passed",
  "tests.failed",
  "review.approved",
  "review.changes_requested",
  "research.source_verified",
  "research.source_invalid",
  "smoke.passed",
  "smoke.failed",
  "rollback.triggered",
  "manual.boost",
  "manual.penalty",
] as const;

export type TrustEventType = (typeof TRUST_EVENT_TYPES)[number];

export type TrustEventPolarity = "positive" | "negative" | "neutral";

export type TrustActor = "system" | "agent" | "human";

export type TrustEventMetadataValue = string | number | boolean | null;

export type TrustEventMetadata = Readonly<Record<string, TrustEventMetadataValue>>;

export type TrustEventProfile = {
  weight: number;
  polarity: TrustEventPolarity;
  description: string;
};

export const TRUST_EVENT_PROFILES = {
  "planning.accepted": {
    weight: 3,
    polarity: "positive",
    description: "Execution plan accepted without rework.",
  },
  "planning.rejected": {
    weight: -4,
    polarity: "negative",
    description: "Execution plan rejected or major rework requested.",
  },
  "execution.completed": {
    weight: 4,
    polarity: "positive",
    description: "Assigned implementation completed successfully.",
  },
  "execution.failed": {
    weight: -5,
    polarity: "negative",
    description: "Execution failed before completion.",
  },
  "tests.passed": {
    weight: 5,
    polarity: "positive",
    description: "Validation checks passed.",
  },
  "tests.failed": {
    weight: -6,
    polarity: "negative",
    description: "Validation checks failed.",
  },
  "review.approved": {
    weight: 4,
    polarity: "positive",
    description: "Code review approved with no blocking findings.",
  },
  "review.changes_requested": {
    weight: -4,
    polarity: "negative",
    description: "Code review requested changes.",
  },
  "research.source_verified": {
    weight: 2,
    polarity: "positive",
    description: "Research source was verified as valid and relevant.",
  },
  "research.source_invalid": {
    weight: -2,
    polarity: "negative",
    description: "Research source was invalid or unreliable.",
  },
  "smoke.passed": {
    weight: 5,
    polarity: "positive",
    description: "Smoke validation passed in runtime-like checks.",
  },
  "smoke.failed": {
    weight: -7,
    polarity: "negative",
    description: "Smoke validation failed.",
  },
  "rollback.triggered": {
    weight: -10,
    polarity: "negative",
    description: "Rollback or emergency remediation was required.",
  },
  "manual.boost": {
    weight: 3,
    polarity: "neutral",
    description: "Explicit trust uplift by a human operator.",
  },
  "manual.penalty": {
    weight: -3,
    polarity: "neutral",
    description: "Explicit trust penalty by a human operator.",
  },
} as const satisfies Record<TrustEventType, TrustEventProfile>;

export type TrustEvent = {
  id: string;
  workflowId: string;
  type: TrustEventType;
  actor: TrustActor;
  occurredAt: string;
  value?: number;
  weightOverride?: number;
  note?: string;
  metadata?: TrustEventMetadata;
};

export type TrustEventInput = {
  type: TrustEventType;
  actor?: TrustActor;
  occurredAt?: string;
  value?: number;
  weightOverride?: number;
  note?: string;
  metadata?: TrustEventMetadata;
};

export type TrustScoreBreakdownItem = {
  type: TrustEventType;
  count: number;
  contribution: number;
};

export type TrustScoreSnapshot = {
  workflowId: string;
  score: number;
  baseline: number;
  confidence: number;
  eventCount: number;
  positiveEventCount: number;
  negativeEventCount: number;
  neutralEventCount: number;
  ignoredEventCount: number;
  windowStartAt: string | null;
  windowEndAt: string | null;
  computedAt: string;
  breakdown: TrustScoreBreakdownItem[];
};

const TRUST_EVENT_TYPE_SET = new Set<TrustEventType>(TRUST_EVENT_TYPES);

export function isTrustEventType(value: string): value is TrustEventType {
  return TRUST_EVENT_TYPE_SET.has(value as TrustEventType);
}

export function isTrustActor(value: string): value is TrustActor {
  return value === "system" || value === "agent" || value === "human";
}
