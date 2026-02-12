import { MATRIX_POLICIES as rawMatrixPolicy } from "../../config/matrix-policies.js";

export type DiscoveryStrategyId = "teddy-default" | "teddy-gpt-oss" | "codex-exec";
export type DiscoveryStrategyFamily = "teddy" | "codex";
export type DiscoveryErrorKind =
  | "cli_not_found"
  | "auth_or_permission"
  | "model_unavailable"
  | "token_limit"
  | "rate_limited"
  | "timeout"
  | "provider_bad_request"
  | "nonzero_exit"
  | "unknown";

export type PlanStrategyId = "codex-direct" | "codex-recursive" | "teddy-direct";
export type PlanStrategyFamily = "direct" | "recursive" | "alt_model";
export type PlanErrorKind =
  | "cli_not_found"
  | "auth_or_permission"
  | "model_unavailable"
  | "token_limit"
  | "rate_limited"
  | "timeout"
  | "provider_bad_request"
  | "nonzero_exit"
  | "quality_low"
  | "invalid_output"
  | "unknown";

export type CodeStrategyId = "codex-exec" | "codex-exec-patch" | "teddy-exec";
export type CodeStrategyFamily = "codex" | "teddy";
export type CodeErrorKind =
  | "cli_not_found"
  | "auth_or_permission"
  | "model_unavailable"
  | "token_limit"
  | "rate_limited"
  | "timeout"
  | "provider_bad_request"
  | "nonzero_exit"
  | "invalid_output"
  | "no_changes"
  | "unknown";

export type ReviewStrategyId = "codex-review-loop" | "codex-review-loop-focused" | "teddy-review-loop";
export type ReviewStrategyFamily = "codex" | "teddy";
export type ReviewErrorKind =
  | "cli_not_found"
  | "auth_or_permission"
  | "model_unavailable"
  | "token_limit"
  | "rate_limited"
  | "timeout"
  | "provider_bad_request"
  | "nonzero_exit"
  | "invalid_output"
  | "p0_p1_unresolved"
  | "unknown";

export type CommunicationStrategyId = "email-semantic" | "email-attachment-aware";
export type CommunicationStrategyFamily = "semantic" | "attachment";
export type CommunicationErrorKind =
  | "cli_not_found"
  | "auth_or_permission"
  | "model_unavailable"
  | "token_limit"
  | "rate_limited"
  | "timeout"
  | "provider_bad_request"
  | "nonzero_exit"
  | "invalid_output"
  | "low_confidence"
  | "attachment_unavailable"
  | "research_failed"
  | "unknown";

export type DiscoveryStrategyDefinition = {
  id: DiscoveryStrategyId;
  name: string;
  family: DiscoveryStrategyFamily;
  toolId: string;
};

export type PlanStrategyDefinition = {
  id: PlanStrategyId;
  name: string;
  family: PlanStrategyFamily;
  toolId: string;
};

export type CodeStrategyDefinition = {
  id: CodeStrategyId;
  name: string;
  family: CodeStrategyFamily;
  toolId: string;
};

export type ReviewStrategyDefinition = {
  id: ReviewStrategyId;
  name: string;
  family: ReviewStrategyFamily;
  reviewToolId: string;
  revisionToolId: string;
};

export type CommunicationStrategyDefinition = {
  id: CommunicationStrategyId;
  name: string;
  family: CommunicationStrategyFamily;
  toolId: string;
};

type NonzeroExitRetry<ErrorKind extends string> = {
  enabled: boolean;
  errorKind: ErrorKind;
};

export type DiscoveryStagePolicy = {
  maxAttemptsTotal: number;
  maxAttemptsPerFamily: number;
  forceFamilySwitchErrorKinds: readonly DiscoveryErrorKind[];
  fallbackOrder: readonly DiscoveryStrategyId[];
  fallbackOrderOnFamilySwitch: readonly DiscoveryStrategyId[];
  nonzeroExitRetry: NonzeroExitRetry<DiscoveryErrorKind>;
  strategies: Record<DiscoveryStrategyId, DiscoveryStrategyDefinition>;
  matrix: Record<DiscoveryErrorKind, readonly DiscoveryStrategyId[]>;
};

