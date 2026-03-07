import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type {
  KnownAgentTool,
  RegisteredAgentDefinition,
  RegisteredAgentOverride
} from "./types.js";
import { KNOWN_AGENT_TOOLS } from "./types.js";

const DEFAULT_OVERRIDE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agents/overrides"
);
const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const MatchSchema = z.strictObject({
  agent_id: z.string().trim().min(1),
  version: z.string().trim().min(1).nullable().optional(),
  environment: z.string().trim().min(1).nullable().optional(),
  business_id: z.string().trim().min(1).nullable().optional(),
  project_id: z.string().trim().min(1).nullable().optional()
});
const PatchSchema = z
  .strictObject({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
    prompt_ref: z.string().trim().min(1).optional(),
    tools: z.array(z.string().trim().min(1)).optional(),
    skills: z.array(z.string().trim().min(1)).optional(),
    output_schema_ref: z.string().trim().min(1).nullable().optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().nonnegative().optional(),
    enabled: z.boolean().optional(),
    allowed_delegate_to: z.array(z.string().trim().min(1)).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Override patch must include at least one field"
  });
const OverrideSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  override_id: z.string().trim().min(1),
  match: MatchSchema,
  patch: PatchSchema
});

type RawOverride = z.infer<typeof OverrideSchema>;

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function collectOverrideFiles(overrideDir: string): string[] {
  if (!existsSync(overrideDir)) {
    return [];
  }

  return readdirSync(overrideDir, {
    withFileTypes: true
  })
    .flatMap((entry) => {
      const absolutePath = path.join(overrideDir, entry.name);

      if (entry.isDirectory()) {
        return collectOverrideFiles(absolutePath);
      }

      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
        return [];
      }

      return [absolutePath];
    })
    .sort((left, right) => left.localeCompare(right));
}

function resolvePromptOverridePath(input: {
  overrideFile: string;
  promptRef: string;
  rootDir: string;
}): string {
  const promptPath = path.isAbsolute(input.promptRef)
    ? input.promptRef
    : input.promptRef.startsWith("./") || input.promptRef.startsWith("../")
      ? path.resolve(path.dirname(input.overrideFile), input.promptRef)
      : path.resolve(input.rootDir, input.promptRef);

  if (!existsSync(promptPath)) {
    throw new Error(
      `Agent override ${toPosix(input.overrideFile)} references missing prompt ${input.promptRef}`
    );
  }

  return promptPath;
}

function validateOverrideTargets(input: {
  definitions: readonly RegisteredAgentDefinition[];
  override: RawOverride;
  overrideFile: string;
}): void {
  const targetDefinition = input.definitions.find(
    (definition) =>
      definition.agent_id === input.override.match.agent_id &&
      (input.override.match.version
        ? definition.version === input.override.match.version
        : true)
  );

  if (!targetDefinition) {
    throw new Error(
      `Agent override ${input.override.override_id} targets unknown agent ${input.override.match.agent_id}`
    );
  }

  if (input.override.patch.tools) {
    for (const toolName of input.override.patch.tools) {
      if (!KNOWN_AGENT_TOOLS.includes(toolName as KnownAgentTool)) {
        throw new Error(
          `Agent override ${input.override.override_id} declares unknown tool ${toolName}`
        );
      }
    }
  }

  if (input.override.patch.allowed_delegate_to) {
    for (const delegateAgentId of input.override.patch.allowed_delegate_to) {
      const delegateDefinition = input.definitions.find(
        (definition) => definition.agent_id === delegateAgentId
      );

      if (!delegateDefinition) {
        throw new Error(
          `Agent override ${input.override.override_id} references unknown delegate target ${delegateAgentId}`
        );
      }

      if (delegateDefinition.domain !== targetDefinition.domain) {
        throw new Error(
          `Agent override ${input.override.override_id} cannot delegate across domains to ${delegateAgentId}`
        );
      }
    }
  }

  if (
    input.override.patch.allowed_delegate_to &&
    targetDefinition.role_type === "leaf"
  ) {
    throw new Error(
      `Agent override ${input.override.override_id} cannot add allowed_delegate_to to leaf agent ${targetDefinition.agent_id}`
    );
  }
}

function toRegisteredAgentOverride(input: {
  definitions: readonly RegisteredAgentDefinition[];
  override: RawOverride;
  overrideFile: string;
  rootDir: string;
}): RegisteredAgentOverride {
  validateOverrideTargets(input);

  return {
    schema_version: input.override.schema_version,
    override_id: input.override.override_id,
    match: {
      agent_id: input.override.match.agent_id,
      ...("version" in input.override.match
        ? { version: input.override.match.version ?? null }
        : {}),
      ...("environment" in input.override.match
        ? { environment: input.override.match.environment ?? null }
        : {}),
      ...("business_id" in input.override.match
        ? { business_id: input.override.match.business_id ?? null }
        : {}),
      ...("project_id" in input.override.match
        ? { project_id: input.override.match.project_id ?? null }
        : {})
    },
    patch: {
      ...(input.override.patch.provider
        ? { provider: input.override.patch.provider }
        : {}),
      ...(input.override.patch.model
        ? { model: input.override.patch.model }
        : {}),
      ...(input.override.patch.reasoning_effort
        ? { reasoning_effort: input.override.patch.reasoning_effort }
        : {}),
      ...(input.override.patch.prompt_ref
        ? {
            system_prompt_ref: resolvePromptOverridePath({
              overrideFile: input.overrideFile,
              promptRef: input.override.patch.prompt_ref,
              rootDir: input.rootDir
            })
          }
        : {}),
      ...(input.override.patch.tools
        ? { tools: input.override.patch.tools }
        : {}),
      ...(input.override.patch.skills
        ? { skills: input.override.patch.skills }
        : {}),
      ...("output_schema_ref" in input.override.patch
        ? { output_schema_ref: input.override.patch.output_schema_ref ?? null }
        : {}),
      ...(input.override.patch.timeout_ms
        ? { timeout_ms: input.override.patch.timeout_ms }
        : {}),
      ...(input.override.patch.max_tool_calls !== undefined
        ? { max_tool_calls: input.override.patch.max_tool_calls }
        : {}),
      ...(input.override.patch.enabled !== undefined
        ? { enabled: input.override.patch.enabled }
        : {}),
      ...(input.override.patch.allowed_delegate_to
        ? { allowed_delegate_to: input.override.patch.allowed_delegate_to }
        : {})
    }
  };
}

export function loadAgentOverrides(input: {
  definitions: readonly RegisteredAgentDefinition[];
  overrideDir?: string;
  rootDir?: string;
}): RegisteredAgentOverride[] {
  const rootDir = input.rootDir ?? DEFAULT_REPO_ROOT;
  const overrideDir = input.overrideDir ?? DEFAULT_OVERRIDE_ROOT;
  const files = collectOverrideFiles(overrideDir);

  return files.map((overrideFile) => {
    const parsed: unknown = parseYaml(readFileSync(overrideFile, "utf8"));
    const override = OverrideSchema.parse(parsed);

    return toRegisteredAgentOverride({
      definitions: input.definitions,
      override,
      overrideFile,
      rootDir
    });
  });
}
