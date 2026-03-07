import { task } from "@trigger.dev/sdk";

import { AgentInvocationPayloadSchema } from "../../contracts/index.js";
import { createDatabaseClient } from "../../persistence/db.js";
import { createDurableStore } from "../../persistence/repositories/durable-store.js";
import { OpenAIResponsesProvider } from "../../providers/openai-provider.js";
import { executeRun } from "../../runtime/run-executor.js";

export const runAgentTask = task({
  id: "run-agent",
  run: async (payload: unknown) => {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required to execute the run-agent task");
    }

    const sql = createDatabaseClient();

    try {
      return await executeRun({
        invocation: AgentInvocationPayloadSchema.parse(payload),
        maxAttempts: 3,
        provider: new OpenAIResponsesProvider({
          apiKey
        }),
        store: createDurableStore(sql)
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
});
