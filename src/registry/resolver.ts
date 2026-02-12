import {
  ResolutionResultSchema,
  type AgentDefinition,
  type IntentType,
  type RegistryBundle,
  type ResolutionRequest,
  type ResolutionResult,
  type ResourceDefinition,
  type RiskLevel,
  type SkillDefinition,
  type ToolDefinition,
} from "./schema.js";
import { compareSemanticVersions, selectHighestVersion } from "./versioning.js";

export const RESOLVER_VERSION = "1.4.0";

type CandidateEvaluation = {
  agent: AgentDefinition;
  skills: SkillDefinition[];
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  rationale: string[];
  preferred: boolean;
  preferenceScore: number;
  matchedPreferredToolIds: string[];
  matchedPreferredResourceIds: string[];
  learned: boolean;
  promoted: boolean;
  promotionState: string;
  learnedQualityScore: number;
  learnedActivationScore: number;
  matchedContextSignals: string[];
  matchedErrorSignatures: string[];
};

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

type VersionedEnabledDefinition = {
  id: string;
  version: string;
  enabled: boolean;
};

function splitDefinitionReference(reference: string): { id: string; version: string | null } {
  const splitIndex = reference.lastIndexOf("@");
  if (splitIndex <= 0) return { id: reference, version: null };
  return {
    id: reference.slice(0, splitIndex),
    version: reference.slice(splitIndex + 1),
  };
}

function resolveReference<T extends VersionedEnabledDefinition>(definitions: readonly T[], reference: string): T | null {
  const { id, version } = splitDefinitionReference(reference);
  const matching = definitions.filter((entry) => entry.id === id && entry.enabled);
  if (matching.length === 0) return null;

  if (version) {
    return matching.find((entry) => entry.version === version) ?? null;
  }

  return selectHighestVersion(matching, (left, right) => right.id.localeCompare(left.id));
}

function resolveReferences<T extends VersionedEnabledDefinition>(
  definitions: readonly T[],
  references: readonly string[],
): T[] | null {
  const resolved: T[] = [];
  for (const reference of references) {
    const match = resolveReference(definitions, reference);
    if (!match) return null;
    resolved.push(match);
  }
  return resolved;
}

function isRiskWithinLimit(agentMaxRisk: RiskLevel | undefined, requestMaxRisk: RiskLevel | undefined): boolean {
  if (!agentMaxRisk || !requestMaxRisk) return true;
  return RISK_ORDER[agentMaxRisk] <= RISK_ORDER[requestMaxRisk];
}

