import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ProjectSchema = z.object({
  projectKey: z.string().min(1),
  linearTeamKey: z.string().min(1),
  repoPath: z.string().min(1),
  worktreesRoot: z.string().min(1),
  cloneEnvScript: z.string().min(1),
});

const ProjectsSchema = z.array(ProjectSchema);

export type ProjectConfig = z.infer<typeof ProjectSchema>;

function expandEnvVars(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, name) => process.env[name] ?? "");
}

export async function loadProjectsConfig(): Promise<ProjectConfig[]> {
  const p = path.resolve(process.cwd(), "config/projects.json");
  let raw = await fs.readFile(p, "utf8");
  raw = expandEnvVars(raw);
  const parsed = ProjectsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid config/projects.json: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function resolveProjectForTeamKey(
  projects: ProjectConfig[],
  linearTeamKey: string,
): ProjectConfig | null {
  return projects.find((p) => p.linearTeamKey === linearTeamKey) ?? null;
}

export function resolveCloneEnvScriptPath(project: ProjectConfig): string {
  if (path.isAbsolute(project.cloneEnvScript)) return project.cloneEnvScript;
  return path.resolve(project.repoPath, project.cloneEnvScript);
}

