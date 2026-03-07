import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { AgentIdSchema } from "../contracts/common.js";
import type {
  AgentRoleType,
  KnownAgentTool,
  RegisteredAgentDefinition
} from "./types.js";
import { KNOWN_AGENT_TOOLS } from "./types.js";
import { compareVersions } from "./versioning.js";

const DEFAULT_MANIFEST_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agents"
);
const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);
const AgentRoleTypeSchema = z.enum(["leaf", "supervisor"]);
const ManifestSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  agent_id: AgentIdSchema,
  version: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  domain: z.string().trim().min(1),
  role_type: AgentRoleTypeSchema,
  reports_to: AgentIdSchema.nullable(),
  allowed_delegate_to: z.array(AgentIdSchema),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoning_effort: ReasoningEffortSchema,
  prompt_ref: z.string().trim().min(1),
  tools: z.array(z.string().trim().min(1)),
  skills: z.array(z.string().trim().min(1)),
  output_schema_ref: z.string().trim().min(1).nullable(),
  timeout_ms: z.number().int().positive(),
  max_tool_calls: z.number().int().nonnegative(),
  enabled: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true })
});

type AgentManifest = z.infer<typeof ManifestSchema>;

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function collectManifestFiles(manifestDir: string): string[] {
  if (!existsSync(manifestDir)) {
    return [];
  }

  const files = readdirSync(manifestDir, {
    withFileTypes: true
  }).flatMap((entry) => {
    const absolutePath = path.join(manifestDir, entry.name);

    if (entry.isDirectory()) {
      return collectManifestFiles(absolutePath);
    }

    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
      return [];
    }

    return [absolutePath];
  });

  return files.sort((left, right) => left.localeCompare(right));
}

function resolvePromptPath(input: {
  manifestFile: string;
  promptRef: string;
  rootDir: string;
}): string {
  const promptPath = path.isAbsolute(input.promptRef)
    ? input.promptRef
    : input.promptRef.startsWith("./") || input.promptRef.startsWith("../")
      ? path.resolve(path.dirname(input.manifestFile), input.promptRef)
      : path.resolve(input.rootDir, input.promptRef);

  if (!existsSync(promptPath)) {
    throw new Error(
      `Agent manifest ${toPosix(input.manifestFile)} references missing prompt ${input.promptRef}`
    );
  }

  return promptPath;
}

function validateTopology(definitions: readonly RegisteredAgentDefinition[]): void {
  const enabledDefinitionsById = new Map<string, RegisteredAgentDefinition>();
  const seenDefinitions = new Set<string>();

  for (const definition of definitions.filter((candidate) => candidate.enabled)) {
    const current = enabledDefinitionsById.get(definition.agent_id);

    if (!current || compareVersions(current.version, definition.version) < 0) {
      enabledDefinitionsById.set(definition.agent_id, definition);
    }
  }

  for (const definition of definitions) {
    const definitionKey = `${definition.agent_id}@${definition.version}`;

    if (seenDefinitions.has(definitionKey)) {
      throw new Error(`Duplicate agent definition: ${definitionKey}`);
    }

    seenDefinitions.add(definitionKey);

    if (definition.role_type === "leaf" && definition.allowed_delegate_to.length > 0) {
      throw new Error(
        `Leaf agent ${definition.agent_id} cannot declare allowed_delegate_to`
      );
    }

    if (definition.role_type === "supervisor" && definition.allowed_delegate_to.length === 0) {
      throw new Error(
        `Supervisor agent ${definition.agent_id} must declare at least one allowed_delegate_to target`
      );
    }

    if (definition.reports_to) {
      const manager = enabledDefinitionsById.get(definition.reports_to);

      if (!manager) {
        throw new Error(
          `Agent ${definition.agent_id} reports_to unknown enabled agent ${definition.reports_to}`
        );
      }

      if (manager.role_type !== "supervisor") {
        throw new Error(
          `Agent ${definition.agent_id} reports_to non-supervisor agent ${definition.reports_to}`
        );
      }

      if (manager.domain !== definition.domain) {
        throw new Error(
          `Agent ${definition.agent_id} must report within its domain ${definition.domain}`
        );
      }
    }

    for (const delegateAgentId of definition.allowed_delegate_to) {
      if (delegateAgentId === definition.agent_id) {
        throw new Error(
          `Agent ${definition.agent_id} cannot include itself in allowed_delegate_to`
        );
      }

      const targetDefinition = enabledDefinitionsById.get(delegateAgentId);

      if (!targetDefinition) {
        throw new Error(
          `Agent ${definition.agent_id} allowed_delegate_to references unknown enabled agent ${delegateAgentId}`
        );
      }

      if (targetDefinition.domain !== definition.domain) {
        throw new Error(
          `Agent ${definition.agent_id} cannot delegate across domains to ${delegateAgentId}`
        );
      }
    }
  }
}

function validateManifestTools(input: {
  manifest: AgentManifest;
  manifestFile: string;
}): void {
  for (const toolName of input.manifest.tools) {
    if (!KNOWN_AGENT_TOOLS.includes(toolName as KnownAgentTool)) {
      throw new Error(
        `Agent manifest ${toPosix(input.manifestFile)} declares unknown tool ${toolName}`
      );
    }
  }
}

function toRegisteredAgentDefinition(input: {
  manifest: AgentManifest;
  manifestFile: string;
  rootDir: string;
}): RegisteredAgentDefinition {
  return {
    schema_version: input.manifest.schema_version,
    agent_id: input.manifest.agent_id,
    version: input.manifest.version,
    name: input.manifest.name,
    description: input.manifest.description,
    domain: input.manifest.domain,
    role_type: input.manifest.role_type as AgentRoleType,
    reports_to: input.manifest.reports_to,
    allowed_delegate_to: input.manifest.allowed_delegate_to,
    provider: input.manifest.provider,
    model: input.manifest.model,
    reasoning_effort: input.manifest.reasoning_effort,
    system_prompt_ref: resolvePromptPath({
      manifestFile: input.manifestFile,
      promptRef: input.manifest.prompt_ref,
      rootDir: input.rootDir
    }),
    tools: input.manifest.tools as KnownAgentTool[],
    skills: input.manifest.skills,
    execution_mode: "single_shot",
    supervisor_mode: input.manifest.role_type === "supervisor",
    output_schema_ref: input.manifest.output_schema_ref,
    timeout_ms: input.manifest.timeout_ms,
    max_tool_calls: input.manifest.max_tool_calls,
    enabled: input.manifest.enabled,
    created_at: input.manifest.created_at,
    updated_at: input.manifest.updated_at
  };
}

export function loadAgentDefinitions(input: {
  manifestDir?: string;
  rootDir?: string;
} = {}): RegisteredAgentDefinition[] {
  const rootDir = input.rootDir ?? DEFAULT_REPO_ROOT;
  const manifestDir = input.manifestDir ?? DEFAULT_MANIFEST_ROOT;
  const files = collectManifestFiles(manifestDir);

  if (files.length === 0) {
    throw new Error(`No agent manifests found under ${toPosix(manifestDir)}`);
  }

  const definitions = files.map((manifestFile) => {
    const parsed: unknown = parseYaml(readFileSync(manifestFile, "utf8"));
    const manifest = ManifestSchema.parse(parsed);

    validateManifestTools({
      manifest,
      manifestFile
    });

    return toRegisteredAgentDefinition({
      manifest,
      manifestFile,
      rootDir
    });
  });

  validateTopology(definitions);

  return definitions;
}
