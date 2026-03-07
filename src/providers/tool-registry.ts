import type { RegisteredAgentDefinition } from "../agents/types.js";

export type RuntimeToolDefinition = {
  name: string;
  description: string;
};

export function buildToolRegistry(
  agent: RegisteredAgentDefinition,
  availableTools: Record<string, RuntimeToolDefinition>
): RuntimeToolDefinition[] {
  return agent.tools.map((toolName) => {
    const tool = availableTools[toolName];

    if (!tool) {
      throw new Error(`Tool "${toolName}" is not declared in the runtime allowlist`);
    }

    return tool;
  });
}
