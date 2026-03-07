import type {
  RegisteredAgentDefinition,
  RegisteredAgentOverride,
  ResolveAgentContext
} from "./types.js";
import { compareVersions } from "./versioning.js";

export class AgentRegistry {
  readonly #definitions: RegisteredAgentDefinition[];
  readonly #overrides: RegisteredAgentOverride[];

  constructor(
    definitions: RegisteredAgentDefinition[],
    overrides: RegisteredAgentOverride[] = []
  ) {
    this.#definitions = [...definitions];
    this.#overrides = [...overrides];
  }

  resolve(
    agentId: string,
    version?: string,
    context: ResolveAgentContext = {}
  ): RegisteredAgentDefinition {
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

    return this.#applyOverrides(latest, context);
  }

  #applyOverrides(
    definition: RegisteredAgentDefinition,
    context: ResolveAgentContext
  ): RegisteredAgentDefinition {
    const applicableOverrides = this.#overrides
      .filter((override) => {
        if (override.match.agent_id !== definition.agent_id) {
          return false;
        }

        if (
          override.match.version &&
          override.match.version !== definition.version
        ) {
          return false;
        }

        if (
          override.match.environment &&
          override.match.environment !== context.environment
        ) {
          return false;
        }

        if (
          override.match.business_id &&
          override.match.business_id !== context.businessId
        ) {
          return false;
        }

        if (
          override.match.project_id &&
          override.match.project_id !== context.projectId
        ) {
          return false;
        }

        return true;
      })
      .sort((left, right) => this.#specificity(left) - this.#specificity(right));

    return applicableOverrides.reduce<RegisteredAgentDefinition>(
      (current, override) => ({
        ...current,
        ...override.patch
      }),
      definition
    );
  }

  #specificity(override: RegisteredAgentOverride): number {
    return [
      override.match.environment,
      override.match.business_id,
      override.match.project_id
    ].filter((value) => value !== null && value !== undefined).length;
  }
}
