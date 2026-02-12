import fs from "node:fs/promises";
import path from "node:path";

function getXenaRoot(): string {
  return process.env.XENA_ROOT || process.cwd();
}

function resolveXenaPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(getXenaRoot(), filePath);
}

export async function renderPromptTemplate(opts: {
  templatePath: string;
  variables: Record<string, string>;
}): Promise<string> {
  const resolved = resolveXenaPath(opts.templatePath);
  let text = await fs.readFile(resolved, "utf8");
  for (const [k, v] of Object.entries(opts.variables)) {
    text = text.replaceAll(`$${k}`, v);
  }
  return text;
}

export async function readFileIfExists(opts: { path: string }): Promise<string | null> {
  try {
    const resolved = resolveXenaPath(opts.path);
    return await fs.readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

export async function getOwnerTag(): Promise<string> {
  const name = process.env.XENA_OWNER_NAME || "";
  const profileUrl = process.env.XENA_OWNER_PROFILE_URL || "";
  if (name && profileUrl) return `${name}: ${profileUrl}`;
  if (name) return name;
  return "";
}

export async function resolveXenaFilePath(opts: { relativePath: string }): Promise<string> {
  return resolveXenaPath(opts.relativePath);
}
