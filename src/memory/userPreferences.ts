import type { RiskLevel } from "../registry/schema.js";

export type UserPreferenceTone = "direct" | "balanced" | "friendly";
export type UserPreferenceUpdateCadence = "high" | "balanced" | "low";
export type UserPreferenceReplyVerbosity = "short" | "balanced" | "detailed";

export type UserPreferencesProfile = {
  version: 1;
  tone: UserPreferenceTone;
  updateCadence: UserPreferenceUpdateCadence;
  replyVerbosity: UserPreferenceReplyVerbosity;
  maxRiskLevel: RiskLevel;
  preferredAgentIds: string[];
  blockedAgentIds: string[];
  preferredToolIds: string[];
  blockedToolIds: string[];
  preferredResourceIds: string[];
  blockedResourceIds: string[];
};

export type UserPreferencesPatch = Partial<
  Omit<UserPreferencesProfile, "version" | "preferredAgentIds" | "blockedAgentIds" | "preferredToolIds" | "blockedToolIds" | "preferredResourceIds" | "blockedResourceIds">
> & {
  preferredAgentIds?: string[];
  blockedAgentIds?: string[];
  preferredToolIds?: string[];
  blockedToolIds?: string[];
  preferredResourceIds?: string[];
  blockedResourceIds?: string[];
};

export const DEFAULT_USER_PREFERENCES: UserPreferencesProfile = {
  version: 1,
  tone: "direct",
  updateCadence: "high",
  replyVerbosity: "balanced",
  maxRiskLevel: "high",
  preferredAgentIds: [],
  blockedAgentIds: [],
  preferredToolIds: [],
  blockedToolIds: [],
  preferredResourceIds: [],
  blockedResourceIds: [],
};

