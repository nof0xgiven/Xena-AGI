import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgentDefinitions } from "../../../src/agents/manifest-loader.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xena-agents-"));
  tempDirs.push(rootDir);
  await mkdir(path.join(rootDir, "agents"), { recursive: true });
  await mkdir(path.join(rootDir, "prompts"), { recursive: true });

  await writeFile(
    path.join(rootDir, "prompts", "parent.md"),
    "# Parent\nObjective: {{objective}}\n",
    "utf8"
  );
  await writeFile(
    path.join(rootDir, "prompts", "child.md"),
    "# Child\nObjective: {{objective}}\n",
    "utf8"
  );

  return rootDir;
}

describe("agent manifests", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (directory) =>
        rm(directory, { force: true, recursive: true })
      )
    );
    tempDirs.length = 0;
  });

  it("loads yaml manifests, resolves prompts, and derives supervisor mode from role type", async () => {
    const rootDir = await createWorkspace();
    await mkdir(path.join(rootDir, "agents", "marketing"), { recursive: true });

    await writeFile(
      path.join(rootDir, "agents", "marketing", "parent.yaml"),
      `schema_version: "1.0"
agent_id: agent_parent
version: "1.0.0"
name: Parent
description: Coordinates work
provider: openai
model: gpt-5.4
reasoning_effort: high
prompt_ref: prompts/parent.md
tools: [Read, Write]
skills: [planning]
domain: marketing
role_type: supervisor
reports_to: null
allowed_delegate_to: [agent_child]
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 8
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );
    await writeFile(
      path.join(rootDir, "agents", "marketing", "child.yaml"),
      `schema_version: "1.0"
agent_id: agent_child
version: "1.0.0"
name: Child
description: Executes delegated work
provider: openai
model: gpt-5.4
reasoning_effort: medium
prompt_ref: prompts/child.md
tools: [Read]
skills: [execution]
domain: marketing
role_type: leaf
reports_to: agent_parent
allowed_delegate_to: []
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );

    const definitions = loadAgentDefinitions({
      manifestDir: path.join(rootDir, "agents"),
      rootDir
    });
    const parent = definitions.find((definition) => definition.agent_id === "agent_parent");
    const child = definitions.find((definition) => definition.agent_id === "agent_child");

    expect(parent).toMatchObject({
      agent_id: "agent_parent",
      allowed_delegate_to: ["agent_child"],
      domain: "marketing",
      reports_to: null,
      role_type: "supervisor",
      supervisor_mode: true
    });
    expect(parent?.system_prompt_ref).toBe(path.join(rootDir, "prompts", "parent.md"));
    expect(child).toMatchObject({
      agent_id: "agent_child",
      reports_to: "agent_parent",
      role_type: "leaf",
      supervisor_mode: false
    });
  });

  it("rejects manifests that reference unknown tools", async () => {
    const rootDir = await createWorkspace();

    await writeFile(
      path.join(rootDir, "agents", "invalid-tool.yaml"),
      `schema_version: "1.0"
agent_id: agent_invalid_tool
version: "1.0.0"
name: Invalid Tool
description: Uses an unsupported tool
provider: openai
model: gpt-5.4
reasoning_effort: medium
prompt_ref: prompts/parent.md
tools: [Read, UnknownTool]
skills: [testing]
domain: quality
role_type: leaf
reports_to: null
allowed_delegate_to: []
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );

    expect(() =>
      loadAgentDefinitions({
        manifestDir: path.join(rootDir, "agents"),
        rootDir
      })
    ).toThrowError(/unknown tool/i);
  });

  it("rejects supervisors that delegate to unknown agents", async () => {
    const rootDir = await createWorkspace();

    await writeFile(
      path.join(rootDir, "agents", "orphan-parent.yaml"),
      `schema_version: "1.0"
agent_id: agent_orphan_parent
version: "1.0.0"
name: Orphan Parent
description: Delegates to a missing child
provider: openai
model: gpt-5.4
reasoning_effort: high
prompt_ref: prompts/parent.md
tools: [Read]
skills: [planning]
domain: quality
role_type: supervisor
reports_to: null
allowed_delegate_to: [agent_missing_child]
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );

    expect(() =>
      loadAgentDefinitions({
        manifestDir: path.join(rootDir, "agents"),
        rootDir
      })
    ).toThrowError(/allowed_delegate_to/i);
  });

  it("rejects duplicate agent id and version pairs", async () => {
    const rootDir = await createWorkspace();

    const manifest = `schema_version: "1.0"
agent_id: agent_duplicate
version: "1.0.0"
name: Duplicate
description: Duplicate id/version pair
provider: openai
model: gpt-5.4
reasoning_effort: medium
prompt_ref: prompts/parent.md
tools: [Read]
skills: [testing]
domain: quality
role_type: leaf
reports_to: null
allowed_delegate_to: []
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`;

    await writeFile(path.join(rootDir, "agents", "one.yaml"), manifest, "utf8");
    await writeFile(path.join(rootDir, "agents", "two.yaml"), manifest, "utf8");

    expect(() =>
      loadAgentDefinitions({
        manifestDir: path.join(rootDir, "agents"),
        rootDir
      })
    ).toThrowError(/duplicate agent definition/i);
  });

  it("rejects supervisors with no allowed children", async () => {
    const rootDir = await createWorkspace();

    await writeFile(
      path.join(rootDir, "agents", "empty-supervisor.yaml"),
      `schema_version: "1.0"
agent_id: agent_empty_supervisor
version: "1.0.0"
name: Empty Supervisor
description: No children configured
provider: openai
model: gpt-5.4
reasoning_effort: high
prompt_ref: prompts/parent.md
tools: [Read]
skills: [planning]
domain: quality
role_type: supervisor
reports_to: null
allowed_delegate_to: []
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );

    expect(() =>
      loadAgentDefinitions({
        manifestDir: path.join(rootDir, "agents"),
        rootDir
      })
    ).toThrowError(/must declare at least one allowed_delegate_to/i);
  });

  it("rejects reporting lines that point to leaf agents or cross domains", async () => {
    const rootDir = await createWorkspace();

    await writeFile(
      path.join(rootDir, "agents", "leaf-manager.yaml"),
      `schema_version: "1.0"
agent_id: agent_leaf_manager
version: "1.0.0"
name: Leaf Manager
description: Invalid manager
provider: openai
model: gpt-5.4
reasoning_effort: medium
prompt_ref: prompts/parent.md
tools: [Read]
skills: [testing]
domain: marketing
role_type: leaf
reports_to: null
allowed_delegate_to: []
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
      path.join(rootDir, "agents", "cross-domain-child.yaml"),
      `schema_version: "1.0"
agent_id: agent_cross_domain_child
version: "1.0.0"
name: Cross Domain Child
description: Reports to the wrong manager
provider: openai
model: gpt-5.4
reasoning_effort: medium
prompt_ref: prompts/child.md
tools: [Read]
skills: [testing]
domain: operations
role_type: leaf
reports_to: agent_leaf_manager
allowed_delegate_to: []
output_schema_ref: null
timeout_ms: 120000
max_tool_calls: 4
enabled: true
created_at: "2026-03-07T00:00:00.000Z"
updated_at: "2026-03-07T00:00:00.000Z"
`,
      "utf8"
    );

    expect(() =>
      loadAgentDefinitions({
        manifestDir: path.join(rootDir, "agents"),
        rootDir
      })
    ).toThrowError(/reports_to non-supervisor|report within its domain/i);
  });
});
