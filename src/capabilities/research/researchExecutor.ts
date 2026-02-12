import {
  RESEARCH_SECTION_ORDER,
  buildResearchBrief,
  type ResearchBrief,
  type ResearchSectionKey,
} from "./briefBuilder.js";

export type ResearchExecutorRequest = {
  topic: string;
  objective: string;
  audience?: string;
  constraints?: readonly string[];
  questions?: readonly string[];
  sourceHints?: readonly string[];
  requiredSections?: readonly ResearchSectionKey[];
  maxSources?: number;
};

export type ResearchExecutorParseMode = "json" | "text";

export type ParsedResearchExecutorOutput = {
  brief: ResearchBrief;
  parseMode: ResearchExecutorParseMode;
  warnings: string[];
};

type StructuredResearchOutput = {
  summary: string;
  findings: string[];
  risks: string[];
  recommendations: string[];
  openQuestions: string[];
  sources: string[];
};

const SECTION_LABELS: Record<ResearchSectionKey, string> = {
  summary: "Summary",
  findings: "Key Findings",
  risks: "Risks",
  recommendations: "Recommendations",
  openQuestions: "Open Questions",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = cleanText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function readStringValue(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw !== "string") continue;
    const normalized = cleanText(raw);
    if (normalized) return normalized;
  }
  return null;
}

function readStringArrayValue(obj: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const raw = obj[key];
    if (Array.isArray(raw)) {
      const items = cleanList(raw.filter((item): item is string => typeof item === "string"));
      if (items.length > 0) return items;
      continue;
    }
    if (typeof raw === "string") {
      const normalized = cleanText(raw);
      if (!normalized) continue;
      return [normalized];
    }
  }
  return [];
}

function normalizeRequiredSections(
  sections: readonly ResearchSectionKey[] | undefined,
): ResearchSectionKey[] {
  const base = sections && sections.length > 0 ? sections : RESEARCH_SECTION_ORDER;
  const seen = new Set<ResearchSectionKey>();
  const out: ResearchSectionKey[] = [];
  for (const section of base) {
    if (seen.has(section)) continue;
    seen.add(section);
    out.push(section);
  }
  return out;
}

function extractJsonCandidate(rawOutput: string): string | null {
  const fencedMatch = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) return fencedMatch[1].trim();

  const firstBrace = rawOutput.indexOf("{");
  const lastBrace = rawOutput.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return rawOutput.slice(firstBrace, lastBrace + 1).trim();
  }

  return null;
}

function parseStructuredOutput(rawOutput: string): StructuredResearchOutput | null {
  const candidate = extractJsonCandidate(rawOutput);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const sections = isRecord(parsed.sections) ? parsed.sections : null;
  const summary =
    readStringValue(parsed, ["summary", "overview", "executiveSummary"]) ??
    (sections ? readStringValue(sections, ["summary", "overview"]) : null) ??
    "";

  const findings = [
    ...readStringArrayValue(parsed, ["findings", "keyFindings"]),
    ...(sections ? readStringArrayValue(sections, ["findings", "keyFindings"]) : []),
  ];
  const risks = [
    ...readStringArrayValue(parsed, ["risks", "risk"]),
    ...(sections ? readStringArrayValue(sections, ["risks", "risk"]) : []),
  ];
  const recommendations = [
    ...readStringArrayValue(parsed, ["recommendations", "actions", "nextSteps"]),
    ...(sections ? readStringArrayValue(sections, ["recommendations", "actions", "nextSteps"]) : []),
  ];
  const openQuestions = [
    ...readStringArrayValue(parsed, ["openQuestions", "open_questions", "questions"]),
    ...(sections ? readStringArrayValue(sections, ["openQuestions", "open_questions", "questions"]) : []),
  ];
  const sources = [
    ...readStringArrayValue(parsed, ["sources", "references", "citations"]),
    ...(sections ? readStringArrayValue(sections, ["sources", "references", "citations"]) : []),
  ];

  return {
    summary,
    findings: cleanList(findings),
    risks: cleanList(risks),
    recommendations: cleanList(recommendations),
    openQuestions: cleanList(openQuestions),
    sources: cleanList(sources),
  };
}

