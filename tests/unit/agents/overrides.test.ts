import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentRegistry } from "../../../src/agents/registry.js";
import { loadAgentDefinitions } from "../../../src/agents/manifest-loader.js";
import { loadAgentOverrides } from "../../../src/agents/override-loader.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xena-agent-overrides-"));
  tempDirs.push(rootDir);
  await mkdir(path.join(rootDir, "agents", "base"), { recursive: true });
  await mkdir(path.join(rootDir, "agents", "overrides"), { recursive: true });
  await mkdir(path.join(rootDir, "prompts"), { recursive: true });
  await writeFile(
    path.join(rootDir, "prompts", "base.md"),
    "# Base prompt\nObjective: {{objective}}\n",
    "utf8"
  );
  await writeFile(
    path.join(rootDir, "prompts", "override.md"),
    "# Override prompt\nObjective: {{objective}}\n",
    "utf8"
  );

  return rootDir;
}

describe("agent overrides", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (directory) =>
        rm(directory, { force: true, recursive: true })
      )
    );
    tempDirs.length = 0;
  });

  it("applies environment, business, then project overrides in precedence order", async () => {
    const rootDir = await createWorkspace();

    await writeFile(
      path.join(rootDir, "agents", "base", "content.yaml"),
      `schema_version: "1.0"
agent_id: agent_override_target
version: "1.0.0"
name: Override Target
description: Base definition
domain: marketing
role_type: leaf
reports_to: null
allowed_delegate_to: []
provider: openai
model: gpt-5.4
reasoning_effort: medium
prompt_ref: prompts/base.md
tools: [Read]
skills: [base_skill]
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );
    await writeFile(
      path.join(rootDir, "agents", "overrides", "environment.yaml"),
      `schema_version: "1.0"
override_id: env_override
match:
  agent_id: agent_override_target
  environment: development
patch:
  model: gpt-5.4-mini
`,
      "utf8"
    );
    await writeFile(
      path.join(rootDir, "agents", "overrides", "business.yaml"),
      `schema_version: "1.0"
override_id: business_override
match:
  agent_id: agent_override_target
  business_id: biz_demo
patch:
  reasoning_effort: high
  skills: [business_skill]
`,
      "utf8"
    );
    await writeFile(
      path.join(rootDir, "agents", "overrides", "project.yaml"),
      `schema_version: "1.0"
override_id: project_override
match:
  agent_id: agent_override_target
  project_id: proj_demo
patch:
  prompt_ref: prompts/override.md
  tools: [Read, Write]
`,
      "utf8"
    );

    const definitions = loadAgentDefinitions({
      manifestDir: path.join(rootDir, "agents", "base"),
      rootDir
    });
    const overrides = loadAgentOverrides({
      definitions,
      overrideDir: path.join(rootDir, "agents", "overrides"),
      rootDir
    });
    const registry = new AgentRegistry(definitions, overrides);
    const resolved = registry.resolve("agent_override_target", undefined, {
      businessId: "biz_demo",
      environment: "development",
      projectId: "proj_demo"
    });

    expect(resolved.model).toBe("gpt-5.4-mini");
    expect(resolved.reasoning_effort).toBe("high");
    expect(resolved.skills).toEqual(["business_skill"]);
    expect(resolved.tools).toEqual(["Read", "Write"]);
    expect(resolved.system_prompt_ref).toBe(
      path.join(rootDir, "prompts", "override.md")
    );
  });

  it("rejects overrides that target unknown agents", async () => {
    const rootDir = await createWorkspace();

    await writeFile(
      path.join(rootDir, "agents", "base", "content.yaml"),
      `schema_version: "1.0"
agent_id: agent_override_target
version: "1.0.0"
name: Override Target
description: Base definition
domain: marketing
role_type: leaf
reports_to: null
allowed_delegate_to: []
provider: openai
model: gpt-5.4
reasoning_effort: medium
prompt_ref: prompts/base.md
tools: [Read]
skills: [base_skill]
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );
    await writeFile(
      path.join(rootDir, "agents", "overrides", "unknown-agent.yaml"),
      `schema_version: "1.0"
override_id: unknown_agent_override
match:
  agent_id: agent_missing
patch:
  model: gpt-5.4-mini
`,
      "utf8"
    );

    const definitions = loadAgentDefinitions({
      manifestDir: path.join(rootDir, "agents", "base"),
      rootDir
    });

    expect(() =>
      loadAgentOverrides({
        definitions,
        overrideDir: path.join(rootDir, "agents", "overrides"),
        rootDir
      })
    ).toThrowError(/targets unknown agent/i);
  });
});
