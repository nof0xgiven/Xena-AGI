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
import { OpenAIResponsesProvider } from "../../../src/providers/openai-provider.js";
import { buildToolRegistry } from "../../../src/providers/tool-registry.js";
import { executeRun } from "../../../src/runtime/run-executor.js";
import { createFilesystemTools } from "../../../src/tools/filesystem.js";

type AgentInvocationPayload = z.infer<typeof AgentInvocationPayloadSchema>;
type TaskAccepted = {
  task_id: string;
};

type TaskProof = {
  agent: unknown;
  api_input: unknown;
  artifacts: unknown[];
  prompt: string | null;
  result: unknown;
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
});