export type PlanStagePolicy = {
  maxAttemptsTotal: number;
  maxAttemptsPerFamily: number;
  maxRecursionDepth: number;
  maxRecursiveBranches: number;
  qualityPassThreshold: number;
  forceFamilySwitchErrorKinds: readonly PlanErrorKind[];
  fallbackOrder: readonly PlanStrategyId[];
  fallbackOrderOnFamilySwitch: readonly PlanStrategyId[];
  nonzeroExitRetry: NonzeroExitRetry<PlanErrorKind>;
  strategies: Record<PlanStrategyId, PlanStrategyDefinition>;
  matrix: Record<PlanErrorKind, readonly PlanStrategyId[]>;
};

export type CodeStagePolicy = {
  maxAttemptsTotal: number;
  maxAttemptsPerFamily: number;
  forceFamilySwitchErrorKinds: readonly CodeErrorKind[];
  fallbackOrder: readonly CodeStrategyId[];
  fallbackOrderOnFamilySwitch: readonly CodeStrategyId[];
  nonzeroExitRetry: NonzeroExitRetry<CodeErrorKind>;
  strategies: Record<CodeStrategyId, CodeStrategyDefinition>;
  matrix: Record<CodeErrorKind, readonly CodeStrategyId[]>;
};

export type ReviewStagePolicy = {
  maxAttemptsTotal: number;
  maxAttemptsPerFamily: number;
  maxRevisionsPerStrategy: number;
  forceFamilySwitchErrorKinds: readonly ReviewErrorKind[];
  fallbackOrder: readonly ReviewStrategyId[];
  fallbackOrderOnFamilySwitch: readonly ReviewStrategyId[];
  nonzeroExitRetry: NonzeroExitRetry<ReviewErrorKind>;
  strategies: Record<ReviewStrategyId, ReviewStrategyDefinition>;
  matrix: Record<ReviewErrorKind, readonly ReviewStrategyId[]>;
};

export type CommunicationStagePolicy = {
  maxAttemptsTotal: number;
  maxAttemptsPerFamily: number;
  forceFamilySwitchErrorKinds: readonly CommunicationErrorKind[];
  fallbackOrder: readonly CommunicationStrategyId[];
  fallbackOrderOnFamilySwitch: readonly CommunicationStrategyId[];
  nonzeroExitRetry: NonzeroExitRetry<CommunicationErrorKind>;
  strategies: Record<CommunicationStrategyId, CommunicationStrategyDefinition>;
  matrix: Record<CommunicationErrorKind, readonly CommunicationStrategyId[]>;
};

type MatrixPolicyConfig = {
  version: string;
  stages: {
    discover: DiscoveryStagePolicy;
    plan: PlanStagePolicy;
    code: CodeStagePolicy;
    review: ReviewStagePolicy;
    communication: CommunicationStagePolicy;
  };
};

const DISCOVERY_STRATEGY_IDS: readonly DiscoveryStrategyId[] = ["teddy-default", "teddy-gpt-oss", "codex-exec"];
const DISCOVERY_STRATEGY_FAMILIES: readonly DiscoveryStrategyFamily[] = ["teddy", "codex"];
const DISCOVERY_ERROR_KINDS: readonly DiscoveryErrorKind[] = [
  "cli_not_found",
  "auth_or_permission",
  "model_unavailable",
  "token_limit",
  "rate_limited",
  "timeout",
  "provider_bad_request",
  "nonzero_exit",
  "unknown",
];

const PLAN_STRATEGY_IDS: readonly PlanStrategyId[] = ["codex-direct", "codex-recursive", "teddy-direct"];
const PLAN_STRATEGY_FAMILIES: readonly PlanStrategyFamily[] = ["direct", "recursive", "alt_model"];
const PLAN_ERROR_KINDS: readonly PlanErrorKind[] = [
  "cli_not_found",
  "auth_or_permission",
  "model_unavailable",
  "token_limit",
  "rate_limited",
  "timeout",
  "provider_bad_request",
  "nonzero_exit",
  "quality_low",
  "invalid_output",
  "unknown",
];

