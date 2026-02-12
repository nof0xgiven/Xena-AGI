import type { RiskLevel } from "../registry/schema.js";
import type { ConfidenceGateDecision, OperatorIntent, PolicyDecision } from "./types.js";

export type PolicyEvaluationInput = {
  intent: OperatorIntent;
  confidenceDecision: ConfidenceGateDecision;
  maxRiskLevel?: RiskLevel;
};

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\b/i,
  /\bdelete\s+all\b/i,
  /\bprod(uction)?\b/i,
  /\bcredential(s)?\b/i,
  /\bsecret(s)?\b/i,
  /\bapi[\s_-]?key\b/i,
  /\btoken(s)?\b/i,
  /\bauth(entication|orization)?\b/i,
  /\bsecurity\b/i,
  /\bbilling\b/i,
  /\bpayment(s)?\b/i,
];

const MEDIUM_RISK_PATTERNS: readonly RegExp[] = [
  /\bmigration(s)?\b/i,
  /\bschema\b/i,
  /\bdatabase\b/i,
  /\bdeploy(ment)?\b/i,
  /\binfra(structure)?\b/i,
  /\bwebhook\b/i,
  /\bworkflow\b/i,
  /\btemporal\b/i,
];

function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}

function toRiskLabel(index: number): RiskLevel {
  if (index <= RISK_ORDER.low) return "low";
  if (index === RISK_ORDER.medium) return "medium";
  return "high";
}

function evaluateTextRisk(text: string): { level: RiskLevel; flags: string[] } {
  const flags: string[] = [];
  let level: RiskLevel = "low";

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(text)) {
      flags.push(`high:${pattern.source}`);
      level = "high";
    }
  }

  if (level !== "high") {
    for (const pattern of MEDIUM_RISK_PATTERNS) {
      if (pattern.test(text)) {
        flags.push(`medium:${pattern.source}`);
        level = "medium";
      }
    }
  } else {
    for (const pattern of MEDIUM_RISK_PATTERNS) {
      if (pattern.test(text)) {
        flags.push(`medium:${pattern.source}`);
      }
    }
  }

  return { level, flags };
}

function riskExceedsLimit(level: RiskLevel, maxRiskLevel: RiskLevel | undefined): boolean {
  if (!maxRiskLevel) return false;
  return RISK_ORDER[level] > RISK_ORDER[maxRiskLevel];
}

export function evaluateRiskPolicy(input: PolicyEvaluationInput): PolicyDecision {
  const textRisk = evaluateTextRisk(input.intent.sourceText);

  let riskLevel = textRisk.level;
  const flags = [...textRisk.flags];

  if (input.intent.type === "coding") {
    riskLevel = maxRisk(riskLevel, "medium");
  }
  if (!input.confidenceDecision.pass) {
    riskLevel = maxRisk(riskLevel, "medium");
    flags.push("confidence:below_threshold");
  }

  const exceedsLimit = riskExceedsLimit(riskLevel, input.maxRiskLevel);
  if (exceedsLimit) {
    flags.push(`policy:max_risk_exceeded:${input.maxRiskLevel}`);
  }

  // Full-autonomy default: only explicit configured risk caps block autonomous execution.
  const requiresHumanApproval = exceedsLimit;
  const allowAutoExecution = !exceedsLimit;

  const mitigationActions = [
    "Run static validation and type checks before execution.",
    "Constrain execution scope to requested files and capabilities.",
  ];
  if (!input.confidenceDecision.pass) {
    mitigationActions.push("Increase discovery depth before applying irreversible changes.");
  }
  if (riskLevel !== "low") {
    mitigationActions.push("Apply stricter validation and rollback-ready execution checkpoints.");
  }
  if (exceedsLimit) {
    mitigationActions.push("Block automatic execution until human approval is recorded.");
  }

  const rationale = [
    `risk=${riskLevel}`,
    `intent=${input.intent.type}`,
    `confidence=${input.confidenceDecision.confidence}`,
    `threshold=${input.confidenceDecision.threshold}`,
    `maxRisk=${input.maxRiskLevel ?? "none"}`,
    `flags=${flags.length}`,
  ].join("; ");

  return {
    riskLevel: toRiskLabel(RISK_ORDER[riskLevel]),
    allowAutoExecution,
    requiresHumanApproval,
    flags: flags.sort((left, right) => left.localeCompare(right)),
    rationale,
    autoMitigation: {
      enabled: mitigationActions.length > 0,
      actions: mitigationActions,
    },
  };
}
