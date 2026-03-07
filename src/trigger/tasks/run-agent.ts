import { task } from "@trigger.dev/sdk";

import { AgentInvocationPayloadSchema } from "../../contracts/index.js";
import { createDatabaseClient } from "../../persistence/db.js";
import { createDurableStore } from "../../persistence/repositories/durable-store.js";
import { OpenAIResponsesProvider } from "../../providers/openai-provider.js";
import { buildToolRegistry } from "../../providers/tool-registry.js";
import { executeRun } from "../../runtime/run-executor.js";
import { createFilesystemTools } from "../../tools/filesystem.js";

export const runAgentTask = task({
  id: "run-agent",
  run: async (payload: { invocation: unknown }) => {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required to execute the run-agent task");
    }

    const sql = createDatabaseClient();

    try {
      const invocation = AgentInvocationPayloadSchema.parse(payload.invocation);
      const runtimeTools = buildToolRegistry(
        invocation.agent,
        createFilesystemTools()
      );

      return await executeRun({
        invocation,
        maxAttempts: 3,
        provider: new OpenAIResponsesProvider({
          apiKey
        }),
        runtimeTools,
        store: createDurableStore(sql)
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
});