function collectCapabilities(
  tools: readonly ToolDefinition[],
  resources: readonly ResourceDefinition[],
): ReadonlySet<string> {
  return new Set(
    [...tools.flatMap((tool) => tool.capabilities), ...resources.flatMap((resource) => resource.capabilities)].map(
      (value) => value.trim(),
    ),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function sortedUniqueSignals(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
}

function metadataBoolean(metadata: Record<string, unknown>, key: string): boolean | null {
  const value = metadata[key];
  if (typeof value !== "boolean") return null;
  return value;
}

function collectCandidateContextSignals(opts: {
  agent: AgentDefinition;
  skills: readonly SkillDefinition[];
  tools: readonly ToolDefinition[];
  resources: readonly ResourceDefinition[];
}): ReadonlySet<string> {
  const values: string[] = [
    opts.agent.id,
    opts.agent.name,
    ...opts.agent.tags,
    ...opts.agent.intentTypes,
    ...opts.skills.flatMap((skill) => [
      skill.id,
      skill.name,
      ...skill.tags,
      ...skill.requiredCapabilities,
      ...skill.preferredToolIds,
      ...skill.preferredResourceIds,
    ]),
    ...opts.tools.flatMap((tool) => [tool.id, tool.name, ...tool.tags, ...tool.capabilities]),
    ...opts.resources.flatMap((resource) => [resource.id, resource.name, ...resource.tags, ...resource.capabilities]),
    ...metadataStringArray(opts.agent.metadata, "selectedStrategy"),
    ...metadataStringArray(opts.agent.metadata, "selectedToolId"),
    ...metadataStringArray(opts.agent.metadata, "strategyPath"),
    ...opts.skills.flatMap((skill) => [
      ...metadataStringArray(skill.metadata, "selectedStrategy"),
      ...metadataStringArray(skill.metadata, "selectedToolId"),
      ...metadataStringArray(skill.metadata, "strategyPath"),
    ]),
  ];

  return new Set(sortedUniqueSignals(values));
}

function collectCandidateErrorSignatures(opts: {
  agent: AgentDefinition;
  skills: readonly SkillDefinition[];
  tools: readonly ToolDefinition[];
  resources: readonly ResourceDefinition[];
}): ReadonlySet<string> {
  const values: string[] = [
    ...metadataStringArray(opts.agent.metadata, "triggerErrorKinds"),
    ...metadataStringArray(opts.agent.metadata, "errorSignatures"),
    ...opts.skills.flatMap((skill) => [
      ...metadataStringArray(skill.metadata, "triggerErrorKinds"),
      ...metadataStringArray(skill.metadata, "errorSignatures"),
    ]),
    ...opts.tools.flatMap((tool) => [
      ...metadataStringArray(tool.metadata, "triggerErrorKinds"),
      ...metadataStringArray(tool.metadata, "errorSignatures"),
    ]),
    ...opts.resources.flatMap((resource) => [
      ...metadataStringArray(resource.metadata, "triggerErrorKinds"),
      ...metadataStringArray(resource.metadata, "errorSignatures"),
    ]),
  ];
  return new Set(sortedUniqueSignals(values));
}

function hasLearnedMarker(opts: {
  agent: AgentDefinition;
  skills: readonly SkillDefinition[];
  tools: readonly ToolDefinition[];
}): boolean {
  if (opts.agent.id.includes(".learned.") || opts.agent.tags.some((tag) => tag.toLowerCase() === "learned")) return true;
  if ("learnedAt" in opts.agent.metadata) return true;
  if (opts.skills.some((skill) => skill.id.includes(".learned.") || skill.tags.some((tag) => tag.toLowerCase() === "learned"))) {
    return true;
  }
  if (opts.tools.some((tool) => tool.id.includes(".learned.") || tool.tags.some((tag) => tag.toLowerCase() === "learned"))) {
    return true;
  }
  return false;
}

function resolveLearnedPromotion(opts: {
  agent: AgentDefinition;
  skills: readonly SkillDefinition[];
  tools: readonly ToolDefinition[];
}): { promoted: boolean; promotionState: string; qualityScore: number } {
  const metadataList: Record<string, unknown>[] = [
    opts.agent.metadata,
    ...opts.skills.map((skill) => skill.metadata),
    ...opts.tools.map((tool) => tool.metadata),
  ];

  let promoted = false;
  let promotionState = "observational";
  let qualityScore = 50;
  let qualitySeen = false;

  for (const metadata of metadataList) {
    const metadataPromoted = metadataBoolean(metadata, "promoted");
    const metadataState = metadataString(metadata, "promotionState");
    const metadataQuality = metadataNumber(metadata, "qualityScore");

    if (metadataPromoted === true) promoted = true;
    if (metadataState && ["observational", "promoted", "disabled"].includes(metadataState)) {
      promotionState = metadataState;
    }
    if (metadataQuality !== null) {
      qualityScore = qualitySeen ? Math.max(qualityScore, metadataQuality) : metadataQuality;
      qualitySeen = true;
    }
  }

  if (promotionState === "disabled") promoted = false;
  if (!promoted && promotionState === "promoted") promoted = true;
  if (promoted && qualityScore < 60) {
    promoted = false;
    promotionState = "observational";
  }

  return {
    promoted,
    promotionState,
    qualityScore: Math.max(0, Math.min(100, qualityScore)),
  };
}

function intersectSorted(left: readonly string[], rightSet: ReadonlySet<string>): string[] {
  return left.filter((value) => rightSet.has(value));
}

/**
 * Scan the registry for additional tools that provide missing capabilities.
 * Excludes tools already in the agent's fixed list and blocked tools.
 * Returns supplemental tools sorted by capability coverage (most capabilities first).
 */
function findSupplementalTools(
  bundle: RegistryBundle,
  missingCapabilities: readonly string[],
  existingToolIds: ReadonlySet<string>,
  blockedToolIds: readonly string[],
  maxRiskLevel: RiskLevel | undefined,
): ToolDefinition[] {
  const blockedSet = new Set(blockedToolIds);
  const missingSet = new Set(missingCapabilities);
  const supplemental: Array<{ tool: ToolDefinition; coverage: number }> = [];

  for (const tool of bundle.tools) {
    if (!tool.enabled) continue;
    if (existingToolIds.has(tool.id)) continue;
    if (blockedSet.has(tool.id)) continue;
    if (maxRiskLevel && RISK_ORDER[tool.riskLevel] > RISK_ORDER[maxRiskLevel]) continue;

    const providedMissing = tool.capabilities.filter((cap) => missingSet.has(cap));
    if (providedMissing.length === 0) continue;

    supplemental.push({ tool, coverage: providedMissing.length });
  }

  // Sort by coverage descending to minimize the number of supplemental tools needed
  supplemental.sort((a, b) => b.coverage - a.coverage);

  // Greedily select tools until all missing capabilities are covered
  const selected: ToolDefinition[] = [];
  const remaining = new Set(missingCapabilities);
  for (const { tool } of supplemental) {
    if (remaining.size === 0) break;
    const provides = tool.capabilities.filter((cap) => remaining.has(cap));
    if (provides.length === 0) continue;
    selected.push(tool);
    for (const cap of provides) remaining.delete(cap);
  }

  return selected;
}

/**
 * Scan the registry for additional resources that provide missing capabilities.
 * Excludes resources already in the agent's fixed list and blocked resources.
 */
function findSupplementalResources(
  bundle: RegistryBundle,
  missingCapabilities: readonly string[],
  existingResourceIds: ReadonlySet<string>,
  blockedResourceIds: readonly string[],
  intentType: IntentType,
): ResourceDefinition[] {
  const blockedSet = new Set(blockedResourceIds);
  const missingSet = new Set(missingCapabilities);
  const supplemental: Array<{ resource: ResourceDefinition; coverage: number }> = [];

  for (const resource of bundle.resources) {
    if (!resource.enabled) continue;
    if (existingResourceIds.has(resource.id)) continue;
    if (blockedSet.has(resource.id)) continue;
    if (!resource.intentTypes.includes(intentType)) continue;

    const providedMissing = resource.capabilities.filter((cap) => missingSet.has(cap));
    if (providedMissing.length === 0) continue;

    supplemental.push({ resource, coverage: providedMissing.length });
  }

  supplemental.sort((a, b) => b.coverage - a.coverage);

  const selected: ResourceDefinition[] = [];
  const remaining = new Set(missingCapabilities);
  for (const { resource } of supplemental) {
    if (remaining.size === 0) break;
    const provides = resource.capabilities.filter((cap) => remaining.has(cap));
    if (provides.length === 0) continue;
    selected.push(resource);
    for (const cap of provides) remaining.delete(cap);
  }

  return selected;
}

function evaluateCandidate(bundle: RegistryBundle, request: ResolutionRequest, agent: AgentDefinition): CandidateEvaluation | null {
  const skills = resolveReferences(bundle.skills, agent.skillIds);
  let tools = resolveReferences(bundle.tools, agent.toolIds);
  let resources = resolveReferences(bundle.resources, agent.resourceIds);

  if (!skills || !tools || !resources) {
    return null;
  }

  if (agent.constraints.requireDeterministicTools && tools.some((tool) => !tool.deterministic)) {
    return null;
  }

  if (tools.some((tool) => request.blockedToolIds.includes(tool.id))) {
    return null;
  }

  if (resources.some((resource) => request.blockedResourceIds.includes(resource.id))) {
    return null;
  }

  if (!isRiskWithinLimit(agent.constraints.maxRiskLevel, request.maxRiskLevel)) {
    return null;
  }

  let supplementedToolIds: string[] = [];
  let supplementedResourceIds: string[] = [];
  let capabilities = collectCapabilities(tools, resources);
  const requiredCapabilities = sortedUnique([
    ...request.requiredCapabilities,
    ...skills.flatMap((skill) => skill.requiredCapabilities),
  ]);
  const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.has(capability));

  // Dynamic composition: when the agent's fixed tools/resources don't cover all required
  // capabilities, scan the full registry for supplemental tools/resources that can fill the gaps.
  // This enables newly registered capabilities to be usable without manually wiring into agents.
  if (missingCapabilities.length > 0) {
    const existingToolIds = new Set(tools.map((t) => t.id));
    const existingResourceIds = new Set(resources.map((r) => r.id));

    const supplementalTools = findSupplementalTools(
      bundle,
      missingCapabilities,
      existingToolIds,
      request.blockedToolIds,
      request.maxRiskLevel,
    );
    const supplementalResources = findSupplementalResources(
      bundle,
      missingCapabilities,
      existingResourceIds,
      request.blockedResourceIds,
      request.intentType,
    );

    if (supplementalTools.length > 0 || supplementalResources.length > 0) {
      // Re-validate agent constraints against supplemental additions
      if (agent.constraints.requireDeterministicTools && supplementalTools.some((tool) => !tool.deterministic)) {
        return null;
      }
      supplementedToolIds = supplementalTools.map((t) => t.id);
      supplementedResourceIds = supplementalResources.map((r) => r.id);
      tools = [...tools, ...supplementalTools];
      resources = [...resources, ...supplementalResources];
      capabilities = collectCapabilities(tools, resources);
    }

    // Re-check after augmentation
    const stillMissing = requiredCapabilities.filter((capability) => !capabilities.has(capability));
    if (stillMissing.length > 0) {
      return null;
    }
  }

  const requestContextSignals = sortedUniqueSignals(request.contextSignals);
  const requestErrorSignatures = sortedUniqueSignals(request.errorSignatures);
  const candidateContextSignals = collectCandidateContextSignals({
    agent,
    skills,
    tools,
    resources,
  });
  const candidateErrorSignatures = collectCandidateErrorSignatures({
    agent,
    skills,
    tools,
    resources,
  });

  const matchedContextSignals = intersectSorted(requestContextSignals, candidateContextSignals);
  const matchedErrorSignatures = intersectSorted(requestErrorSignatures, candidateErrorSignatures);
  const matchedPreferredToolIds = intersectSorted(
    sortedUnique(request.preferredToolIds),
    new Set(tools.map((tool) => tool.id)),
  );
  const matchedPreferredResourceIds = intersectSorted(
    sortedUnique(request.preferredResourceIds),
    new Set(resources.map((resource) => resource.id)),
  );

  const learned = hasLearnedMarker({ agent, skills, tools });
  const promotion = learned
    ? resolveLearnedPromotion({
        agent,
        skills,
        tools,
      })
    : { promoted: false, promotionState: "n/a", qualityScore: 0 };
  let learnedActivationScore = 0;
  if (learned && promotion.promoted) {
    const hasErrorSignatureModel = candidateErrorSignatures.size > 0;
    if (!hasErrorSignatureModel || matchedErrorSignatures.length > 0) {
      learnedActivationScore =
        matchedErrorSignatures.length * 100 +
        matchedContextSignals.length * 5 +
        Math.round(promotion.qualityScore * 0.25);
    }
  }

  const preferred = request.preferredAgentIds.includes(agent.id);
  const preferenceScore =
    !learned || promotion.promoted ? matchedPreferredToolIds.length * 12 + matchedPreferredResourceIds.length * 8 : 0;
  const rationale = [
    `agent=${agent.id}@${agent.version}`,
    `weight=${agent.weight}`,
    `skills=${skills.length}`,
    `tools=${tools.length}`,
    `resources=${resources.length}`,
    preferred ? "preferred=true" : "preferred=false",
    `preference_score=${preferenceScore}`,
    `preferred_tools_match=[${matchedPreferredToolIds.join(", ")}]`,
    `preferred_resources_match=[${matchedPreferredResourceIds.join(", ")}]`,
    learned
      ? `learned=true promoted=${promotion.promoted} promotion_state=${promotion.promotionState} quality_score=${promotion.qualityScore} activation=${learnedActivationScore} context_match=[${matchedContextSignals.join(", ")}] error_match=[${matchedErrorSignatures.join(", ")}]`
      : "learned=false",
  ];
  if (requiredCapabilities.length > 0) {
    rationale.push(`capabilities=[${requiredCapabilities.join(", ")}]`);
  }
  if (supplementedToolIds.length > 0) {
    rationale.push(`supplemented_tools=[${supplementedToolIds.join(", ")}]`);
  }
  if (supplementedResourceIds.length > 0) {
    rationale.push(`supplemented_resources=[${supplementedResourceIds.join(", ")}]`);
  }

  return {
    agent,
    skills,
    tools,
    resources,
    rationale,
    preferred,
    preferenceScore,
    matchedPreferredToolIds,
    matchedPreferredResourceIds,
    learned,
    promoted: promotion.promoted,
    promotionState: promotion.promotionState,
    learnedQualityScore: promotion.qualityScore,
    learnedActivationScore,
    matchedContextSignals,
    matchedErrorSignatures,
  };
}

function compareCandidates(left: CandidateEvaluation, right: CandidateEvaluation): number {
  if (left.preferred !== right.preferred) return left.preferred ? -1 : 1;

  if (left.preferenceScore !== right.preferenceScore) {
    return right.preferenceScore - left.preferenceScore;
  }

  if (left.learnedActivationScore !== right.learnedActivationScore) {
    return right.learnedActivationScore - left.learnedActivationScore;
  }

  const leftInactiveLearned = left.learned && left.learnedActivationScore === 0;
  const rightInactiveLearned = right.learned && right.learnedActivationScore === 0;
  if (leftInactiveLearned !== rightInactiveLearned) return leftInactiveLearned ? 1 : -1;

  if (left.learnedQualityScore !== right.learnedQualityScore) {
    return right.learnedQualityScore - left.learnedQualityScore;
  }

  if (left.agent.weight !== right.agent.weight) return right.agent.weight - left.agent.weight;

  const versionComparison = compareSemanticVersions(right.agent.version, left.agent.version);
  if (versionComparison !== 0) return versionComparison;

  return left.agent.id.localeCompare(right.agent.id);
}

export function resolveAgentComposition(bundle: RegistryBundle, request: ResolutionRequest): ResolutionResult {
  const normalizedRequest: ResolutionRequest = {
    ...request,
    contextSignals: sortedUniqueSignals(request.contextSignals),
    errorSignatures: sortedUniqueSignals(request.errorSignatures),
    preferredAgentIds: sortedUnique(request.preferredAgentIds),
    blockedAgentIds: sortedUnique(request.blockedAgentIds),
    preferredToolIds: sortedUnique(request.preferredToolIds),
    blockedToolIds: sortedUnique(request.blockedToolIds),
    preferredResourceIds: sortedUnique(request.preferredResourceIds),
    blockedResourceIds: sortedUnique(request.blockedResourceIds),
  };

  const candidates = bundle.agents
    .filter((agent) => agent.enabled)
    .filter((agent) => agent.intentTypes.includes(normalizedRequest.intentType))
    .filter((agent) => !normalizedRequest.blockedAgentIds.includes(agent.id))
    .map((agent) => evaluateCandidate(bundle, normalizedRequest, agent))
    .filter((candidate): candidate is CandidateEvaluation => candidate !== null)
    .sort(compareCandidates);

  if (candidates.length === 0) {
    throw new Error(`No eligible agent composition found for intent "${normalizedRequest.intentType}".`);
  }

  const selected = candidates[0];
  const rationale = [
    `resolver=${RESOLVER_VERSION}`,
    `intent=${normalizedRequest.intentType}`,
    `considered=${candidates.length}`,
    `selected=${selected.agent.id}@${selected.agent.version}`,
    normalizedRequest.errorSignatures.length > 0
      ? `request_error_signatures=[${normalizedRequest.errorSignatures.join(", ")}]`
      : "request_error_signatures=[]",
    normalizedRequest.contextSignals.length > 0
      ? `request_context_signals=[${normalizedRequest.contextSignals.join(", ")}]`
      : "request_context_signals=[]",
    ...selected.rationale,
  ].join("; ");

  return ResolutionResultSchema.parse({
    intentType: normalizedRequest.intentType,
    selectedVersion: selected.agent.version,
    resolverVersion: RESOLVER_VERSION,
    rationale,
    selectedAgent: selected.agent,
    selectedSkills: selected.skills,
    selectedTools: selected.tools,
    selectedResources: selected.resources,
  });
}