const CODE_STRATEGY_IDS: readonly CodeStrategyId[] = ["codex-exec", "codex-exec-patch", "teddy-exec"];
const CODE_STRATEGY_FAMILIES: readonly CodeStrategyFamily[] = ["codex", "teddy"];
const CODE_ERROR_KINDS: readonly CodeErrorKind[] = [
  "cli_not_found",
  "auth_or_permission",
  "model_unavailable",
  "token_limit",
  "rate_limited",
  "timeout",
  "provider_bad_request",
  "nonzero_exit",
  "invalid_output",
  "no_changes",
  "unknown",
];

const REVIEW_STRATEGY_IDS: readonly ReviewStrategyId[] = [
  "codex-review-loop",
  "codex-review-loop-focused",
  "teddy-review-loop",
];
const REVIEW_STRATEGY_FAMILIES: readonly ReviewStrategyFamily[] = ["codex", "teddy"];
const REVIEW_ERROR_KINDS: readonly ReviewErrorKind[] = [
  "cli_not_found",
  "auth_or_permission",
  "model_unavailable",
  "token_limit",
  "rate_limited",
  "timeout",
  "provider_bad_request",
  "nonzero_exit",
  "invalid_output",
  "p0_p1_unresolved",
  "unknown",
];

const COMMUNICATION_STRATEGY_IDS: readonly CommunicationStrategyId[] = [
  "email-semantic",
  "email-attachment-aware",
];
const COMMUNICATION_STRATEGY_FAMILIES: readonly CommunicationStrategyFamily[] = ["semantic", "attachment"];
const COMMUNICATION_ERROR_KINDS: readonly CommunicationErrorKind[] = [
  "cli_not_found",
  "auth_or_permission",
  "model_unavailable",
  "token_limit",
  "rate_limited",
  "timeout",
  "provider_bad_request",
  "nonzero_exit",
  "invalid_output",
  "low_confidence",
  "attachment_unavailable",
  "research_failed",
  "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid matrix policy field "${field}": expected positive integer.`);
  }
  return value;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid matrix policy field "${field}": expected non-empty string.`);
  }
  return value;
}

function asEnumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid matrix policy field "${field}": expected one of [${allowed.join(", ")}].`);
  }
  return value as T;
}

