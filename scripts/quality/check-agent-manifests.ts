import { loadAgentDefinitions } from "../../src/agents/manifest-loader.js";

const definitions = loadAgentDefinitions();

console.log(
  `Agent manifest check passed (${String(definitions.length)} definitions loaded).`
);
