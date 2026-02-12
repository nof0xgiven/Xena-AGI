import { resolveAgentComposition } from "../registry/resolver.js";
import type { RegistryBundle, ResolutionRequest, RiskLevel } from "../registry/schema.js";
import { appendEngineTransition } from "./engineRuntime.js";
import { classifyIntentText } from "./intentClassifier.js";
import { evaluateRiskPolicy } from "./policy.js";
import type {
  ConfidenceGateDecision,
  DecisionRecord,
  EngineTransitionRecord,
  ExecutionPlan,
  ExecutionStep,
  OperatorIntent,
  OperatorIntentType,
  ValidationCheck,
  ValidationReport,
} from "./types.js";

export type BuildIntentInput = {
  issueTitle: string;
  issueDescription?: string | null;
  commentText?: string | null;
  requiredCapabilities?: readonly string[];
};

export type BuildExecutionPlanInput = BuildIntentInput & {
  registry: RegistryBundle;
  preferredAgentIds?: readonly string[];
  blockedAgentIds?: readonly string[];
  preferredToolIds?: readonly string[];
  blockedToolIds?: readonly string[];
  preferredResourceIds?: readonly string[];
  blockedResourceIds?: readonly string[];
  maxRiskLevel?: RiskLevel;
  confidenceThresholds?: Partial<Record<OperatorIntentType, number>>;
};

const DEFAULT_CONFIDENCE_THRESHOLDS: Record<OperatorIntentType, number> = {
  coding: 0.6,
  research: 0.55,
};

/**
 * Intent-derived default capabilities. When the caller does not provide explicit
 * requiredCapabilities, these defaults are applied based on the detected intent type.
 * This prevents coding capabilities from blocking resolution of research intents and vice versa.
 */
const INTENT_DEFAULT_CAPABILITIES: Record<OperatorIntentType, readonly string[]> = {
  coding: ["code.plan", "code.implement", "code.review", "linear.comment.post"],
  research: ["research.fetch", "research.summarize", "research.verify_sources", "linear.comment.post"],
};

const CONTEXT_SIGNAL_ALLOWLIST = new Set([
  "discover",
  "discovery",
  "plan",
  "planning",
  "code",
  "coding",
  "review",
  "revision",
  "matrix",
  "fallback",
  "recursive",
  "research",
  "brief",
  "presentation",
  "slides",
  "deck",
  "workflow",
  "agent",
  "registry",
]);

