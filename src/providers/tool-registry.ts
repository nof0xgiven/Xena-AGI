import type { RegisteredAgentDefinition } from "../agents/types.js";
import type { JsonValue } from "../persistence/repositories/durable-store.js";

export type RuntimeToolContext = {
  agentId: string;
  runId: string;
  taskId: string;
};

export type RuntimeToolArtifact = {
  artifact_id: string;
  created_at: string;
  inline_payload: JsonValue;
  metadata: JsonValue;
  mime_type: string | null;
  name: string;
  path: string | null;
  run_id: string;
  schema_version: "1.0";
  task_id: string;
  type: string;
  uri: string | null;
};

export type RuntimeToolResult = {
  artifacts?: RuntimeToolArtifact[];
  output: JsonValue;
  recordedAt: string;
  toolName: string;
  trace: JsonValue;
};

export type RuntimeToolDefinition = {
  definition: {
    description: string;
    name: string;
    parameters: JsonValue;
  };
  execute(
    input: Record<string, unknown>,
    context: RuntimeToolContext
  ): Promise<RuntimeToolResult>;
};

export type RuntimeToolMap = Record<string, RuntimeToolDefinition>;

export function buildToolRegistry(
  agent: RegisteredAgentDefinition,
  availableTools: RuntimeToolMap
): RuntimeToolDefinition[] {
  return agent.tools.map((toolName) => {
    const tool = availableTools[toolName];

    if (!tool) {
      throw new Error(
        `Tool "${toolName}" is not declared in the runtime allowlist`
      );
    }

    return tool;
  });
}