const TONE_SET = new Set<UserPreferenceTone>(["direct", "balanced", "friendly"]);
const UPDATE_CADENCE_SET = new Set<UserPreferenceUpdateCadence>(["high", "balanced", "low"]);
const REPLY_VERBOSITY_SET = new Set<UserPreferenceReplyVerbosity>(["short", "balanced", "detailed"]);
const RISK_LEVEL_SET = new Set<RiskLevel>(["low", "medium", "high"]);
const DEFINITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseEnum<T extends string>(value: unknown, allowed: Set<T>, field: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`"${field}" must be a string.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!allowed.has(normalized as T)) {
    throw new Error(`"${field}" must be one of: ${[...allowed].join(", ")}.`);
  }
  return normalized as T;
}

function parseDefinitionIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`"${field}" must be an array of definition ids.`);
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`"${field}" entries must be strings.`);
    }
    const trimmed = entry.trim();
    if (!DEFINITION_ID_PATTERN.test(trimmed)) {
      throw new Error(`"${field}" contains invalid definition id: "${entry}".`);
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function extractJsonCandidate(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;

  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) return fencedMatch[1].trim();

  const markerMatch = trimmed.match(/\[user_preferences_v1\]([\s\S]*)$/i);
  const fromMarker = markerMatch?.[1]?.trim();
  if (fromMarker && fromMarker.startsWith("{") && fromMarker.endsWith("}")) {
    return fromMarker;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  return objectMatch?.[0]?.trim() ?? null;
}

export function cloneUserPreferences(profile: UserPreferencesProfile): UserPreferencesProfile {
  return {
    ...profile,
    preferredAgentIds: [...profile.preferredAgentIds],
    blockedAgentIds: [...profile.blockedAgentIds],
    preferredToolIds: [...profile.preferredToolIds],
    blockedToolIds: [...profile.blockedToolIds],
    preferredResourceIds: [...profile.preferredResourceIds],
    blockedResourceIds: [...profile.blockedResourceIds],
  };
}

export function parseUserPreferencesPatch(value: unknown): UserPreferencesPatch {
  const obj = asRecord(value);
  if (!obj) {
    throw new Error("Preferences patch must be a JSON object.");
  }

  return {
    tone: parseEnum(obj.tone, TONE_SET, "tone"),
    updateCadence: parseEnum(obj.updateCadence, UPDATE_CADENCE_SET, "updateCadence"),
    replyVerbosity: parseEnum(obj.replyVerbosity, REPLY_VERBOSITY_SET, "replyVerbosity"),
    maxRiskLevel: parseEnum(obj.maxRiskLevel, RISK_LEVEL_SET, "maxRiskLevel"),
    preferredAgentIds: parseDefinitionIds(obj.preferredAgentIds, "preferredAgentIds"),
    blockedAgentIds: parseDefinitionIds(obj.blockedAgentIds, "blockedAgentIds"),
    preferredToolIds: parseDefinitionIds(obj.preferredToolIds, "preferredToolIds"),
    blockedToolIds: parseDefinitionIds(obj.blockedToolIds, "blockedToolIds"),
    preferredResourceIds: parseDefinitionIds(obj.preferredResourceIds, "preferredResourceIds"),
    blockedResourceIds: parseDefinitionIds(obj.blockedResourceIds, "blockedResourceIds"),
  };
}

export function applyUserPreferencesPatch(
  profile: UserPreferencesProfile,
  patch: UserPreferencesPatch,
): UserPreferencesProfile {
  return {
    version: 1,
    tone: patch.tone ?? profile.tone,
    updateCadence: patch.updateCadence ?? profile.updateCadence,
    replyVerbosity: patch.replyVerbosity ?? profile.replyVerbosity,
    maxRiskLevel: patch.maxRiskLevel ?? profile.maxRiskLevel,
    preferredAgentIds: patch.preferredAgentIds ?? [...profile.preferredAgentIds],
    blockedAgentIds: patch.blockedAgentIds ?? [...profile.blockedAgentIds],
    preferredToolIds: patch.preferredToolIds ?? [...profile.preferredToolIds],
    blockedToolIds: patch.blockedToolIds ?? [...profile.blockedToolIds],
    preferredResourceIds: patch.preferredResourceIds ?? [...profile.preferredResourceIds],
    blockedResourceIds: patch.blockedResourceIds ?? [...profile.blockedResourceIds],
  };
}

export function parseUserPreferencesFromMemoryContent(content: string): UserPreferencesProfile | null {
  const candidate = extractJsonCandidate(content);
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate);
    const record = asRecord(parsed);
    if (!record) return null;

    const patchSource = asRecord(record.profile) ?? record;
    const patch = parseUserPreferencesPatch(patchSource);
    return applyUserPreferencesPatch(DEFAULT_USER_PREFERENCES, patch);
  } catch {
    return null;
  }
}

export function serializeUserPreferencesForMemory(profile: UserPreferencesProfile): string {
  return `[user_preferences_v1]\n${JSON.stringify(profile, null, 2)}`;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

export function renderUserPreferencesForPrompt(profile: UserPreferencesProfile): string {
  return [
    `tone: ${profile.tone}`,
    `reply_verbosity: ${profile.replyVerbosity}`,
    `update_cadence: ${profile.updateCadence}`,
    `max_risk_level: ${profile.maxRiskLevel}`,
    `preferred_agent_ids: ${formatList(profile.preferredAgentIds)}`,
    `blocked_agent_ids: ${formatList(profile.blockedAgentIds)}`,
    `preferred_tool_ids: ${formatList(profile.preferredToolIds)}`,
    `blocked_tool_ids: ${formatList(profile.blockedToolIds)}`,
    `preferred_resource_ids: ${formatList(profile.preferredResourceIds)}`,
    `blocked_resource_ids: ${formatList(profile.blockedResourceIds)}`,
  ].join("\n");
}

function isCriticalIntent(intent: string): boolean {
  return (
    intent.includes("error") ||
    intent.includes("failed") ||
    intent.includes("blocked") ||
    intent.includes("clarification") ||
    intent.includes("question_answer") ||
    intent.includes("status") ||
    intent.includes("handoff") ||
    intent.startsWith("qa_") ||
    intent.startsWith("sandbox_") ||
    intent.includes("teardown") ||
    intent.includes("missing_plan")
  );
}

const BALANCED_SUPPRESSED = new Set<string>([
  "discover_start",
  "plan_start",
  "code_start",
  "ticket_take_ownership",
  "worktree_ready",
  "resume_from_existing_pr",
]);

export function shouldPostTeammateUpdate(profile: UserPreferencesProfile, intent: string): boolean {
  const normalized = intent.trim().toLowerCase();
  if (!normalized) return true;

  if (normalized.startsWith("command_")) return true;
  if (normalized === "status_ping") return true;

  if (profile.updateCadence === "high") {
    return true;
  }

  if (profile.updateCadence === "balanced") {
    if (BALANCED_SUPPRESSED.has(normalized) && !isCriticalIntent(normalized)) {
      return false;
    }
    return true;
  }

  return isCriticalIntent(normalized);
}
