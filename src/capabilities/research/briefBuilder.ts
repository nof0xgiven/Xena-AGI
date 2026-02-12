import {
  verifySourceUrls,
  type DuplicateSource,
  type InvalidSource,
  type VerifiedSource,
} from "./sourceVerifier.js";

export const RESEARCH_SECTION_ORDER = [
  "summary",
  "findings",
  "risks",
  "recommendations",
  "openQuestions",
] as const;

export type ResearchSectionKey = (typeof RESEARCH_SECTION_ORDER)[number];

export type ResearchBriefSection = {
  key: ResearchSectionKey;
  title: string;
  items: string[];
  narrative: string;
};

export type ResearchBrief = {
  title: string | null;
  generatedAt: string;
  summary: string;
  findings: string[];
  risks: string[];
  recommendations: string[];
  openQuestions: string[];
  sections: ResearchBriefSection[];
  sources: VerifiedSource[];
  duplicateSources: DuplicateSource[];
  invalidSources: InvalidSource[];
  rawOutput: string;
};

export type BuildResearchBriefOptions = {
  title?: string;
  generatedAt?: Date;
  sourceHints?: readonly string[];
  maxItemsPerSection?: number;
};

const SECTION_TITLES: Record<ResearchSectionKey, string> = {
  summary: "Summary",
  findings: "Key Findings",
  risks: "Risks",
  recommendations: "Recommendations",
  openQuestions: "Open Questions",
};

const SECTION_ALIASES: Record<ResearchSectionKey, readonly string[]> = {
  summary: ["summary", "overview", "executive summary", "tl dr"],
  findings: ["findings", "key findings", "evidence", "observations"],
  risks: ["risks", "risk", "concerns", "limitations"],
  recommendations: ["recommendations", "recommendation", "actions", "next steps"],
  openQuestions: ["open questions", "questions", "unknowns", "follow ups", "follow-up questions"],
};

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueNonEmpty(values: readonly string[]): string[] {
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

function normalizeSectionLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSectionKey(label: string): ResearchSectionKey | null {
  const normalizedLabel = normalizeSectionLabel(label);
  for (const key of RESEARCH_SECTION_ORDER) {
    const aliases = SECTION_ALIASES[key];
    if (aliases.some((alias) => normalizeSectionLabel(alias) === normalizedLabel)) {
      return key;
    }
  }
  return null;
}

function createBuckets(): Record<ResearchSectionKey, string[]> {
  return {
    summary: [],
    findings: [],
    risks: [],
    recommendations: [],
    openQuestions: [],
  };
}

function bucketLinesBySection(rawOutput: string): Record<ResearchSectionKey, string[]> {
  const buckets = createBuckets();
  let activeSection: ResearchSectionKey = "summary";

  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headingMatch = trimmed.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch) {
      const sectionKey = resolveSectionKey(headingMatch[1]);
      if (sectionKey) {
        activeSection = sectionKey;
        continue;
      }
    }

    const labelWithBodyMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9\s-]{1,48}):\s*(.*)$/);
    if (labelWithBodyMatch) {
      const sectionKey = resolveSectionKey(labelWithBodyMatch[1]);
      if (sectionKey) {
        activeSection = sectionKey;
        const trailingBody = cleanText(labelWithBodyMatch[2] ?? "");
        if (trailingBody) buckets[activeSection].push(trailingBody);
        continue;
      }
    }

    buckets[activeSection].push(trimmed);
  }

  return buckets;
}

function linesToItems(lines: readonly string[], maxItems: number): string[] {
  const bulletItems: string[] = [];
  const narrativeLines: string[] = [];

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (bulletMatch) {
      bulletItems.push(cleanText(bulletMatch[1]));
      continue;
    }
    if (line.trim()) narrativeLines.push(line);
  }

  if (bulletItems.length > 0) {
    return uniqueNonEmpty(bulletItems).slice(0, maxItems);
  }

  const narrative = cleanText(narrativeLines.join(" "));
  if (!narrative) return [];

  const sentenceCandidates = narrative.split(/(?<=[.!?])\s+/);
  const uniqueSentences = uniqueNonEmpty(sentenceCandidates);
  if (uniqueSentences.length > 0) {
    return uniqueSentences.slice(0, maxItems);
  }

  return [narrative].slice(0, maxItems);
}

function firstNonEmptyLine(rawOutput: string): string | null {
  for (const line of rawOutput.split(/\r?\n/)) {
    const normalized = cleanText(line);
    if (normalized) return normalized;
  }
  return null;
}

export function buildResearchBrief(
  rawOutput: string,
  options: BuildResearchBriefOptions = {},
): ResearchBrief {
  const normalizedRaw = rawOutput.trim();
  const maxItems = options.maxItemsPerSection ?? 6;
  const buckets = bucketLinesBySection(normalizedRaw);

  const findings = linesToItems(buckets.findings, maxItems);
  const risks = linesToItems(buckets.risks, maxItems);
  const recommendations = linesToItems(buckets.recommendations, maxItems);
  const openQuestions = linesToItems(buckets.openQuestions, maxItems);

  const summaryItems = linesToItems(buckets.summary, Math.max(1, maxItems));
  const summary =
    summaryItems[0] ??
    findings[0] ??
    firstNonEmptyLine(normalizedRaw) ??
    "No summary was produced by the research executor.";

  const verificationInput =
    options.sourceHints && options.sourceHints.length > 0
      ? [normalizedRaw, ...options.sourceHints]
      : normalizedRaw;
  const sourceVerification = verifySourceUrls(verificationInput);

  const sections: ResearchBriefSection[] = RESEARCH_SECTION_ORDER.map((key) => {
    const items =
      key === "summary"
        ? [summary]
        : key === "findings"
          ? findings
          : key === "risks"
            ? risks
            : key === "recommendations"
              ? recommendations
              : openQuestions;

    const narrative = cleanText(buckets[key].join(" "));
    return {
      key,
      title: SECTION_TITLES[key],
      items,
      narrative,
    };
  });

  return {
    title: options.title ? cleanText(options.title) : null,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    summary,
    findings,
    risks,
    recommendations,
    openQuestions,
    sections,
    sources: sourceVerification.valid,
    duplicateSources: sourceVerification.duplicates,
    invalidSources: sourceVerification.invalid,
    rawOutput: normalizedRaw,
  };
}
