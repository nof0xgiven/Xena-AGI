import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

type LearnedRegistryFile = {
  tools?: any[];
  skills?: any[];
  agents?: any[];
};

type PromotionState = "observational" | "promoted" | "disabled";
type LearningQualityMetadata = {
  firstLearnedAt: string;
  lastLearnedAt: string;
  observationCount: number;
  successCount: number;
  successRate: number;
  avgAttempts: number;
  avgQualitySignal: number;
  avgConfidenceLift: number;
  recencyScore: number;
  qualityScore: number;
  promoted: boolean;
  promotionState: PromotionState;
  promotedAt: string | null;
  promotionReason: string;
};

/**
 * Write file atomically: write to a temp file in the same directory then rename.
 * rename(2) is atomic on POSIX when source and destination are on the same filesystem.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function upsertByIdVersion<T extends { id: string; version: string }>(
  entries: T[],
  next: T,
): T[] {
  const idx = entries.findIndex((e) => e.id === next.id && e.version === next.version);
  if (idx >= 0) {
    entries[idx] = next;
    return entries;
  }
  entries.push(next);
  return entries;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

const PROMOTION_MIN_SUCCESS_COUNT = 2;
const PROMOTION_MIN_QUALITY_SCORE = 70;
const PROMOTION_MIN_CONFIDENCE_LIFT = 0.35;
const DISABLE_BELOW_QUALITY_SCORE = 45;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(record: Record<string, unknown> | null, key: string, fallback: number): number {
  if (!record) return fallback;
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return value;
}

function asString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
}

function asBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  if (!record) return null;
  const value = record[key];
  if (typeof value !== "boolean") return null;
  return value;
}

function daysSinceIso(previousIso: string | null, nowIso: string): number | null {
  if (!previousIso) return null;
  const previous = Date.parse(previousIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(previous) || !Number.isFinite(now)) return null;
  const diff = now - previous;
  if (diff <= 0) return 0;
  return diff / (24 * 60 * 60 * 1000);
}

function computeRecencyScore(previousIso: string | null, nowIso: string): number {
  const days = daysSinceIso(previousIso, nowIso);
  if (days === null) return 100;
  return round2(clamp(100 - days * 3, 10, 100));
}

function findExistingByIdVersion<T extends { id: string; version: string }>(
  entries: readonly T[] | undefined,
  id: string,
  version: string,
): T | null {
  if (!entries) return null;
  return entries.find((entry) => entry.id === id && entry.version === version) ?? null;
}

function derivePromotionState(opts: {
  observationCount: number;
  successCount: number;
  qualityScore: number;
  avgConfidenceLift: number;
}): { promotionState: PromotionState; promoted: boolean; reason: string } {
  if (opts.qualityScore < DISABLE_BELOW_QUALITY_SCORE) {
    return {
      promotionState: "disabled",
      promoted: false,
      reason: `quality_score_below_disable_threshold(${opts.qualityScore} < ${DISABLE_BELOW_QUALITY_SCORE})`,
    };
  }

  const meetsCount = opts.successCount >= PROMOTION_MIN_SUCCESS_COUNT;
  const meetsQuality = opts.qualityScore >= PROMOTION_MIN_QUALITY_SCORE;
  const meetsLift = opts.avgConfidenceLift >= PROMOTION_MIN_CONFIDENCE_LIFT;
  if (meetsCount && meetsQuality && meetsLift) {
    return {
      promotionState: "promoted",
      promoted: true,
      reason: `promotion_gate_passed(success_count=${opts.successCount}, quality_score=${opts.qualityScore}, confidence_lift=${round3(opts.avgConfidenceLift)})`,
    };
  }

  return {
    promotionState: "observational",
    promoted: false,
    reason: `promotion_gate_pending(success_count=${opts.successCount}/${PROMOTION_MIN_SUCCESS_COUNT}, quality_score=${opts.qualityScore}/${PROMOTION_MIN_QUALITY_SCORE}, confidence_lift=${round3(opts.avgConfidenceLift)}/${PROMOTION_MIN_CONFIDENCE_LIFT})`,
  };
}

function buildLearningQualityMetadata(opts: {
  existingMetadata: unknown;
  nowIso: string;
  attempts: number;
  qualitySignal: number;
  confidenceLift: number;
}): LearningQualityMetadata {
  const previous = asRecord(opts.existingMetadata);
  const observationCountPrev = asNumber(previous, "observationCount", 0);
  const successCountPrev = asNumber(previous, "successCount", 0);
  const avgAttemptsPrev = asNumber(previous, "avgAttempts", 0);
  const avgQualitySignalPrev = asNumber(previous, "avgQualitySignal", 0);
  const avgConfidenceLiftPrev = asNumber(previous, "avgConfidenceLift", 0);
  const promotedAtPrev = asString(previous, "promotedAt");
  const firstLearnedAtPrev = asString(previous, "firstLearnedAt");

  const observationCount = observationCountPrev + 1;
  const successCount = successCountPrev + 1;
  const successRate = round3(successCount / observationCount);

  const avgAttempts = round3((avgAttemptsPrev * observationCountPrev + opts.attempts) / observationCount);
  const avgQualitySignal = round3((avgQualitySignalPrev * observationCountPrev + opts.qualitySignal) / observationCount);
  const avgConfidenceLift = round3(
    (avgConfidenceLiftPrev * observationCountPrev + opts.confidenceLift) / observationCount,
  );

  const recencyScore = computeRecencyScore(asString(previous, "lastLearnedAt") ?? asString(previous, "learnedAt"), opts.nowIso);
  const qualityScore = round2(
    successRate * 15 + recencyScore * 0.15 + avgConfidenceLift * 100 * 0.35 + avgQualitySignal * 0.35,
  );

  const promotion = derivePromotionState({
    observationCount,
    successCount,
    qualityScore,
    avgConfidenceLift,
  });

  const promotedAt =
    promotion.promoted && promotedAtPrev && asBoolean(previous, "promoted") === true ? promotedAtPrev : promotion.promoted ? opts.nowIso : null;

  return {
    firstLearnedAt: firstLearnedAtPrev ?? opts.nowIso,
    lastLearnedAt: opts.nowIso,
    observationCount,
    successCount,
    successRate,
    avgAttempts,
    avgQualitySignal,
    avgConfidenceLift,
    recencyScore,
    qualityScore,
    promoted: promotion.promoted,
    promotionState: promotion.promotionState,
    promotedAt,
    promotionReason: promotion.reason,
  };
}

export async function registryUpsertLearnedDiscoveryPattern(opts: {
  issueIdentifier: string;
  selectedStrategy: string;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
}): Promise<{ path: string; updated: true }> {
  const filePath = path.resolve(process.cwd(), "config/registry/learned-workflows.json");

  let parsed: LearnedRegistryFile = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") parsed = obj;
  } catch {
    parsed = {};
  }

  const nowIso = new Date().toISOString();
  const triggerErrorKinds = uniqueStrings(opts.triggerErrorKinds);
  const strategyPath = uniqueStrings(opts.strategyPath);
  const existingTool = findExistingByIdVersion(parsed.tools, "tool.discovery.learned.matrix", "1.0.0");
  const existingSkill = findExistingByIdVersion(parsed.skills, "skill.coding.discovery.matrix", "1.0.0");
  const existingAgent = findExistingByIdVersion(parsed.agents, "agent.coding.discovery.matrix", "1.0.0");
  const learningQuality = buildLearningQualityMetadata({
    existingMetadata: existingAgent?.metadata ?? existingSkill?.metadata ?? existingTool?.metadata ?? null,
    nowIso,
    attempts: opts.attempts,
    qualitySignal: clamp(100 - Math.max(0, opts.attempts - 1) * 20, 35, 100),
    confidenceLift: clamp((triggerErrorKinds.length + 1) / (opts.attempts + 1), 0, 1),
  });
  const enabledByQuality = learningQuality.promotionState !== "disabled";

  const tool = {
    id: "tool.discovery.learned.matrix",
    name: "Learned Discovery Matrix",
    version: "1.0.0",
    description: "Adaptive discovery strategy learned from runtime failures and successful recovery paths.",
    enabled: enabledByQuality,
    tags: ["coding", "discovery", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      selectedToolId: opts.selectedToolId,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    surface: {
      domains: ["coding"],
      entities: ["repository"],
      operations: ["execute", "analyze"],
      taskRoles: ["controller"],
      authority: 0.75,
      freshnessSlaSec: 120,
    },
    capabilities: ["discover.repo", "discover.repo.learned"],
    deterministic: false,
    riskLevel: "medium",
  };

  const skill = {
    id: "skill.coding.discovery.matrix",
    name: "Coding Discovery Matrix",
    version: "1.0.0",
    description: "Adaptive discovery skill that switches strategies based on error-pattern matrix and learns outcomes.",
    enabled: enabledByQuality,
    tags: ["coding", "discovery", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    requiredCapabilities: ["discover.repo", "linear.comment.post"],
    preferredToolIds: uniqueStrings([
      "tool.discovery.learned.matrix",
      opts.selectedToolId,
      "tool.discovery.codex.exec",
      "tool.discovery.teddy.gpt_oss",
      "tool.discovery.teddy.default",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    preferredResourceIds: ["resource.codex.default", "resource.openai.reply"],
    guardrails: [
      "When repeated failures occur, switch strategy family rather than retrying identical calls.",
      "Persist successful recovery paths into registry and memory for reuse.",
      "Post concise teammate updates for each strategy switch.",
    ],
    outputContract: {
      required: ["discovery_summary", "relevant_files", "risks", "next_steps"],
    },
  };

  const agent = {
    id: "agent.coding.discovery.matrix",
    name: "Coding Discovery Matrix Agent",
    version: "1.0.0",
    description: "Learns and applies adaptive discovery strategy transitions after failures.",
    enabled: enabledByQuality,
    tags: ["coding", "discovery", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    skillIds: ["skill.coding.discovery.matrix"],
    toolIds: uniqueStrings([
      "tool.discovery.learned.matrix",
      opts.selectedToolId,
      "tool.discovery.codex.exec",
      "tool.discovery.teddy.gpt_oss",
      "tool.discovery.teddy.default",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    resourceIds: ["resource.codex.default", "resource.openai.reply"],
    weight: 180,
    constraints: {
      maxRiskLevel: "high",
      requireDeterministicTools: false,
    },
  };

  const next: LearnedRegistryFile = {
    tools: upsertByIdVersion(parsed.tools ?? [], tool),
    skills: upsertByIdVersion(parsed.skills ?? [], skill),
    agents: upsertByIdVersion(parsed.agents ?? [], agent),
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, `${JSON.stringify(next, null, 2)}
`);

  return { path: filePath, updated: true };
}

export async function registryUpsertLearnedPlanningPattern(opts: {
  issueIdentifier: string;
  selectedStrategy: string;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
  recursionDepth: number;
  branchCount: number;
  qualityScore: number;
}): Promise<{ path: string; updated: true }> {
  const filePath = path.resolve(process.cwd(), "config/registry/learned-workflows.json");

  let parsed: LearnedRegistryFile = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") parsed = obj;
  } catch {
    parsed = {};
  }

  const nowIso = new Date().toISOString();
  const triggerErrorKinds = uniqueStrings(opts.triggerErrorKinds);
  const strategyPath = uniqueStrings(opts.strategyPath);
  const existingTool = findExistingByIdVersion(parsed.tools, "tool.planning.learned.matrix", "1.0.0");
  const existingSkill = findExistingByIdVersion(parsed.skills, "skill.coding.plan.matrix", "1.0.0");
  const existingAgent = findExistingByIdVersion(parsed.agents, "agent.coding.plan.matrix", "1.0.0");
  const confidenceLift = clamp(
    (clamp(opts.qualityScore, 0, 100) / 100) * ((triggerErrorKinds.length + 1) / (opts.attempts + 1)),
    0,
    1,
  );
  const learningQuality = buildLearningQualityMetadata({
    existingMetadata: existingAgent?.metadata ?? existingSkill?.metadata ?? existingTool?.metadata ?? null,
    nowIso,
    attempts: opts.attempts,
    qualitySignal: clamp(opts.qualityScore, 0, 100),
    confidenceLift,
  });
  const enabledByQuality = learningQuality.promotionState !== "disabled";

  const tool = {
    id: "tool.planning.learned.matrix",
    name: "Learned Planning Matrix",
    version: "1.0.0",
    description: "Adaptive planning strategy learned from runtime failures and quality-gate recoveries.",
    enabled: enabledByQuality,
    tags: ["coding", "planning", "learned", "matrix", "recursive"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      selectedToolId: opts.selectedToolId,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      recursionDepth: opts.recursionDepth,
      branchCount: opts.branchCount,
      planQualityScore: opts.qualityScore,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    surface: {
      domains: ["coding"],
      entities: ["plan"],
      operations: ["execute", "analyze"],
      taskRoles: ["controller"],
      authority: 0.78,
      freshnessSlaSec: 120,
    },
    capabilities: ["plan.generate", "plan.generate.learned"],
    deterministic: false,
    riskLevel: "medium",
  };

  const skill = {
    id: "skill.coding.plan.matrix",
    name: "Coding Plan Matrix",
    version: "1.0.0",
    description: "Adaptive planning skill that switches strategy families and applies bounded recursive synthesis.",
    enabled: enabledByQuality,
    tags: ["coding", "planning", "learned", "matrix", "recursive"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      recursionDepth: opts.recursionDepth,
      branchCount: opts.branchCount,
      planQualityScore: opts.qualityScore,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    requiredCapabilities: ["linear.comment.post"],
    preferredToolIds: uniqueStrings([
      "tool.planning.learned.matrix",
      opts.selectedToolId,
      "tool.plan.codex.direct",
      "tool.plan.codex.recursive",
      "tool.plan.teddy.direct",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    preferredResourceIds: ["resource.codex.default", "resource.openai.reply"],
    guardrails: [
      "Prefer direct planning first, then escalate to bounded recursion when quality or reliability degrades.",
      "Use enough-is-enough switching to avoid repeated failures in one strategy family.",
      "Persist successful recovery paths into registry and memory for reuse.",
    ],
    outputContract: {
      required: ["goal", "requirements", "tests", "risks"],
    },
  };

  const agent = {
    id: "agent.coding.plan.matrix",
    name: "Coding Plan Matrix Agent",
    version: "1.0.0",
    description: "Learns and applies adaptive planning strategy transitions with bounded recursive decomposition.",
    enabled: enabledByQuality,
    tags: ["coding", "planning", "learned", "matrix", "recursive"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      recursionDepth: opts.recursionDepth,
      branchCount: opts.branchCount,
      planQualityScore: opts.qualityScore,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    skillIds: ["skill.coding.plan.matrix"],
    toolIds: uniqueStrings([
      "tool.planning.learned.matrix",
      opts.selectedToolId,
      "tool.plan.codex.direct",
      "tool.plan.codex.recursive",
      "tool.plan.teddy.direct",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    resourceIds: ["resource.codex.default", "resource.openai.reply"],
    weight: 185,
    constraints: {
      maxRiskLevel: "high",
      requireDeterministicTools: false,
    },
  };

  const next: LearnedRegistryFile = {
    tools: upsertByIdVersion(parsed.tools ?? [], tool),
    skills: upsertByIdVersion(parsed.skills ?? [], skill),
    agents: upsertByIdVersion(parsed.agents ?? [], agent),
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, `${JSON.stringify(next, null, 2)}
`);

  return { path: filePath, updated: true };
}

export async function registryUpsertLearnedCodingPattern(opts: {
  issueIdentifier: string;
  selectedStrategy: string;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
}): Promise<{ path: string; updated: true }> {
  const filePath = path.resolve(process.cwd(), "config/registry/learned-workflows.json");

  let parsed: LearnedRegistryFile = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") parsed = obj;
  } catch {
    parsed = {};
  }

  const nowIso = new Date().toISOString();
  const triggerErrorKinds = uniqueStrings(opts.triggerErrorKinds);
  const strategyPath = uniqueStrings(opts.strategyPath);
  const existingTool = findExistingByIdVersion(parsed.tools, "tool.code.learned.matrix", "1.0.0");
  const existingSkill = findExistingByIdVersion(parsed.skills, "skill.coding.code.matrix", "1.0.0");
  const existingAgent = findExistingByIdVersion(parsed.agents, "agent.coding.code.matrix", "1.0.0");
  const learningQuality = buildLearningQualityMetadata({
    existingMetadata: existingAgent?.metadata ?? existingSkill?.metadata ?? existingTool?.metadata ?? null,
    nowIso,
    attempts: opts.attempts,
    qualitySignal: clamp(100 - Math.max(0, opts.attempts - 1) * 25, 30, 100),
    confidenceLift: clamp((triggerErrorKinds.length + 1) / (opts.attempts + 1), 0, 1),
  });
  const enabledByQuality = learningQuality.promotionState !== "disabled";

  const tool = {
    id: "tool.code.learned.matrix",
    name: "Learned Coding Matrix",
    version: "1.0.0",
    description: "Adaptive coding strategy learned from implementation-stage failures and recoveries.",
    enabled: enabledByQuality,
    tags: ["coding", "implementation", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      selectedToolId: opts.selectedToolId,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    surface: {
      domains: ["coding"],
      entities: ["repository", "patch"],
      operations: ["execute", "write"],
      taskRoles: ["controller"],
      authority: 0.78,
      freshnessSlaSec: 120,
    },
    capabilities: ["code.implement", "code.implement.learned"],
    deterministic: false,
    riskLevel: "medium",
  };

  const skill = {
    id: "skill.coding.code.matrix",
    name: "Coding Implementation Matrix",
    version: "1.0.0",
    description: "Adaptive implementation skill that switches strategy families during code execution failures.",
    enabled: enabledByQuality,
    tags: ["coding", "implementation", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    requiredCapabilities: ["code.implement", "linear.comment.post"],
    preferredToolIds: uniqueStrings([
      "tool.code.learned.matrix",
      opts.selectedToolId,
      "tool.code.codex.exec",
      "tool.code.codex.exec.patch",
      "tool.code.teddy.exec",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    preferredResourceIds: ["resource.codex.default", "resource.openai.reply"],
    guardrails: [
      "Switch strategy family when implementation failures repeat within the same family.",
      "Ensure each coding attempt produces real worktree changes or classify as no_changes.",
      "Persist successful recovery paths into registry and memory for reuse.",
    ],
    outputContract: {
      required: ["implementation_result", "review_summary", "proof"],
    },
  };

  const agent = {
    id: "agent.coding.code.matrix",
    name: "Coding Matrix Agent",
    version: "1.0.0",
    description: "Learns and applies adaptive strategy transitions for code implementation stage.",
    enabled: enabledByQuality,
    tags: ["coding", "implementation", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    skillIds: ["skill.coding.code.matrix"],
    toolIds: uniqueStrings([
      "tool.code.learned.matrix",
      opts.selectedToolId,
      "tool.code.codex.exec",
      "tool.code.codex.exec.patch",
      "tool.code.teddy.exec",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    resourceIds: ["resource.codex.default", "resource.openai.reply"],
    weight: 190,
    constraints: {
      maxRiskLevel: "high",
      requireDeterministicTools: false,
    },
  };

  const next: LearnedRegistryFile = {
    tools: upsertByIdVersion(parsed.tools ?? [], tool),
    skills: upsertByIdVersion(parsed.skills ?? [], skill),
    agents: upsertByIdVersion(parsed.agents ?? [], agent),
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, `${JSON.stringify(next, null, 2)}
`);

  return { path: filePath, updated: true };
}

export async function registryUpsertLearnedReviewPattern(opts: {
  issueIdentifier: string;
  selectedStrategy: string;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
  revisionAttempts: number;
}): Promise<{ path: string; updated: true }> {
  const filePath = path.resolve(process.cwd(), "config/registry/learned-workflows.json");

  let parsed: LearnedRegistryFile = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") parsed = obj;
  } catch {
    parsed = {};
  }

  const nowIso = new Date().toISOString();
  const triggerErrorKinds = uniqueStrings(opts.triggerErrorKinds);
  const strategyPath = uniqueStrings(opts.strategyPath);
  const existingTool = findExistingByIdVersion(parsed.tools, "tool.review.learned.matrix", "1.0.0");
  const existingSkill = findExistingByIdVersion(parsed.skills, "skill.coding.review.matrix", "1.0.0");
  const existingAgent = findExistingByIdVersion(parsed.agents, "agent.coding.review.matrix", "1.0.0");
  const learningQuality = buildLearningQualityMetadata({
    existingMetadata: existingAgent?.metadata ?? existingSkill?.metadata ?? existingTool?.metadata ?? null,
    nowIso,
    attempts: opts.attempts,
    qualitySignal: clamp(100 - Math.max(0, opts.attempts - 1) * 20 - opts.revisionAttempts * 10, 25, 100),
    confidenceLift: clamp((triggerErrorKinds.length + 1) / (opts.attempts + opts.revisionAttempts + 1), 0, 1),
  });
  const enabledByQuality = learningQuality.promotionState !== "disabled";

  const tool = {
    id: "tool.review.learned.matrix",
    name: "Learned Review Matrix",
    version: "1.0.0",
    description: "Adaptive review strategy learned from review/revision loop failures and recoveries.",
    enabled: enabledByQuality,
    tags: ["coding", "review", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      selectedToolId: opts.selectedToolId,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      revisionAttempts: opts.revisionAttempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    surface: {
      domains: ["coding"],
      entities: ["repository", "review", "patch"],
      operations: ["execute", "analyze", "write"],
      taskRoles: ["controller"],
      authority: 0.78,
      freshnessSlaSec: 120,
    },
    capabilities: ["code.review", "code.review.learned"],
    deterministic: false,
    riskLevel: "medium",
  };

  const skill = {
    id: "skill.coding.review.matrix",
    name: "Coding Review Matrix",
    version: "1.0.0",
    description: "Adaptive review skill that switches strategy families when review/revision blockers persist.",
    enabled: enabledByQuality,
    tags: ["coding", "review", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      revisionAttempts: opts.revisionAttempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    requiredCapabilities: ["code.review", "linear.comment.post"],
    preferredToolIds: uniqueStrings([
      "tool.review.learned.matrix",
      opts.selectedToolId,
      "tool.review.codex.review",
      "tool.review.codex.revision",
      "tool.review.codex.revision.focused",
      "tool.review.teddy.review",
      "tool.review.teddy.revision",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    preferredResourceIds: ["resource.codex.default", "resource.openai.reply"],
    guardrails: [
      "Switch strategy family when review blockers persist after bounded revisions.",
      "Preserve strict scope while applying blocker-only revisions.",
      "Persist successful recovery paths into registry and memory for reuse.",
    ],
    outputContract: {
      required: ["review_summary", "blocking_items", "revision_actions"],
    },
  };

  const agent = {
    id: "agent.coding.review.matrix",
    name: "Coding Review Matrix Agent",
    version: "1.0.0",
    description: "Learns and applies adaptive strategy transitions for review/revision stage.",
    enabled: enabledByQuality,
    tags: ["coding", "review", "learned", "matrix"],
    metadata: {
      learnedAt: nowIso,
      selectedStrategy: opts.selectedStrategy,
      triggerErrorKinds,
      strategyPath,
      attempts: opts.attempts,
      revisionAttempts: opts.revisionAttempts,
      lastIssueIdentifier: opts.issueIdentifier,
      ...learningQuality,
    },
    intentTypes: ["coding"],
    skillIds: ["skill.coding.review.matrix"],
    toolIds: uniqueStrings([
      "tool.review.learned.matrix",
      opts.selectedToolId,
      "tool.review.codex.review",
      "tool.review.codex.revision",
      "tool.review.codex.revision.focused",
      "tool.review.teddy.review",
      "tool.review.teddy.revision",
      "tool.linear.comment",
      "tool.linear.issue_read",
    ]),
    resourceIds: ["resource.codex.default", "resource.openai.reply"],
    weight: 192,
    constraints: {
      maxRiskLevel: "high",
      requireDeterministicTools: false,
    },
  };

  const next: LearnedRegistryFile = {
    tools: upsertByIdVersion(parsed.tools ?? [], tool),
    skills: upsertByIdVersion(parsed.skills ?? [], skill),
    agents: upsertByIdVersion(parsed.agents ?? [], agent),
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, `${JSON.stringify(next, null, 2)}
`);

  return { path: filePath, updated: true };
}
