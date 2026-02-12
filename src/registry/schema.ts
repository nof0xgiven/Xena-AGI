import { z } from "zod";

export const IntentTypeSchema = z.enum(["coding", "research"]);
export type IntentType = z.infer<typeof IntentTypeSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ToolDomainSchema = z.enum([
  "coding",
  "research",
  "communication",
  "tasks",
  "workflow",
  "memory",
  "project_management",
  "observability",
  "integration",
]);
export type ToolDomain = z.infer<typeof ToolDomainSchema>;

export const ToolOperationSchema = z.enum([
  "probe",
  "list",
  "read",
  "start",
  "stop",
  "restart",
  "execute",
  "analyze",
  "classify",
  "reply",
  "comment",
  "verify",
  "write",
  "search",
]);
export type ToolOperation = z.infer<typeof ToolOperationSchema>;

export const ToolTaskRoleSchema = z.enum(["source", "controller", "observer"]);
export type ToolTaskRole = z.infer<typeof ToolTaskRoleSchema>;

const DefinitionIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "id must be alphanumeric and may include . _ -");

const DefinitionRefSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9.+_-]*)?$/,
    "definition reference must be id or id@version",
  );

const VersionSchema = z.string().min(1);

const BaseDefinitionSchema = z
  .object({
    id: DefinitionIdSchema,
    name: z.string().min(1),
    version: VersionSchema,
    description: z.string().min(1),
    enabled: z.boolean().default(true),
    tags: z.array(z.string().min(1)).default([]),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();

export const ToolSurfaceSchema = z
  .object({
    domains: z.array(ToolDomainSchema).min(1),
    entities: z.array(z.string().min(1)).default([]),
    operations: z.array(ToolOperationSchema).min(1),
    taskRoles: z.array(ToolTaskRoleSchema).default([]),
    authority: z.number().min(0).max(1).default(0.5),
    freshnessSlaSec: z.number().int().positive().default(300),
  })
  .strict();
export type ToolSurface = z.infer<typeof ToolSurfaceSchema>;

export const ToolDefinitionSchema = BaseDefinitionSchema.extend({
  surface: ToolSurfaceSchema,
  capabilities: z.array(z.string().min(1)).default([]),
  deterministic: z.boolean().default(true),
  riskLevel: RiskLevelSchema.default("low"),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
}).strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ResourceDefinitionSchema = BaseDefinitionSchema.extend({
  provider: z.string().min(1),
  harness: z.string().min(1),
  model: z.string().min(1),
  intentTypes: z.array(IntentTypeSchema).min(1),
  capabilities: z.array(z.string().min(1)).default([]),
  latencyTier: z.enum(["fast", "balanced", "deep"]).default("balanced"),
  costTier: z.enum(["low", "medium", "high"]).default("medium"),
}).strict();
export type ResourceDefinition = z.infer<typeof ResourceDefinitionSchema>;

export const SkillDefinitionSchema = BaseDefinitionSchema.extend({
  intentTypes: z.array(IntentTypeSchema).min(1),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  preferredToolIds: z.array(DefinitionRefSchema).default([]),
  preferredResourceIds: z.array(DefinitionRefSchema).default([]),
  guardrails: z.array(z.string().min(1)).default([]),
  outputContract: z.record(z.unknown()).default({}),
}).strict();
export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

export const AgentDefinitionSchema = BaseDefinitionSchema.extend({
  intentTypes: z.array(IntentTypeSchema).min(1),
  skillIds: z.array(DefinitionRefSchema).default([]),
  toolIds: z.array(DefinitionRefSchema).default([]),
  resourceIds: z.array(DefinitionRefSchema).default([]),
  weight: z.number().int().min(0).default(0),
  constraints: z
    .object({
      maxRiskLevel: RiskLevelSchema.optional(),
      requireDeterministicTools: z.boolean().default(false),
    })
    .default({ requireDeterministicTools: false }),
}).strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

function validateUniqueDefinitions<T extends { id: string; version: string }>(
  entries: readonly T[],
  groupName: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = `${entry.id}@${entry.version}`;
    const previousIndex = seen.get(key);
    if (previousIndex === undefined) {
      seen.set(key, index);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate ${groupName} definition "${key}" found at indexes ${previousIndex} and ${index}.`,
      path: [groupName, index],
    });
  });
}

export const RegistryBundleSchema = z
  .object({
    tools: z.array(ToolDefinitionSchema).default([]),
    resources: z.array(ResourceDefinitionSchema).default([]),
    skills: z.array(SkillDefinitionSchema).default([]),
    agents: z.array(AgentDefinitionSchema).default([]),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    validateUniqueDefinitions(bundle.tools, "tools", ctx);
    validateUniqueDefinitions(bundle.resources, "resources", ctx);
    validateUniqueDefinitions(bundle.skills, "skills", ctx);
    validateUniqueDefinitions(bundle.agents, "agents", ctx);
  });
export type RegistryBundle = z.infer<typeof RegistryBundleSchema>;

export const ResolutionRequestSchema = z
  .object({
    intentType: IntentTypeSchema,
    issueTitle: z.string().min(1),
    issueDescription: z.string().default(""),
    commentText: z.string().default(""),
    requiredCapabilities: z.array(z.string().min(1)).default([]),
    contextSignals: z.array(z.string().min(1)).default([]),
    errorSignatures: z.array(z.string().min(1)).default([]),
    preferredAgentIds: z.array(DefinitionIdSchema).default([]),
    blockedAgentIds: z.array(DefinitionIdSchema).default([]),
    preferredToolIds: z.array(DefinitionIdSchema).default([]),
    blockedToolIds: z.array(DefinitionIdSchema).default([]),
    preferredResourceIds: z.array(DefinitionIdSchema).default([]),
    blockedResourceIds: z.array(DefinitionIdSchema).default([]),
    maxRiskLevel: RiskLevelSchema.optional(),
  })
  .strict();
export type ResolutionRequest = z.infer<typeof ResolutionRequestSchema>;

export const ResolutionResultSchema = z
  .object({
    intentType: IntentTypeSchema,
    selectedVersion: VersionSchema,
    resolverVersion: VersionSchema,
    rationale: z.string().min(1),
    selectedAgent: AgentDefinitionSchema,
    selectedSkills: z.array(SkillDefinitionSchema),
    selectedTools: z.array(ToolDefinitionSchema),
    selectedResources: z.array(ResourceDefinitionSchema),
  })
  .strict();
export type ResolutionResult = z.infer<typeof ResolutionResultSchema>;
