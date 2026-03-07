import { task } from "@trigger.dev/sdk";

import { AgentInvocationPayloadSchema } from "../../contracts/index.js";
import { triggerAgentRun } from "../../ingress/process-webhook.js";
import { createRuntimeDispatcher } from "../../orchestration/runtime-dispatcher.js";
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
         const store = createDurableStore(sql);
         const runtimeDispatcher = createRuntimeDispatcher({
            ...(process.env.NODE_ENV ? { environment: process.env.NODE_ENV } : {}),
            runTask: (nestedPayload) => {
               const secretKey = process.env.TRIGGER_SECRET_KEY;

               if (!secretKey) {
                  throw new Error("TRIGGER_SECRET_KEY is required to dispatch delegated runs");
               }

               return triggerAgentRun(nestedPayload, {
                  ...(process.env.TRIGGER_API_URL
                     ? { apiUrl: process.env.TRIGGER_API_URL }
                     : {}),
                  secretKey
               });
            },
            sql,
            store
         });
         const runtimeTools = buildToolRegistry(
            invocation.agent,
            createFilesystemTools()
         );

         return await executeRun({
            invocation,
            maxAttempts: 3,
            onSuccessfulRun: runtimeDispatcher.handleSuccessfulRun,
            provider: new OpenAIResponsesProvider({
               apiKey
            }),
            runtimeTools,
            store
         });
      } finally {
         await sql.end({ timeout: 1 });
      }
   }
});