function renderStructuredAsRaw(structured: StructuredResearchOutput): string {
  const lines: string[] = [];

  lines.push("# Summary");
  lines.push(structured.summary || "No summary provided.");
  lines.push("");

  lines.push("## Key Findings");
  if (structured.findings.length > 0) {
    for (const finding of structured.findings) lines.push(`- ${finding}`);
  } else {
    lines.push("- No findings provided.");
  }
  lines.push("");

  lines.push("## Risks");
  if (structured.risks.length > 0) {
    for (const risk of structured.risks) lines.push(`- ${risk}`);
  } else {
    lines.push("- No risks provided.");
  }
  lines.push("");

  lines.push("## Recommendations");
  if (structured.recommendations.length > 0) {
    for (const recommendation of structured.recommendations) lines.push(`- ${recommendation}`);
  } else {
    lines.push("- No recommendations provided.");
  }
  lines.push("");

  lines.push("## Open Questions");
  if (structured.openQuestions.length > 0) {
    for (const question of structured.openQuestions) lines.push(`- ${question}`);
  } else {
    lines.push("- No open questions provided.");
  }
  lines.push("");

  if (structured.sources.length > 0) {
    lines.push("## Sources");
    for (const source of structured.sources) lines.push(`- ${source}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

function truncateSources(brief: ResearchBrief, maxSources: number): ResearchBrief {
  const bounded = Math.max(1, Math.floor(maxSources));
  if (brief.sources.length <= bounded) return brief;
  return {
    ...brief,
    sources: brief.sources.slice(0, bounded),
  };
}

export function buildResearchPrompt(request: ResearchExecutorRequest): string {
  const requiredSections = normalizeRequiredSections(request.requiredSections);
  const constraints = cleanList(request.constraints);
  const questions = cleanList(request.questions);
  const sourceHints = cleanList(request.sourceHints);
  const maxSources = request.maxSources != null ? Math.max(1, Math.floor(request.maxSources)) : 8;

  const lines: string[] = [];
  lines.push("You are a research execution engine for software and product decisions.");
  lines.push("Return factual, concise findings with explicit sources.");
  lines.push("");
  lines.push(`Topic: ${cleanText(request.topic)}`);
  lines.push(`Objective: ${cleanText(request.objective)}`);
  if (request.audience) lines.push(`Audience: ${cleanText(request.audience)}`);
  lines.push("");
  lines.push("Required sections:");
  for (const section of requiredSections) {
    lines.push(`- ${SECTION_LABELS[section]}`);
  }

  if (constraints.length > 0) {
    lines.push("");
    lines.push("Constraints:");
    for (const constraint of constraints) lines.push(`- ${constraint}`);
  }

  if (questions.length > 0) {
    lines.push("");
    lines.push("Questions to answer:");
    for (const question of questions) lines.push(`- ${question}`);
  }

  if (sourceHints.length > 0) {
    lines.push("");
    lines.push("Preferred source hints:");
    for (const hint of sourceHints) lines.push(`- ${hint}`);
  }

  lines.push("");
  lines.push("Output requirements:");
  lines.push("- Return JSON only.");
  lines.push("- Keep findings specific and non-redundant.");
  lines.push(`- Include up to ${maxSources} source URLs in the sources array.`);
  lines.push("- Use this schema exactly:");
  lines.push(
    JSON.stringify(
      {
        summary: "string",
        findings: ["string"],
        risks: ["string"],
        recommendations: ["string"],
        openQuestions: ["string"],
        sources: ["https://example.com"],
      },
      null,
      2,
    ),
  );

  return lines.join("\n");
}

export function parseResearchExecutorOutput(
  rawOutput: string,
  request?: Pick<ResearchExecutorRequest, "topic" | "sourceHints" | "maxSources">,
): ParsedResearchExecutorOutput {
  const warnings: string[] = [];
  const structured = parseStructuredOutput(rawOutput);
  const parseMode: ResearchExecutorParseMode = structured ? "json" : "text";

  if (!structured) {
    warnings.push("Executor output was not valid JSON; fallback text normalization was used.");
  }

  const sourceHints = cleanList([
    ...(request?.sourceHints ?? []),
    ...(structured?.sources ?? []),
  ]);

  const brief = buildResearchBrief(structured ? renderStructuredAsRaw(structured) : rawOutput, {
    title: request?.topic,
    sourceHints,
  });

  const boundedBrief =
    request?.maxSources != null ? truncateSources(brief, request.maxSources) : brief;

  return {
    brief: boundedBrief,
    parseMode,
    warnings,
  };
}