function asEnumArray<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid matrix policy field "${field}": expected non-empty array.`);
  }
  return value.map((item, index) => asEnumValue(item, allowed, `${field}[${index}]`));
}

function parseMatrix<TError extends string, TStrategy extends string>(
  value: unknown,
  errorKinds: readonly TError[],
  strategyIds: readonly TStrategy[],
  field: string,
): Record<TError, readonly TStrategy[]> {
  if (!isRecord(value)) {
    throw new Error(`Invalid matrix policy field "${field}": expected object.`);
  }
  const out = {} as Record<TError, readonly TStrategy[]>;
  for (const errorKind of errorKinds) {
    const entry = value[errorKind];
    if (!Array.isArray(entry) || entry.length === 0) {
      throw new Error(`Matrix policy missing "${field}.${errorKind}" strategy list.`);
    }
    out[errorKind] = entry.map((strategyId, index) =>
      asEnumValue(strategyId, strategyIds, `${field}.${errorKind}[${index}]`),
    );
  }
  return out;
}

function parseDiscoveryStrategies(value: unknown): Record<DiscoveryStrategyId, DiscoveryStrategyDefinition> {
  if (!Array.isArray(value)) {
    throw new Error('Invalid matrix policy field "stages.discover.strategies": expected array.');
  }
  const out = {} as Record<DiscoveryStrategyId, DiscoveryStrategyDefinition>;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new Error(`Invalid stages.discover.strategies[${index}]: expected object.`);
    }
    const id = asEnumValue(item.id, DISCOVERY_STRATEGY_IDS, `stages.discover.strategies[${index}].id`);
    out[id] = {
      id,
      name: asNonEmptyString(item.name, `stages.discover.strategies[${index}].name`),
      family: asEnumValue(
        item.family,
        DISCOVERY_STRATEGY_FAMILIES,
        `stages.discover.strategies[${index}].family`,
      ),
      toolId: asNonEmptyString(item.toolId, `stages.discover.strategies[${index}].toolId`),
    };
  }
  for (const id of DISCOVERY_STRATEGY_IDS) {
    if (!out[id]) throw new Error(`Matrix policy missing discovery strategy "${id}".`);
  }
  return out;
}

function parsePlanStrategies(value: unknown): Record<PlanStrategyId, PlanStrategyDefinition> {
  if (!Array.isArray(value)) {
    throw new Error('Invalid matrix policy field "stages.plan.strategies": expected array.');
  }
  const out = {} as Record<PlanStrategyId, PlanStrategyDefinition>;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new Error(`Invalid stages.plan.strategies[${index}]: expected object.`);
    }
    const id = asEnumValue(item.id, PLAN_STRATEGY_IDS, `stages.plan.strategies[${index}].id`);
    out[id] = {
      id,
      name: asNonEmptyString(item.name, `stages.plan.strategies[${index}].name`),
      family: asEnumValue(item.family, PLAN_STRATEGY_FAMILIES, `stages.plan.strategies[${index}].family`),
      toolId: asNonEmptyString(item.toolId, `stages.plan.strategies[${index}].toolId`),
    };
  }
  for (const id of PLAN_STRATEGY_IDS) {
    if (!out[id]) throw new Error(`Matrix policy missing plan strategy "${id}".`);
  }
  return out;
}

function parseCodeStrategies(value: unknown): Record<CodeStrategyId, CodeStrategyDefinition> {
  if (!Array.isArray(value)) {
    throw new Error('Invalid matrix policy field "stages.code.strategies": expected array.');
  }
  const out = {} as Record<CodeStrategyId, CodeStrategyDefinition>;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new Error(`Invalid stages.code.strategies[${index}]: expected object.`);
    }
    const id = asEnumValue(item.id, CODE_STRATEGY_IDS, `stages.code.strategies[${index}].id`);
    out[id] = {
      id,
      name: asNonEmptyString(item.name, `stages.code.strategies[${index}].name`),
      family: asEnumValue(item.family, CODE_STRATEGY_FAMILIES, `stages.code.strategies[${index}].family`),
      toolId: asNonEmptyString(item.toolId, `stages.code.strategies[${index}].toolId`),
    };
  }
  for (const id of CODE_STRATEGY_IDS) {
    if (!out[id]) throw new Error(`Matrix policy missing code strategy "${id}".`);
  }
  return out;
}

function parseReviewStrategies(value: unknown): Record<ReviewStrategyId, ReviewStrategyDefinition> {
  if (!Array.isArray(value)) {
    throw new Error('Invalid matrix policy field "stages.review.strategies": expected array.');
  }
  const out = {} as Record<ReviewStrategyId, ReviewStrategyDefinition>;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new Error(`Invalid stages.review.strategies[${index}]: expected object.`);
    }
    const id = asEnumValue(item.id, REVIEW_STRATEGY_IDS, `stages.review.strategies[${index}].id`);
    out[id] = {
      id,
      name: asNonEmptyString(item.name, `stages.review.strategies[${index}].name`),
      family: asEnumValue(item.family, REVIEW_STRATEGY_FAMILIES, `stages.review.strategies[${index}].family`),
      reviewToolId: asNonEmptyString(item.reviewToolId, `stages.review.strategies[${index}].reviewToolId`),
      revisionToolId: asNonEmptyString(item.revisionToolId, `stages.review.strategies[${index}].revisionToolId`),
    };
  }
  for (const id of REVIEW_STRATEGY_IDS) {
    if (!out[id]) throw new Error(`Matrix policy missing review strategy "${id}".`);
  }
  return out;
}

function parseCommunicationStrategies(value: unknown): Record<CommunicationStrategyId, CommunicationStrategyDefinition> {
  if (!Array.isArray(value)) {
    throw new Error('Invalid matrix policy field "stages.communication.strategies": expected array.');
  }
  const out = {} as Record<CommunicationStrategyId, CommunicationStrategyDefinition>;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new Error(`Invalid stages.communication.strategies[${index}]: expected object.`);
    }
    const id = asEnumValue(item.id, COMMUNICATION_STRATEGY_IDS, `stages.communication.strategies[${index}].id`);
    out[id] = {
      id,
      name: asNonEmptyString(item.name, `stages.communication.strategies[${index}].name`),
      family: asEnumValue(
        item.family,
        COMMUNICATION_STRATEGY_FAMILIES,
        `stages.communication.strategies[${index}].family`,
      ),
      toolId: asNonEmptyString(item.toolId, `stages.communication.strategies[${index}].toolId`),
    };
  }
  for (const id of COMMUNICATION_STRATEGY_IDS) {
    if (!out[id]) throw new Error(`Matrix policy missing communication strategy "${id}".`);
  }
  return out;
}

function parsePolicy(raw: unknown): MatrixPolicyConfig {
  if (!isRecord(raw)) throw new Error("Invalid matrix policy root.");
  const version = asNonEmptyString(raw.version, "version");
  if (!isRecord(raw.stages)) throw new Error('Invalid matrix policy field "stages".');

  const discover = raw.stages.discover;
  if (!isRecord(discover)) throw new Error('Invalid matrix policy field "stages.discover".');
  const discoverStrategies = parseDiscoveryStrategies(discover.strategies);

  const plan = raw.stages.plan;
  if (!isRecord(plan)) throw new Error('Invalid matrix policy field "stages.plan".');
  const planStrategies = parsePlanStrategies(plan.strategies);

  const code = raw.stages.code;
  if (!isRecord(code)) throw new Error('Invalid matrix policy field "stages.code".');
  const codeStrategies = parseCodeStrategies(code.strategies);

  const review = raw.stages.review;
  if (!isRecord(review)) throw new Error('Invalid matrix policy field "stages.review".');
  const reviewStrategies = parseReviewStrategies(review.strategies);

  const communication = raw.stages.communication;
  if (!isRecord(communication)) throw new Error('Invalid matrix policy field "stages.communication".');
  const communicationStrategies = parseCommunicationStrategies(communication.strategies);

  return {
    version,
    stages: {
      discover: {
        maxAttemptsTotal: asPositiveInt(discover.maxAttemptsTotal, "stages.discover.maxAttemptsTotal"),
        maxAttemptsPerFamily: asPositiveInt(discover.maxAttemptsPerFamily, "stages.discover.maxAttemptsPerFamily"),
        forceFamilySwitchErrorKinds: asEnumArray(
          discover.forceFamilySwitchErrorKinds,
          DISCOVERY_ERROR_KINDS,
          "stages.discover.forceFamilySwitchErrorKinds",
        ),
        fallbackOrder: asEnumArray(
          discover.fallbackOrder,
          DISCOVERY_STRATEGY_IDS,
          "stages.discover.fallbackOrder",
        ),
        fallbackOrderOnFamilySwitch: asEnumArray(
          isRecord(discover) && discover.fallbackOrderOnFamilySwitch
            ? discover.fallbackOrderOnFamilySwitch
            : discover.fallbackOrder,
          DISCOVERY_STRATEGY_IDS,
          "stages.discover.fallbackOrderOnFamilySwitch",
        ),
        nonzeroExitRetry: {
          enabled: Boolean((isRecord(discover.nonzeroExitRetry) && discover.nonzeroExitRetry.enabled) ?? false),
          errorKind: asEnumValue(
            isRecord(discover.nonzeroExitRetry) ? discover.nonzeroExitRetry.errorKind : undefined,
            DISCOVERY_ERROR_KINDS,
            "stages.discover.nonzeroExitRetry.errorKind",
          ),
        },
        strategies: discoverStrategies,
        matrix: parseMatrix(discover.matrix, DISCOVERY_ERROR_KINDS, DISCOVERY_STRATEGY_IDS, "stages.discover.matrix"),
      },
      plan: {
        maxAttemptsTotal: asPositiveInt(plan.maxAttemptsTotal, "stages.plan.maxAttemptsTotal"),
        maxAttemptsPerFamily: asPositiveInt(plan.maxAttemptsPerFamily, "stages.plan.maxAttemptsPerFamily"),
        maxRecursionDepth: asPositiveInt(plan.maxRecursionDepth, "stages.plan.maxRecursionDepth"),
        maxRecursiveBranches: asPositiveInt(plan.maxRecursiveBranches, "stages.plan.maxRecursiveBranches"),
        qualityPassThreshold: asPositiveInt(plan.qualityPassThreshold, "stages.plan.qualityPassThreshold"),
        forceFamilySwitchErrorKinds: asEnumArray(
          plan.forceFamilySwitchErrorKinds,
          PLAN_ERROR_KINDS,
          "stages.plan.forceFamilySwitchErrorKinds",
        ),
        fallbackOrder: asEnumArray(plan.fallbackOrder, PLAN_STRATEGY_IDS, "stages.plan.fallbackOrder"),
        fallbackOrderOnFamilySwitch: asEnumArray(
          isRecord(plan) && plan.fallbackOrderOnFamilySwitch ? plan.fallbackOrderOnFamilySwitch : plan.fallbackOrder,
          PLAN_STRATEGY_IDS,
          "stages.plan.fallbackOrderOnFamilySwitch",
        ),
        nonzeroExitRetry: {
          enabled: Boolean((isRecord(plan.nonzeroExitRetry) && plan.nonzeroExitRetry.enabled) ?? false),
          errorKind: asEnumValue(
            isRecord(plan.nonzeroExitRetry) ? plan.nonzeroExitRetry.errorKind : undefined,
            PLAN_ERROR_KINDS,
            "stages.plan.nonzeroExitRetry.errorKind",
          ),
        },
        strategies: planStrategies,
        matrix: parseMatrix(plan.matrix, PLAN_ERROR_KINDS, PLAN_STRATEGY_IDS, "stages.plan.matrix"),
      },
      code: {
        maxAttemptsTotal: asPositiveInt(code.maxAttemptsTotal, "stages.code.maxAttemptsTotal"),
        maxAttemptsPerFamily: asPositiveInt(code.maxAttemptsPerFamily, "stages.code.maxAttemptsPerFamily"),
        forceFamilySwitchErrorKinds: asEnumArray(
          code.forceFamilySwitchErrorKinds,
          CODE_ERROR_KINDS,
          "stages.code.forceFamilySwitchErrorKinds",
        ),
        fallbackOrder: asEnumArray(code.fallbackOrder, CODE_STRATEGY_IDS, "stages.code.fallbackOrder"),
        fallbackOrderOnFamilySwitch: asEnumArray(
          isRecord(code) && code.fallbackOrderOnFamilySwitch ? code.fallbackOrderOnFamilySwitch : code.fallbackOrder,
          CODE_STRATEGY_IDS,
          "stages.code.fallbackOrderOnFamilySwitch",
        ),
        nonzeroExitRetry: {
          enabled: Boolean((isRecord(code.nonzeroExitRetry) && code.nonzeroExitRetry.enabled) ?? false),
          errorKind: asEnumValue(
            isRecord(code.nonzeroExitRetry) ? code.nonzeroExitRetry.errorKind : undefined,
            CODE_ERROR_KINDS,
            "stages.code.nonzeroExitRetry.errorKind",
          ),
        },
        strategies: codeStrategies,
        matrix: parseMatrix(code.matrix, CODE_ERROR_KINDS, CODE_STRATEGY_IDS, "stages.code.matrix"),
      },
      review: {
        maxAttemptsTotal: asPositiveInt(review.maxAttemptsTotal, "stages.review.maxAttemptsTotal"),
        maxAttemptsPerFamily: asPositiveInt(review.maxAttemptsPerFamily, "stages.review.maxAttemptsPerFamily"),
        maxRevisionsPerStrategy: asPositiveInt(
          review.maxRevisionsPerStrategy,
          "stages.review.maxRevisionsPerStrategy",
        ),
        forceFamilySwitchErrorKinds: asEnumArray(
          review.forceFamilySwitchErrorKinds,
          REVIEW_ERROR_KINDS,
          "stages.review.forceFamilySwitchErrorKinds",
        ),
        fallbackOrder: asEnumArray(review.fallbackOrder, REVIEW_STRATEGY_IDS, "stages.review.fallbackOrder"),
        fallbackOrderOnFamilySwitch: asEnumArray(
          isRecord(review) && review.fallbackOrderOnFamilySwitch
            ? review.fallbackOrderOnFamilySwitch
            : review.fallbackOrder,
          REVIEW_STRATEGY_IDS,
          "stages.review.fallbackOrderOnFamilySwitch",
        ),
        nonzeroExitRetry: {
          enabled: Boolean((isRecord(review.nonzeroExitRetry) && review.nonzeroExitRetry.enabled) ?? false),
          errorKind: asEnumValue(
            isRecord(review.nonzeroExitRetry) ? review.nonzeroExitRetry.errorKind : undefined,
            REVIEW_ERROR_KINDS,
            "stages.review.nonzeroExitRetry.errorKind",
          ),
        },
        strategies: reviewStrategies,
        matrix: parseMatrix(review.matrix, REVIEW_ERROR_KINDS, REVIEW_STRATEGY_IDS, "stages.review.matrix"),
      },
      communication: {
        maxAttemptsTotal: asPositiveInt(communication.maxAttemptsTotal, "stages.communication.maxAttemptsTotal"),
        maxAttemptsPerFamily: asPositiveInt(
          communication.maxAttemptsPerFamily,
          "stages.communication.maxAttemptsPerFamily",
        ),
        forceFamilySwitchErrorKinds: asEnumArray(
          communication.forceFamilySwitchErrorKinds,
          COMMUNICATION_ERROR_KINDS,
          "stages.communication.forceFamilySwitchErrorKinds",
        ),
        fallbackOrder: asEnumArray(
          communication.fallbackOrder,
          COMMUNICATION_STRATEGY_IDS,
          "stages.communication.fallbackOrder",
        ),
        fallbackOrderOnFamilySwitch: asEnumArray(
          isRecord(communication) && communication.fallbackOrderOnFamilySwitch
            ? communication.fallbackOrderOnFamilySwitch
            : communication.fallbackOrder,
          COMMUNICATION_STRATEGY_IDS,
          "stages.communication.fallbackOrderOnFamilySwitch",
        ),
        nonzeroExitRetry: {
          enabled: Boolean(
            (isRecord(communication.nonzeroExitRetry) && communication.nonzeroExitRetry.enabled) ?? false,
          ),
          errorKind: asEnumValue(
            isRecord(communication.nonzeroExitRetry) ? communication.nonzeroExitRetry.errorKind : undefined,
            COMMUNICATION_ERROR_KINDS,
            "stages.communication.nonzeroExitRetry.errorKind",
          ),
        },
        strategies: communicationStrategies,
        matrix: parseMatrix(
          communication.matrix,
          COMMUNICATION_ERROR_KINDS,
          COMMUNICATION_STRATEGY_IDS,
          "stages.communication.matrix",
        ),
      },
    },
  };
}

export const MATRIX_POLICY_CONFIG = parsePolicy(rawMatrixPolicy);
export const DISCOVERY_POLICY = MATRIX_POLICY_CONFIG.stages.discover;
export const PLAN_POLICY = MATRIX_POLICY_CONFIG.stages.plan;
export const CODE_POLICY = MATRIX_POLICY_CONFIG.stages.code;
export const REVIEW_POLICY = MATRIX_POLICY_CONFIG.stages.review;
export const COMMUNICATION_POLICY = MATRIX_POLICY_CONFIG.stages.communication;