const BRACKETED_ERROR_SIGNATURES = [
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
  "quality_low",
  "p0_p1_unresolved",
  "unknown",
] as const;
const ERROR_SIGNATURE_SET = new Set<string>(BRACKETED_ERROR_SIGNATURES);

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function uniqueSortedSignals(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeCapabilities(capabilities: readonly string[] | undefined): string[] {
  return [...new Set((capabilities ?? []).map((capability) => capability.trim()).filter((capability) => capability.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeDefinitionIds(definitionIds: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (definitionIds ?? []).map((definitionId) => definitionId.trim()).filter((definitionId) => definitionId.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function extractContextSignals(intent: OperatorIntent): string[] {
  const signalValues: string[] = [intent.type];

  for (const raw of intent.matchedSignals) {
    const withoutCount = raw.replace(/\(\d+\)\s*$/, "").trim().toLowerCase();
    if (!withoutCount) continue;
    signalValues.push(withoutCount);
    const split = withoutCount.split(":");
    if (split.length === 2 && split[1]) signalValues.push(split[1]);
  }

  signalValues.push(...intent.requiredCapabilities);

  const textTokens = intent.sourceText.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
  for (const token of textTokens) {
    if (CONTEXT_SIGNAL_ALLOWLIST.has(token)) signalValues.push(token);
  }

  return uniqueSortedSignals(signalValues);
}

function extractErrorSignaturesFromText(text: string): string[] {
  const normalized = text.toLowerCase();
  const signatures: string[] = [];

  const push = (value: string) => {
    const cleaned = value.trim().toLowerCase();
    if (ERROR_SIGNATURE_SET.has(cleaned)) signatures.push(cleaned);
  };

  const errorKindPattern = /\berror[_\s-]?kind\s*[:=]\s*([a-z0-9_]+)/gi;
  for (const match of normalized.matchAll(errorKindPattern)) {
    if (match[1]) push(match[1]);
  }

  const triggerKindsPattern = /\btrigger[_\s-]?error[_\s-]?kinds\s*[:=]\s*([a-z0-9_,\s-]+)/gi;
  for (const match of normalized.matchAll(triggerKindsPattern)) {
    const rawList = match[1] ?? "";
    for (const token of rawList.split(/[|,]+/g)) {
      if (token.length > 0) push(token);
    }
  }

  const bracketPattern = new RegExp(`\\[(${BRACKETED_ERROR_SIGNATURES.join("|")})\\]`, "gi");
  for (const match of normalized.matchAll(bracketPattern)) {
    if (match[1]) push(match[1]);
  }

  return uniqueSortedSignals(signatures);
}

function collectResolvedCapabilities(plan: ExecutionPlan["resolution"]): ReadonlySet<string> {
  return new Set(
    [...plan.selectedTools.flatMap((tool) => tool.capabilities), ...plan.selectedResources.flatMap((resource) => resource.capabilities)]
      .map((capability) => capability.trim())
      .filter((capability) => capability.length > 0),
  );
}

function buildValidationReport(plan: {
  confidenceDecision: ConfidenceGateDecision;
  policyAllowsAuto: boolean;
  requiredCapabilities: readonly string[];
  resolvedCapabilities: ReadonlySet<string>;
}): ValidationReport {
  const missingCapabilities = plan.requiredCapabilities.filter((capability) => !plan.resolvedCapabilities.has(capability));

  const checks: ValidationCheck[] = [
    {
      name: "confidence_gate",
      passed: plan.confidenceDecision.pass,
      severity: "warning",
      detail: plan.confidenceDecision.rationale,
    },
    {
      name: "policy_allow_auto_execution",
      passed: plan.policyAllowsAuto,
      severity: "warning",
      detail: plan.policyAllowsAuto
        ? "Policy allows automatic execution."
        : "Policy requires manual oversight before execution.",
    },
    {
      name: "required_capabilities",
      passed: missingCapabilities.length === 0,
      severity: "error",
      detail:
        missingCapabilities.length === 0
          ? "All required capabilities are present."
          : `Missing capabilities: ${missingCapabilities.join(", ")}`,
    },
  ];

  const errors = checks.filter((check) => !check.passed && check.severity === "error").map((check) => check.detail);
  const warnings = checks.filter((check) => !check.passed && check.severity === "warning").map((check) => check.detail);

  return {
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
  };
}

function toExecutionSteps(input: {
  confidenceDecision: ConfidenceGateDecision;
  requiresHumanApproval: boolean;
  autoMitigations: readonly string[];
  autoAllowed: boolean;
  selectedAgentId: string;
}): ExecutionStep[] {
  const descriptions: Array<Omit<ExecutionStep, "id">> = [];

  if (!input.confidenceDecision.pass) {
    descriptions.push({
      description: "Request clarifying details to raise intent confidence before execution.",
      mode: "manual",
    });
  }
  if (input.requiresHumanApproval) {
    descriptions.push({
      description: "Obtain human approval for risk-controlled execution.",
      mode: "manual",
    });
  }
  for (const mitigation of input.autoMitigations) {
    descriptions.push({
      description: mitigation,
      mode: input.autoAllowed ? "automatic" : "manual",
    });
  }
  descriptions.push({
    description: input.autoAllowed
      ? `Execute selected composition with agent "${input.selectedAgentId}".`
      : `Prepare execution package for agent "${input.selectedAgentId}" pending manual approval.`,
    mode: input.autoAllowed ? "automatic" : "manual",
  });

  return descriptions.map((step, index) => ({
    id: `step_${index + 1}`,
    ...step,
  }));
}

function buildEngineTransitions(input: {
  intent: OperatorIntent;
  resolution: ExecutionPlan["resolution"];
  confidenceDecision: ConfidenceGateDecision;
  policyDecision: ExecutionPlan["policyDecision"];
  validation: ValidationReport;
  decisionLog: readonly DecisionRecord[];
  steps: readonly ExecutionStep[];
}): EngineTransitionRecord[] {
  const transitions: EngineTransitionRecord[] = [];

  appendEngineTransition(transitions, {
    to: "understand",
    rationale: `Intent "${input.intent.type}" identified from issue + context text.`,
    metadata: {
      intentType: input.intent.type,
      confidence: Number(input.intent.confidence.toFixed(3)),
    },
  });

  appendEngineTransition(transitions, {
    to: "prove",
    rationale:
      input.intent.matchedSignals.length > 0
        ? `Evidence signals: ${input.intent.matchedSignals.join(", ")}.`
        : "No strong lexical signals found; using normalized issue context evidence.",
    metadata: {
      signalCount: input.intent.matchedSignals.length,
      requiredCapabilityCount: input.intent.requiredCapabilities.length,
    },
  });

  appendEngineTransition(transitions, {
    to: "plan",
    rationale: input.resolution.rationale,
    metadata: {
      selectedAgent: input.resolution.selectedAgent.id,
      selectedToolCount: input.resolution.selectedTools.length,
      selectedResourceCount: input.resolution.selectedResources.length,
    },
  });

  appendEngineTransition(transitions, {
    to: "confidence_gate",
    rationale: input.confidenceDecision.rationale,
    metadata: {
      pass: input.confidenceDecision.pass,
      threshold: Number(input.confidenceDecision.threshold.toFixed(3)),
      confidence: Number(input.confidenceDecision.confidence.toFixed(3)),
    },
  });

  appendEngineTransition(transitions, {
    to: "execute",
    rationale: input.policyDecision.allowAutoExecution
      ? "Execution is approved for automatic run under current policy."
      : "Execution requires manual oversight before run.",
    metadata: {
      allowAutoExecution: input.policyDecision.allowAutoExecution,
      requiresHumanApproval: input.policyDecision.requiresHumanApproval,
      riskLevel: input.policyDecision.riskLevel,
    },
  });

  appendEngineTransition(transitions, {
    to: "validate",
    rationale: input.validation.valid
      ? "Validation checks passed for required capabilities and policy constraints."
      : `Validation failed: ${input.validation.errors.join("; ")}`,
    metadata: {
      valid: input.validation.valid,
      errorCount: input.validation.errors.length,
      warningCount: input.validation.warnings.length,
    },
  });

  appendEngineTransition(transitions, {
    to: "learn",
    rationale: `Captured ${input.decisionLog.length} decision records and ${input.steps.length} execution steps.`,
    metadata: {
      decisionCount: input.decisionLog.length,
      stepCount: input.steps.length,
    },
  });

  const adaptationRationale = !input.confidenceDecision.pass
    ? "Adaptation required: confidence below threshold, request clarification before execution."
    : !input.policyDecision.allowAutoExecution
      ? "Adaptation required: policy requires human approval path."
      : !input.validation.valid
        ? "Adaptation required: resolve validation errors before execution."
        : "No adaptation required; keep current strategy for this run.";

  appendEngineTransition(transitions, {
    to: "adapt",
    rationale: adaptationRationale,
    metadata: {
      requiresAdaptation: !input.confidenceDecision.pass || !input.policyDecision.allowAutoExecution || !input.validation.valid,
    },
  });

  return transitions;
}

export function buildIntent(input: BuildIntentInput): OperatorIntent {
  const issueTitle = normalizeText(input.issueTitle);
  if (issueTitle.length === 0) {
    throw new Error("issueTitle must be a non-empty string.");
  }

  const issueDescription = normalizeText(input.issueDescription);
  const commentText = normalizeText(input.commentText);
  const sourceText = [issueTitle, issueDescription, commentText].filter((part) => part.length > 0).join("\n\n");
  const classification = classifyIntentText({
    issueTitle,
    issueDescription,
    commentText,
  });

  return {
    type: classification.type,
    issueTitle,
    issueDescription,
    commentText,
    sourceText,
    requiredCapabilities: normalizeCapabilities(input.requiredCapabilities),
    codingScore: classification.codingScore,
    researchScore: classification.researchScore,
    confidence: classification.confidence,
    matchedSignals: classification.matchedSignals,
  };
}

export function confidenceGateDecision(
  intent: Pick<OperatorIntent, "type" | "confidence">,
  thresholds: Partial<Record<OperatorIntentType, number>> = {},
): ConfidenceGateDecision {
  const configuredThreshold = thresholds[intent.type] ?? DEFAULT_CONFIDENCE_THRESHOLDS[intent.type];
  if (configuredThreshold < 0 || configuredThreshold > 1) {
    throw new Error(`Confidence threshold for "${intent.type}" must be between 0 and 1.`);
  }

  const pass = intent.confidence >= configuredThreshold;
  return {
    pass,
    threshold: configuredThreshold,
    confidence: intent.confidence,
    rationale: `confidence=${intent.confidence.toFixed(3)} threshold=${configuredThreshold.toFixed(3)}`,
  };
}

export function buildExecutionPlan(input: BuildExecutionPlanInput): ExecutionPlan {
  const intent = buildIntent(input);

  // When no explicit capabilities are provided, derive defaults from the detected intent type.
  // This ensures research intents get research capabilities (not coding ones) and vice versa.
  const explicitCapabilities = normalizeCapabilities(input.requiredCapabilities);
  const effectiveCapabilities =
    explicitCapabilities.length > 0
      ? explicitCapabilities
      : normalizeCapabilities([...(INTENT_DEFAULT_CAPABILITIES[intent.type] ?? [])]);
  // Replace the intent's requiredCapabilities with the effective set
  const effectiveIntent: OperatorIntent = {
    ...intent,
    requiredCapabilities: effectiveCapabilities,
  };

  const confidenceDecision = confidenceGateDecision(effectiveIntent, input.confidenceThresholds);
  const policyDecision = evaluateRiskPolicy({
    intent: effectiveIntent,
    confidenceDecision,
    maxRiskLevel: input.maxRiskLevel,
  });

  const contextSignals = extractContextSignals(effectiveIntent);
  const errorSignatures = extractErrorSignaturesFromText(
    [effectiveIntent.issueTitle, effectiveIntent.issueDescription, effectiveIntent.commentText].join("\n"),
  );

  const resolutionRequest: ResolutionRequest = {
    intentType: effectiveIntent.type,
    issueTitle: effectiveIntent.issueTitle,
    issueDescription: effectiveIntent.issueDescription,
    commentText: effectiveIntent.commentText,
    requiredCapabilities: [...effectiveIntent.requiredCapabilities],
    contextSignals,
    errorSignatures,
    preferredAgentIds: normalizeDefinitionIds(input.preferredAgentIds),
    blockedAgentIds: normalizeDefinitionIds(input.blockedAgentIds),
    preferredToolIds: normalizeDefinitionIds(input.preferredToolIds),
    blockedToolIds: normalizeDefinitionIds(input.blockedToolIds),
    preferredResourceIds: normalizeDefinitionIds(input.preferredResourceIds),
    blockedResourceIds: normalizeDefinitionIds(input.blockedResourceIds),
    maxRiskLevel: input.maxRiskLevel,
  };

  const resolution = resolveAgentComposition(input.registry, resolutionRequest);
  const resolvedCapabilities = collectResolvedCapabilities(resolution);
  const validation = buildValidationReport({
    confidenceDecision,
    policyAllowsAuto: policyDecision.allowAutoExecution,
    requiredCapabilities: effectiveIntent.requiredCapabilities,
    resolvedCapabilities,
  });

  const decisionLog: DecisionRecord[] = [
    {
      stage: "intent",
      outcome: "allow",
      rationale: `Classified as "${effectiveIntent.type}" with confidence ${effectiveIntent.confidence.toFixed(3)}.`,
      confidence: effectiveIntent.confidence,
    },
    {
      stage: "confidence_gate",
      outcome: confidenceDecision.pass ? "allow" : "escalate",
      rationale: confidenceDecision.rationale,
      confidence: confidenceDecision.confidence,
    },
    {
      stage: "policy",
      outcome: policyDecision.allowAutoExecution ? "allow" : "escalate",
      rationale: policyDecision.rationale,
    },
    {
      stage: "resolver",
      outcome: "allow",
      rationale: resolution.rationale,
    },
    {
      stage: "planning",
      outcome: validation.valid ? "allow" : "deny",
      rationale: validation.valid ? "Execution plan is valid." : validation.errors.join("; "),
    },
  ];

  const steps = toExecutionSteps({
    confidenceDecision,
    requiresHumanApproval: policyDecision.requiresHumanApproval,
    autoMitigations: policyDecision.autoMitigation.actions,
    autoAllowed: policyDecision.allowAutoExecution,
    selectedAgentId: resolution.selectedAgent.id,
  });

  const engineTransitions = buildEngineTransitions({
    intent: effectiveIntent,
    resolution,
    confidenceDecision,
    policyDecision,
    validation,
    decisionLog,
    steps,
  });

  return {
    intent: effectiveIntent,
    resolution,
    confidenceDecision,
    policyDecision,
    decisionLog,
    engineTransitions,
    validation,
    steps,
  };
}
