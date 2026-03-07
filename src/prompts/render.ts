import { readFile } from "node:fs/promises";

const TEMPLATE_VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const FRONTMATTER_PATTERN = /^---\n[\s\S]*?\n---\n?/;

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_PATTERN, "").trim();
}

export function renderTemplate(
  template: string,
  variables: Record<string, string | number | boolean>
): string {
  const missingVariables = new Set<string>();
  const rendered = template.replace(TEMPLATE_VARIABLE_PATTERN, (_, key: string) => {
    const value = variables[key];

    if (value === undefined) {
      missingVariables.add(key);
      return "";
    }

    return String(value);
  });

  if (missingVariables.size > 0) {
    throw new Error(
      `Missing prompt variables: ${Array.from(missingVariables).join(", ")}`
    );
  }

  return rendered;
}

export async function renderPromptFile(
  promptPath: string,
  variables: Record<string, string | number | boolean>
): Promise<string> {
  const markdown = await readFile(promptPath, "utf8");

  return renderTemplate(stripFrontmatter(markdown), variables);
}
