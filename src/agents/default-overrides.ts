import { loadAgentOverrides } from "./override-loader.js";
import { defaultAgentDefinitions } from "./default-definitions.js";

export const defaultAgentOverrides = loadAgentOverrides({
  definitions: defaultAgentDefinitions
});
