import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AgentDefinitionSchema,
  RegistryBundleSchema,
  ResourceDefinitionSchema,
  SkillDefinitionSchema,
  ToolDefinitionSchema,
  type RegistryBundle,
} from "./schema.js";
import { compareSemanticVersions } from "./versioning.js";

const RegistryFileSchema = z
  .object({
    tools: z.array(ToolDefinitionSchema).optional(),
    resources: z.array(ResourceDefinitionSchema).optional(),
    skills: z.array(SkillDefinitionSchema).optional(),
    agents: z.array(AgentDefinitionSchema).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Registry file must contain at least one of: "tools", "resources", "skills", "agents".',
  });

export type RegistryLoaderOptions = {
  baseDir?: string;
  requireFiles?: boolean;
};

export const DEFAULT_REGISTRY_DIR = "config/registry";

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const pathText = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${pathText}: ${issue.message}`;
    })
    .join("; ");
}

function sortDefinitions<T extends { id: string; version: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    const idComparison = left.id.localeCompare(right.id);
    if (idComparison !== 0) return idComparison;

    const versionComparison = compareSemanticVersions(right.version, left.version);
    if (versionComparison !== 0) return versionComparison;

    return 0;
  });
}

export async function loadRegistryBundle(options: RegistryLoaderOptions = {}): Promise<RegistryBundle> {
  const baseDir = path.resolve(process.cwd(), options.baseDir ?? DEFAULT_REGISTRY_DIR);
  const requireFiles = options.requireFiles ?? true;

  let directoryEntries: Dirent[];
  try {
    directoryEntries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    const isMissingDirectory = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!isMissingDirectory || requireFiles) {
      throw new Error(`Unable to read registry directory "${baseDir}": ${(error as Error).message}`);
    }
    return RegistryBundleSchema.parse({});
  }

  const jsonFiles = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (jsonFiles.length === 0) {
    if (requireFiles) {
      throw new Error(`Registry directory "${baseDir}" does not contain any .json files.`);
    }
    return RegistryBundleSchema.parse({});
  }

  const merged = {
    tools: [] as z.infer<typeof ToolDefinitionSchema>[],
    resources: [] as z.infer<typeof ResourceDefinitionSchema>[],
    skills: [] as z.infer<typeof SkillDefinitionSchema>[],
    agents: [] as z.infer<typeof AgentDefinitionSchema>[],
  };

  for (const fileName of jsonFiles) {
    const fullPath = path.join(baseDir, fileName);
    const raw = await fs.readFile(fullPath, "utf8");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in "${fullPath}": ${(error as Error).message}`);
    }

    const parsedFile = RegistryFileSchema.safeParse(parsedJson);
    if (!parsedFile.success) {
      throw new Error(`Invalid registry file "${fullPath}": ${formatValidationIssues(parsedFile.error)}`);
    }

    merged.tools.push(...(parsedFile.data.tools ?? []));
    merged.resources.push(...(parsedFile.data.resources ?? []));
    merged.skills.push(...(parsedFile.data.skills ?? []));
    merged.agents.push(...(parsedFile.data.agents ?? []));
  }

  const validated = RegistryBundleSchema.safeParse(merged);
  if (!validated.success) {
    throw new Error(`Merged registry is invalid: ${formatValidationIssues(validated.error)}`);
  }

  return {
    tools: sortDefinitions(validated.data.tools),
    resources: sortDefinitions(validated.data.resources),
    skills: sortDefinitions(validated.data.skills),
    agents: sortDefinitions(validated.data.agents),
  };
}
