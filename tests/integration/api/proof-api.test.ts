import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApiApp } from "../../../src/api/app.js";
import { AgentInvocationPayloadSchema } from "../../../src/contracts/index.js";
import { createDatabaseClient } from "../../../src/persistence/db.js";
import {
   resetRuntimeSchema,
   runMigrations
} from "../../../src/persistence/migrations.js";
import { createDurableStore } from "../../../src/persistence/repositories/durable-store.js";
import { createWebhookProcessor } from "../../../src/ingress/process-webhook.js";
import { createRuntimeDispatcher } from "../../../src/orchestration/runtime-dispatcher.js";
import { OpenAIResponsesProvider } from "../../../src/providers/openai-provider.js";
import { buildToolRegistry } from "../../../src/providers/tool-registry.js";
import { executeRun } from "../../../src/runtime/run-executor.js";
import { createFilesystemTools } from "../../../src/tools/filesystem.js";

vi.mock("../../../src/tools/filesystem.js", async (importOriginal) => {
   const actual = await importOriginal<typeof import("../../../src/tools/filesystem.js")>();

   return {
      ...actual,
      createFilesystemTools(options?: Parameters<typeof actual.createFilesystemTools>[0]) {
         return {
            ...actual.createFilesystemTools(options),
            Edit: {
               definition: {
                  description: "Edit a generated artifact.",
                  name: "Edit",
                  parameters: {
                     additionalProperties: false,
                     properties: {
                        content: {
                           type: "string"
                        },
                        path: {
                           type: "string"
                        }
                     },
                     required: ["path", "content"],
                     type: "object"
                  }
               },
               execute() {
                  return {
                     output: {
                        ok: true
                     },
                     recordedAt: new Date().toISOString(),
                     toolName: "Edit",
                     trace: {
                        output: {
                           ok: true
                        }
                     }
                  };
               }
            },
            WebFetch: {
               definition: {
                  description: "Fetch a web resource.",
                  name: "WebFetch",
                  parameters: {
                     additionalProperties: false,
                     properties: {
                        url: {
                           type: "string"
                        }
                     },
                     required: ["url"],
                     type: "object"
                  }
               },
               execute() {
                  return {
                     output: {
                        ok: true
                     },
                     recordedAt: new Date().toISOString(),
                     toolName: "WebFetch",
                     trace: {
                        output: {
                           ok: true
                        }
                     }
                  };
               }
            },
            WebSearch: {
               definition: {
                  description: "Search the web.",
                  name: "WebSearch",
                  parameters: {
                     additionalProperties: false,
                     properties: {
                        query: {
                           type: "string"
                        }
                     },
                     required: ["query"],
                     type: "object"
                  }
               },
               execute() {
                  return {
                     output: {
                        ok: true
                     },
                     recordedAt: new Date().toISOString(),
                     toolName: "WebSearch",
                     trace: {
                        output: {
                           ok: true
                        }
                     }
                  };
               }
            }
         };
      }
   };
});

type AgentInvocationPayload = z.infer<typeof AgentInvocationPayloadSchema>;
type TaskAccepted = {
   task_id: string;
};

type TaskProof = {
   agent: unknown;
   api_input: unknown;
   artifacts: unknown[];
   context_bundle: unknown;
   events: unknown[];
   memory_records: unknown[];
   prompt: string | null;
   result: unknown;
   runs: unknown[];
   task: unknown;
   tool_executions: unknown[];
   tool_registry: unknown[];
};

