import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultAgentDefinitions } from "../../../src/agents/default-definitions.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import type { RegisteredAgentDefinition } from "../../../src/agents/types.js";
import { renderPromptFile, renderTemplate } from "../../../src/prompts/render.js";
import { buildToolRegistry } from "../../../src/providers/tool-registry.js";

const tempDirs: string[] = [];

describe("AgentRegistry", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map(async (directory) => rm(directory, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("resolves a default agent by id and version", () => {
    const registry = new AgentRegistry(defaultAgentDefinitions);

    const agent = registry.resolve("agent_marketing_content_creator", "1.0.0");

    expect(agent.name).toBe("Content Creator");
    expect(agent.model).toBe("gpt-5.4");
    expect(agent.system_prompt_ref.endsWith("src/prompts/assets/content-creator.md")).toBe(true);
  });

  it("returns the latest enabled version when the caller omits a version", () => {
    const contentCreatorDefinition = defaultAgentDefinitions[0];

    if (!contentCreatorDefinition) {
      throw new Error("Expected a default content creator definition");
    }

    const upgradedDefinition: RegisteredAgentDefinition = {
      ...contentCreatorDefinition,
      version: "1.1.0",
      model: "gpt-5"
    };

    const registry = new AgentRegistry([
      ...defaultAgentDefinitions,
      upgradedDefinition
    ]);

    const agent = registry.resolve("agent_marketing_content_creator");

    expect(agent.version).toBe("1.1.0");
    expect(agent.model).toBe("gpt-5");
  });

  it("fails prompt rendering when a referenced variable is missing", () => {
    expect(() => renderTemplate("Objective: {{objective}}\nOwner: {{owner}}", { objective: "Ship v1" })).toThrowError(
      /Missing prompt variables: owner/
    );
  });

  it("renders markdown prompt assets after stripping frontmatter", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "xena-prompt-"));
    const promptPath = path.join(tempDir, "prompt.md");
    tempDirs.push(tempDir);

    await writeFile(
      promptPath,
      "---\nname: Example\n---\n# Prompt\nObjective: {{objective}}\n",
      "utf8"
    );

    const rendered = await renderPromptFile(promptPath, {
      objective: "Launch campaign"
    });

    expect(rendered.startsWith("# Prompt")).toBe(true);
    expect(rendered).toContain("Objective: Launch campaign");
  });

  it("rejects agents that declare tools missing from the runtime allowlist", () => {
    const registry = new AgentRegistry(defaultAgentDefinitions);
    const agent = registry.resolve("agent_marketing_growth_hacker");

    expect(() =>
      buildToolRegistry(agent, {
        Read: {
          description: "Read files",
          name: "Read"
        }
      })
    ).toThrowError(/tool "WebFetch" is not declared/i);
  });
});
