import type { ResolutionResult, RiskLevel } from "../registry/schema.js";

export type OperatorIntentType = "coding" | "research";

export type OperatorIntent = {
  type: OperatorIntentType;
  issueTitle: string;
  issueDescription: string;
  commentText: string;
  sourceText: string;
  requiredCapabilities: readonly string[];
  codingScore: number;
  researchScore: number;
  confidence: number;
  matchedSignals: readonly string[];
};

export type ConfidenceGateDecision = {
  pass: boolean;
  threshold: number;
  confidence: number;
  rationale: string;
};

export type AutoMitigationDecision = {
  enabled: boolean;
  actions: readonly string[];
};

export type PolicyDecision = {
  riskLevel: RiskLevel;
  allowAutoExecution: boolean;
  requiresHumanApproval: boolean;
  flags: readonly string[];
  rationale: string;
  autoMitigation: AutoMitigationDecision;
};

export type DecisionStage = "intent" | "confidence_gate" | "policy" | "resolver" | "planning";
export type DecisionOutcome = "allow" | "deny" | "escalate";

export type DecisionRecord = {
  stage: DecisionStage;
  outcome: DecisionOutcome;
  rationale: string;
  confidence?: number;
};

export type ValidationCheckSeverity = "error" | "warning";

export type ValidationCheck = {
  name: string;
  passed: boolean;
  severity: ValidationCheckSeverity;
  detail: string;
};

export type ValidationReport = {
  valid: boolean;
  checks: readonly ValidationCheck[];
  errors: readonly string[];
  warnings: readonly string[];
};

export type ExecutionStepMode = "automatic" | "manual";

export type ExecutionStep = {
  id: string;
  description: string;
  mode: ExecutionStepMode;
};

export type EngineStage =
  | "understand"
  | "prove"
  | "plan"
  | "confidence_gate"
  | "execute"
  | "validate"
  | "learn"
  | "adapt";

export type EngineTransitionMetadataValue = string | number | boolean | null;

export type EngineTransitionMetadata = Readonly<Record<string, EngineTransitionMetadataValue>>;

export type EngineTransitionRecord = {
  from: EngineStage | null;
  to: EngineStage;
  rationale: string;
  occurredAt: string;
  metadata?: EngineTransitionMetadata;
};

export type ExecutionPlan = {
  intent: OperatorIntent;
  resolution: ResolutionResult;
  confidenceDecision: ConfidenceGateDecision;
  policyDecision: PolicyDecision;
  decisionLog: readonly DecisionRecord[];
  engineTransitions: readonly EngineTransitionRecord[];
  validation: ValidationReport;
  steps: readonly ExecutionStep[];
};
