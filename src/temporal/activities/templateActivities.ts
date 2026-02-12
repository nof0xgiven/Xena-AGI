import fs from "node:fs/promises";

export async function renderPromptTemplate(opts: {
  templatePath: string;
  variables: Record<string, string>;
}): Promise<string> {
  let text = await fs.readFile(opts.templatePath, "utf8");
  for (const [k, v] of Object.entries(opts.variables)) {
    text = text.replaceAll(`$${k}`, v);
  }
  return text;
}

export async function readFileIfExists(opts: { path: string }): Promise<string | null> {
  try {
    return await fs.readFile(opts.path, "utf8");
  } catch {
    return null;
  }
}