describe.sequential("task proof API", () => {
   const sql = createDatabaseClient();
   const store = createDurableStore(sql);
   const outputDir = path.join(process.cwd(), "artifacts/generated");

   beforeAll(async () => {
      vi.stubEnv("XENA_API_TOKEN", "api_test_token");
      vi.stubEnv("XENA_WEBHOOK_TOKEN", "webhook_test_token");
      await resetRuntimeSchema(sql);
      await runMigrations(sql);
      await rm(outputDir, {
         force: true,
         recursive: true
      });
   });

   afterAll(async () => {
      vi.unstubAllEnvs();
      await rm(outputDir, {
         force: true,
         recursive: true
      });
      await resetRuntimeSchema(sql);
      await sql.end({ timeout: 1 });
   });

   it("rejects unauthenticated proof requests", async () => {
      const app = createApiApp({
         deliverTaskEnvelope: () =>
            Promise.resolve({
               proof_url: null,
               run_id: null,
               task_id: "task_123",
               webhook_status: 201
            }),
         getTaskProof: () =>
            Promise.resolve({
               task: {
                  taskId: "task_123"
               }
            }),
         processWebhookEnvelope: () =>
            Promise.resolve({
               proof_url: null,
               run_id: null,
               task_id: "task_123",
               webhook_status: 201
            })
      });

      const response = await app.request("/tasks/task_123/proof");

      expect(response.status).toBe(401);
   });

   it("returns a proof bundle after a task completes through the webhook processor", async () => {
      const fetchResponses = [
         {
            id: "resp_1",
            output: [
               {
                  arguments: JSON.stringify({
                     content:
                        "<!doctype html><html><body><h1>Hello world</h1></body></html>",
                     path: "hello-world.html"
                  }),
                  call_id: "call_write_1",
                  name: "Write",
                  type: "function_call"
               }
            ],
            usage: {
               input_tokens: 100,
               output_tokens: 30,
               total_tokens: 130
            }
         },
         {
            id: "resp_2",
            output_text: JSON.stringify({
               schema_version: "1.0",
               run_id: `run_${randomUUID()}`,
               task_id: `task_${randomUUID()}`,
               agent_id: "agent_html_page_builder",
               summary: "Created hello world page",
               state_id: "completed",
               outcome: "success",
               result: {
                  verification: "proof_route_ok"
               },
               artifacts: [],
               spawn: [],
               reentry_mode: null,
               reentry_objective: null,
               errors: [],
               memory_writes: [],
               completed_at: new Date().toISOString()
            }),
            usage: {
               input_tokens: 50,
               output_tokens: 20,
               total_tokens: 70
            }
         }
      ];

      const processor = createWebhookProcessor({
         runTask: async (payload) => {
            const invocation = (payload as { invocation: AgentInvocationPayload })
               .invocation;
            const runtimeTools = buildToolRegistry(
               invocation.agent,
               createFilesystemTools()
            );
            const provider = new OpenAIResponsesProvider({
               apiKey: "test-key",
               fetchImpl: () => {
                  const next = fetchResponses.shift();

                  if (!next) {
                     throw new Error("Unexpected fetch call");
                  }

                  if (
                     typeof next.output_text === "string" &&
                     typeof invocation.run_id === "string" &&
                     typeof invocation.task_id === "string"
                  ) {
                     next.output_text = JSON.stringify({
                        ...JSON.parse(next.output_text),
                        run_id: invocation.run_id,
                        task_id: invocation.task_id
                     });
                  }

                  return Promise.resolve(
                     new Response(JSON.stringify(next), {
                        headers: {
                           "content-type": "application/json"
                        },
                        status: 200
                     })
                  );
               }
            });

            return executeRun({
               invocation,
               maxAttempts: 3,
               provider,
               runtimeTools,
               store
            });
         },
         sql,
         store
      });
      const app = createApiApp({
         deliverTaskEnvelope: (envelope) => processor.process(envelope),
         getTaskProof: (taskId) => processor.buildTaskProof(taskId),
         processWebhookEnvelope: (envelope) => processor.process(envelope)
      });

      const taskResponse = await app.request("/tasks", {
         body: JSON.stringify({
            agent_id: "agent_html_page_builder",
            idempotency_key: "proof-api-demo",
            message: "Create hello world html page",
            title: "Hello World HTML"
         }),
         headers: {
            authorization: "Bearer api_test_token",
            "content-type": "application/json"
         },
         method: "POST"
      });
      const accepted = (await taskResponse.json()) as TaskAccepted;
      const proofResponse = await app.request(`/tasks/${accepted.task_id}/proof`, {
         headers: {
            authorization: "Bearer api_test_token"
         }
      });
      const proof = (await proofResponse.json()) as TaskProof;

      expect(taskResponse.status).toBe(201);
      expect(proofResponse.status).toBe(200);
      expect(proof.api_input).toEqual(
         expect.objectContaining({
            agent_id: "agent_html_page_builder",
            title: "Hello World HTML"
         })
      );
      expect(proof.agent).toEqual(
         expect.objectContaining({
            agent_id: "agent_html_page_builder"
         })
      );
      expect(proof.tool_registry).toEqual(
         expect.arrayContaining([
            expect.objectContaining({ name: "Read" }),
            expect.objectContaining({ name: "Write" })
         ])
      );
      expect(proof.prompt).toContain("Objective: Create hello world html page");
      expect(proof.result).toEqual(
         expect.objectContaining({
            outcome: "success"
         })
      );
      expect(proof.artifacts).toEqual(
         expect.arrayContaining([
            expect.objectContaining({
               path: "artifacts/generated/hello-world.html"
            })
         ])
      );
      expect(proof.tool_executions).toHaveLength(1);
   });

   it("returns lineage-aware proof for delegated tasks after child completion and parent re-entry", async () => {
      const invocationOrder: {
         agentId: string;
         runId: string;
         taskId: string;
      }[] = [];

      const runtimeDispatcher = createRuntimeDispatcher({
         runTask: (payload) => runTask(payload),
         sql,
         store
      });

      const runTask = async (payload: { invocation: unknown }) => {
         const invocation = (payload as { invocation: AgentInvocationPayload }).invocation;

         invocationOrder.push({
            agentId: invocation.agent.agent_id,
            runId: invocation.run_id,
            taskId: invocation.task_id
         });

         const runtimeTools = buildToolRegistry(
            invocation.agent,
            createFilesystemTools()
         );

         const result = (() => {
            if (
               invocation.agent.agent_id === "agent_marketing_growth_hacker" &&
               invocationOrder.filter(
                  (entry) => entry.agentId === "agent_marketing_growth_hacker"
               ).length === 1
            ) {
               return {
                  schema_version: "1.0",
                  run_id: invocation.run_id,
                  task_id: invocation.task_id,
                  agent_id: invocation.agent.agent_id,
                  summary: "Delegating launch work",
                  state_id: "awaiting_subtasks",
                  outcome: "delegated",
                  result: null,
                  artifacts: [],
                  spawn: [
                     {
                        tool_name: "spawn_task",
                        target_agent_id: "agent_marketing_benchmark_analyst",
                        title: "Gather benchmark references",
                        message: "Collect current competitor examples",
                        required: true,
                        priority: "high",
                        context_overrides: null,
                        expected_output: null,
                        tags: ["research"]
                     },
                     {
                        tool_name: "spawn_task",
                        target_agent_id: "agent_marketing_content_creator",
                        title: "Draft launch copy",
                        message: "Write launch campaign copy",
                        required: true,
                        priority: "high",
                        context_overrides: null,
                        expected_output: null,
                        tags: ["copy"]
                     }
                  ],
                  reentry_mode: "barrier",
                  reentry_objective: "Synthesize child deliverables",
                  errors: [],
                  memory_writes: [],
                  completed_at: "2026-03-07T10:00:00.000Z"
               };
            }

            if (invocation.agent.agent_id === "agent_marketing_benchmark_analyst") {
               return {
                  schema_version: "1.0",
                  run_id: invocation.run_id,
                  task_id: invocation.task_id,
                  agent_id: invocation.agent.agent_id,
                  summary: "Benchmarks collected",
                  state_id: "completed",
                  outcome: "success",
                  result: {
                     benchmark_count: 3
                  },
                  artifacts: [],
                  spawn: [],
                  reentry_mode: null,
                  reentry_objective: null,
                  errors: [],
                  memory_writes: [],
                  completed_at: "2026-03-07T10:01:00.000Z"
               };
            }

            if (invocation.agent.agent_id === "agent_marketing_content_creator") {
               return {
                  schema_version: "1.0",
                  run_id: invocation.run_id,
                  task_id: invocation.task_id,
                  agent_id: invocation.agent.agent_id,
                  summary: "Copy drafted",
                  state_id: "completed",
                  outcome: "success",
                  result: {
                     draft_status: "ready"
                  },
                  artifacts: [],
                  spawn: [],
                  reentry_mode: null,
                  reentry_objective: null,
                  errors: [],
                  memory_writes: [],
                  completed_at: "2026-03-07T10:02:00.000Z"
               };
            }

            if (invocation.agent.agent_id === "agent_marketing_growth_hacker") {
               return {
                  schema_version: "1.0",
                  run_id: invocation.run_id,
                  task_id: invocation.task_id,
                  agent_id: invocation.agent.agent_id,
                  summary: "Delegated outputs synthesized",
                  state_id: "completed",
                  outcome: "success",
                  result: {
                     final_brief: "Campaign package assembled"
                  },
                  artifacts: [],
                  spawn: [],
                  reentry_mode: null,
                  reentry_objective: null,
                  errors: [],
                  memory_writes: [],
                  completed_at: "2026-03-07T10:03:00.000Z"
               };
            }

            throw new Error(`Unexpected invocation for ${invocation.agent.agent_id}`);
         })();

         const provider = new OpenAIResponsesProvider({
            apiKey: "test-key",
            fetchImpl: () =>
               Promise.resolve(
                  new Response(
                     JSON.stringify({
                        id: `resp_${invocation.run_id}`,
                        output_text: JSON.stringify(result),
                        usage: {
                           input_tokens: 10,
                           output_tokens: 10,
                           total_tokens: 20
                        }
                     }),
                     {
                        headers: {
                           "content-type": "application/json"
                        },
                        status: 200
                     }
                  )
               )
         });

         return executeRun({
            invocation,
            maxAttempts: 3,
            onSuccessfulRun: runtimeDispatcher.handleSuccessfulRun,
            provider,
            runtimeTools,
            store
         });
      };


      const processor = createWebhookProcessor({
         runTask,
         sql,
         store
      });
      const app = createApiApp({
         deliverTaskEnvelope: (envelope) => processor.process(envelope),
         getTaskProof: (taskId) => processor.buildTaskProof(taskId),
         processWebhookEnvelope: (envelope) => processor.process(envelope)
      });

      const taskResponse = await app.request("/tasks", {
         body: JSON.stringify({
            agent_id: "agent_marketing_growth_hacker",
            idempotency_key: "proof-api-delegated-demo",
            message: "Coordinate a launch campaign",
            title: "Launch Campaign"
         }),
         headers: {
            authorization: "Bearer api_test_token",
            "content-type": "application/json"
         },
         method: "POST"
      });
      const accepted = (await taskResponse.json()) as TaskAccepted;
      const proofResponse = await app.request(`/tasks/${accepted.task_id}/proof`, {
         headers: {
            authorization: "Bearer api_test_token"
         }
      });
      const proof = (await proofResponse.json()) as TaskProof;
      const proofRuns = proof.runs as {
         agentId: string;
         runId: string;
         taskId: string;
      }[];
      const proofEvents = proof.events as {
         eventType: string;
         taskId: string | null;
      }[];

      expect(taskResponse.status).toBe(201);
      expect(proofResponse.status).toBe(200);
      expect(invocationOrder.map((entry) => entry.agentId)).toEqual([
         "agent_marketing_growth_hacker",
         "agent_marketing_benchmark_analyst",
         "agent_marketing_content_creator",
         "agent_marketing_growth_hacker"
      ]);
      expect(proof.task).toEqual(
         expect.objectContaining({
            parentTaskId: null,
            requestedAgentId: "agent_marketing_growth_hacker",
            rootTaskId: accepted.task_id,
            taskId: accepted.task_id
         })
      );
      expect(proof.context_bundle).toEqual(
         expect.objectContaining({
            task: expect.objectContaining({
               task_id: accepted.task_id
            })
         })
      );
      expect(proof.memory_records).toEqual([]);
      expect(proofRuns).toHaveLength(4);
      expect(
         proofRuns.filter(
            (run) =>
               run.taskId === accepted.task_id &&
               run.agentId === "agent_marketing_growth_hacker"
         )
      ).toHaveLength(2);
      expect(
         proofRuns.filter(
            (run) => run.agentId === "agent_marketing_benchmark_analyst"
         )
      ).toHaveLength(1);
      expect(
         proofRuns.filter(
            (run) => run.agentId === "agent_marketing_content_creator"
         )
      ).toHaveLength(1);
      expect(proofEvents).toEqual(
         expect.arrayContaining([
            expect.objectContaining({
               eventType: "task.reentry_requested",
               taskId: accepted.task_id
            })
         ])
      );
      expect(proofEvents.some((event) => event.taskId !== accepted.task_id)).toBe(true);
      expect(proof.result).toEqual(
         expect.objectContaining({
            outcome: "success",
            result: expect.objectContaining({
               final_brief: "Campaign package assembled"
            })
         })
      );
   });
});
