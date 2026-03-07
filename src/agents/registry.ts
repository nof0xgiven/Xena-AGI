import type { RegisteredAgentDefinition } from "./types.js";

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((value) => Number.parseInt(value, 10));
  const rightParts = right.split(".").map((value) => Number.parseInt(value, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;

    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

export class AgentRegistry {
  readonly #definitions: RegisteredAgentDefinition[];

  constructor(definitions: RegisteredAgentDefinition[]) {
    this.#definitions = [...definitions];
  }

  resolve(agentId: string, version?: string): RegisteredAgentDefinition {
    const candidates = this.#definitions.filter(
      (definition) => definition.agent_id === agentId && definition.enabled
    );

    if (candidates.length === 0) {
      throw new Error(`Unknown enabled agent definition: ${agentId}`);
    }

    if (version) {
      const match = candidates.find(
        (definition) => definition.version === version
      );

      if (!match) {
        throw new Error(`Unknown enabled agent version: ${agentId}@${version}`);
      }

      return match;
    }

    const latest = [...candidates].sort((left, right) =>
      compareVersions(right.version, left.version)
    )[0];

    if (!latest) {
      throw new Error(`Unable to resolve latest enabled agent version: ${agentId}`);
    }

    return latest;
  }
}
