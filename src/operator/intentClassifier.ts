import type { OperatorIntentType } from "./types.js";

type WeightedSignal = {
  label: string;
  pattern: RegExp;
  weight: number;
};

export type IntentClassification = {
  type: OperatorIntentType;
  codingScore: number;
  researchScore: number;
  confidence: number;
  matchedSignals: readonly string[];
};

export type IntentClassificationInput = {
  issueTitle: string;
  issueDescription?: string | null;
  commentText?: string | null;
};

const CODING_SIGNALS: readonly WeightedSignal[] = [
  { label: "coding:bugfix", pattern: /\b(bug|fix|defect|regression|crash|error)\b/gi, weight: 3 },
  { label: "coding:implementation", pattern: /\b(implement|build|create|add|refactor|patch)\b/gi, weight: 2.5 },
  { label: "coding:repo_flow", pattern: /\b(pr|pull request|commit|branch|merge)\b/gi, weight: 2.5 },
  { label: "coding:quality", pattern: /\b(test|typecheck|lint|compile)\b/gi, weight: 2 },
  { label: "coding:technical", pattern: /\b(api|endpoint|database|schema|typescript|javascript|node)\b/gi, weight: 1.5 },
  { label: "coding:file_refs", pattern: /\b[a-z0-9_./-]+\.(ts|tsx|js|jsx|py|go|java|rb|rs)\b/gi, weight: 3 },
  { label: "coding:inline_code", pattern: /`[^`\n]+`/g, weight: 2 },
];

const RESEARCH_SIGNALS: readonly WeightedSignal[] = [
  { label: "research:investigation", pattern: /\b(research|investigate|analyze|analyse|evaluate|compare)\b/gi, weight: 3 },
  { label: "research:summary", pattern: /\b(summary|summarize|overview|findings|insight|report)\b/gi, weight: 2.5 },
  { label: "research:market", pattern: /\b(market|competitor|benchmark|trend|survey)\b/gi, weight: 2 },
  { label: "research:sources", pattern: /\b(source|citation|reference|paper|article|news)\b/gi, weight: 2.5 },
  { label: "research:present", pattern: /\b(presentation|slides|deck)\b/gi, weight: 2.5 },
  { label: "research:question", pattern: /\b(what is|why|how does|explain)\b/gi, weight: 1.5 },
];

function normalizeInput(input: IntentClassificationInput): string {
  return [input.issueTitle, input.issueDescription ?? "", input.commentText ?? ""].join("\n\n").trim();
}

function scoreSignals(text: string, signals: readonly WeightedSignal[]): { score: number; hits: string[] } {
  let score = 0;
  const hits: string[] = [];
  for (const signal of signals) {
    const matches = text.match(signal.pattern);
    const count = matches?.length ?? 0;
    if (count > 0) {
      score += count * signal.weight;
      hits.push(`${signal.label}(${count})`);
    }
  }
  return { score, hits };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function classifyIntentText(input: IntentClassificationInput): IntentClassification {
  const text = normalizeInput(input);
  const lower = text.toLowerCase();

  const coding = scoreSignals(text, CODING_SIGNALS);
  const research = scoreSignals(text, RESEARCH_SIGNALS);

  let codingScore = coding.score;
  let researchScore = research.score;

  if (/```/.test(text)) {
    codingScore += 4;
    coding.hits.push("coding:fenced_code(1)");
  }
  if (/\b(src\/|npm run|tsc\b|eslint\b)\b/i.test(text)) {
    codingScore += 2.5;
    coding.hits.push("coding:command_or_path(1)");
  }
  if (/^\s*(why|what|how)\b/i.test(lower)) {
    researchScore += 1.5;
    research.hits.push("research:leading_question(1)");
  }
  if (/\?/.test(text)) {
    researchScore += 0.5;
    research.hits.push("research:question_mark(1)");
  }

  let type: OperatorIntentType;
  if (codingScore > researchScore) {
    type = "coding";
  } else if (researchScore > codingScore) {
    type = "research";
  } else if (/\b[a-z0-9_./-]+\.(ts|tsx|js|jsx|py|go|java|rb|rs)\b/i.test(text) || /```/.test(text)) {
    type = "coding";
  } else {
    type = "research";
  }

  const total = codingScore + researchScore;
  const confidence = total > 0 ? 0.5 + Math.abs(codingScore - researchScore) / (2 * total) : 0.5;

  return {
    type,
    codingScore: round3(codingScore),
    researchScore: round3(researchScore),
    confidence: round3(Math.min(0.99, confidence)),
    matchedSignals: [...coding.hits, ...research.hits].sort((left, right) => left.localeCompare(right)),
  };
}

