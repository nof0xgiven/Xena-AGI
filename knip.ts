import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "src/trigger/tasks/run-agent.ts",
    "scripts/**/*.ts",
    "tests/**/*.test.ts",
    "trigger.config.ts"
  ],
  project: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
};

export default config;
