import { config as loadDotEnv } from "dotenv";

import { defineConfig } from "@trigger.dev/sdk";

loadDotEnv({ quiet: true });

const project =
  process.env.TRIGGER_PROJ_REF ??
  process.env.TRIGGER_PROJECT_REF ??
  "proj_local_placeholder";

export default defineConfig({
  project,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true
    }
  },
  maxDuration: 3_600
});
