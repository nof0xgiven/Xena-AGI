import { loadAgentDefinitions } from "../../src/agents/manifest-loader.js";
import { loadAgentOverrides } from "../../src/agents/override-loader.js";

const definitions = loadAgentDefinitions();
const overrides = loadAgentOverrides({
  definitions
});

console.log(
  `Agent manifest check passed (${String(definitions.length)} definitions and ${String(overrides.length)} overrides loaded).`
);
