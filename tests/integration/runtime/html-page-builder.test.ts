import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultAgentDefinitions } from "../../../src/agents/default-definitions.js";
import { SCHEMA_VERSION } from "../../../src/contracts/index.js";
import { createDatabaseClient } from "../../../src/persistence/db.js";
import {
  resetRuntimeSchema,
  runMigrations
} from "../../../src/persistence/migrations.js";
import { createDurableStore } from "../../../src/persistence/repositories/durable-store.js";
import { createFilesystemTools } from "../../../src/tools/filesystem.js";
import { buildToolRegistry } from "../../../src/providers/tool-registry.js";
import { OpenAIResponsesProvider } from "../../../src/providers/openai-provider.js";
import { executeRun } from "../../../src/runtime/run-executor.js";

function htmlAgent() {
  const agent = defaultAgentDefinitions.find(
    (definition) => definition.agent_id === "agent_html_page_builder"
  );

  if (!agent) {
    throw new Error("Expected html page builder agent definition");
  }

  return agent;
}

describe.sequential("html page builder runtime", () => {
  const sql = createDatabaseClient();
  const store = createDurableStore(sql);
  const outputPath = path.join(
    process.cwd(),
    "artifacts/generated/hello-world.html"
  );

  beforeAll(async () => {
    await resetRuntimeSchema(sql);
    await runMigrations(sql);
    await rm(path.dirname(outputPath), {
      force: true,
      recursive: true
    });
  });

  afterAll(async () => {
    await rm(path.dirname(outputPath), {
      force: true,
      recursive: true
    });
    await resetRuntimeSchema(sql);
    await sql.end({ timeout: 1 });
  });

  it("uses the write tool to create a hello-world page and persists the artifact", async () => {
    const agent = htmlAgent();
    const now = new Date().toISOString();
    const taskId = `task_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
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
          schema_version: SCHEMA_VERSION,
          run_id: runId,
          task_id: taskId,
          agent_id: agent.agent_id,
          summary: "Created hello world page",
          state_id: "completed",
          outcome: "success",
          result: {
            output_path: "artifacts/generated/hello-world.html"
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

    await store.insertTask({
      assignedAt: now,
      businessId: "demo_business",
      completedAt: null,
      createdAt: now,
      createdBy: "test",
      message: "Create hello world html page",
      parentTaskId: null,
      priority: "high",
      projectId: "demo_project",
      requestedAgentId: agent.agent_id,
      rootTaskId: taskId,
      source: "integration_test",
      sourceRef: null,
      stateId: "in_progress",
      taskId,
      title: "Hello World HTML",
      updatedAt: now
    });
    await store.insertRun({
      agentId: agent.agent_id,
      attempt: 1,
      completedAt: null,
      costEstimate: null,
      durationMs: null,
      model: agent.model,
      parentRunId: null,
      provider: agent.provider,
      reasoningEffort: agent.reasoning_effort,
      resultPayload: null,
      retryMetadata: null,
      runId,
      startedAt: now,
      status: "running",
      taskId,
      tokenUsage: null,
      triggerEventId: eventId
    });
    await store.insertEvent({
      agentId: agent.agent_id,
      businessId: "demo_business",
      causationId: null,
      correlationId: taskId,
      createdAt: now,
      dedupeKey: `dedupe_${eventId}`,
      emittedBy: "test",
      eventId,
      eventType: "task.run.requested",
      payload: {
        objective: "Create hello world html page"
      },
      projectId: "demo_project",
      runId,
      taskId
    });

    const runtimeTools = buildToolRegistry(agent, createFilesystemTools());
    const invocation = {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      task_id: taskId,
      agent,
      context_bundle: {
        schema_version: SCHEMA_VERSION,
        context_bundle_id: `ctx_${randomUUID()}`,
        task: {
          schema_version: SCHEMA_VERSION,
          task_id: taskId,
          root_task_id: taskId,
          parent_task_id: null,
          business_id: "demo_business",
          project_id: "demo_project",
          requested_agent_id: agent.agent_id,
          title: "Hello World HTML",
          message: "Create hello world html page",
          state_id: "in_progress",
          priority: "high",
          source: "integration_test",
          source_ref: null,
          created_by: "test",
          assigned_at: now,
          created_at: now,
          updated_at: now,
          completed_at: null
        },
        run: {
          schema_version: SCHEMA_VERSION,
          run_id: runId,
          task_id: taskId,
          parent_run_id: null,
          agent_id: agent.agent_id,
          trigger_event_id: eventId,
          status: "running",
          attempt: 1,
          provider: agent.provider,
          model: agent.model,
          reasoning_effort: agent.reasoning_effort,
          started_at: now,
          completed_at: null,
          duration_ms: null,
          token_usage: null,
          cost_estimate: null
        },
        business: {
          business_id: "demo_business"
        },
        project: {
          project_id: "demo_project"
        },
        related_memory: [],
        related_artifacts: [],
        related_people: [],
        constraints: ["single_shot"],
        objective: "Create hello world html page",
        memory_scope_order: ["project", "business", "agent", "global_patterns"],
        generated_at: now
      },
      tool_registry: runtimeTools.map((tool) => tool.definition),
      constraints: {
        max_tool_calls: agent.max_tool_calls
      },
      prompt: {
        instructions:
          "Create a hello world page using the write tool, then return a valid AgentResult JSON object."
      }
    } as const;

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      fetchImpl: () => {
        const payload = fetchResponses.shift();

        if (!payload) {
          throw new Error("Unexpected fetch call");
        }

        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          })
        );
      }
    });

    const outcome = await executeRun({
      invocation,
      maxAttempts: 3,
      provider,
      runtimeTools,
      store
    });
    const artifacts = await store.listArtifactsForRun(runId);
    const html = await readFile(outputPath, "utf8");

    await access(outputPath);

    expect(outcome.runStatus).toBe("succeeded");
    expect(html).toContain("Hello world");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      path: "artifacts/generated/hello-world.html",
      type: "file"
    });
  });

  it("normalizes a minimal model result into a valid AgentResult after tool execution", async () => {
    const agent = htmlAgent();
    const now = new Date().toISOString();
    const taskId = `task_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    const fetchResponses = [
      {
        id: "resp_minimal_1",
        output: [
          {
            arguments: JSON.stringify({
              content:
                "<!doctype html><html><body><h1>Hello world</h1></body></html>",
              path: "artifacts/generated/hello-world.html"
            }),
            call_id: "call_write_minimal_1",
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
        id: "resp_minimal_2",
        output_text: JSON.stringify({
          message: "Created hello world page",
          result: {
            output_path: "artifacts/generated/hello-world.html"
          },
          status: "completed"
        }),
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          total_tokens: 70
        }
      }
    ];

    await store.insertTask({
      assignedAt: now,
      businessId: "demo_business",
      completedAt: null,
      createdAt: now,
      createdBy: "test",
      message: "Create hello world html page",
      parentTaskId: null,
      priority: "high",
      projectId: "demo_project",
      requestedAgentId: agent.agent_id,
      rootTaskId: taskId,
      source: "integration_test",
      sourceRef: null,
      stateId: "in_progress",
      taskId,
      title: "Hello World HTML",
      updatedAt: now
    });
    await store.insertRun({
      agentId: agent.agent_id,
      attempt: 1,
      completedAt: null,
      costEstimate: null,
      durationMs: null,
      model: agent.model,
      parentRunId: null,
      provider: agent.provider,
      reasoningEffort: agent.reasoning_effort,
      resultPayload: null,
      retryMetadata: null,
      runId,
      startedAt: now,
      status: "running",
      taskId,
      tokenUsage: null,
      triggerEventId: eventId
    });
    await store.insertEvent({
      agentId: agent.agent_id,
      businessId: "demo_business",
      causationId: null,
      correlationId: taskId,
      createdAt: now,
      dedupeKey: `dedupe_${eventId}`,
      emittedBy: "test",
      eventId,
      eventType: "task.run.requested",
      payload: {
        objective: "Create hello world html page"
      },
      projectId: "demo_project",
      runId,
      taskId
    });

    const runtimeTools = buildToolRegistry(agent, createFilesystemTools());
    const invocation = {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      task_id: taskId,
      agent,
      context_bundle: {
        schema_version: SCHEMA_VERSION,
        context_bundle_id: `ctx_${randomUUID()}`,
        task: {
          schema_version: SCHEMA_VERSION,
          task_id: taskId,
          root_task_id: taskId,
          parent_task_id: null,
          business_id: "demo_business",
          project_id: "demo_project",
          requested_agent_id: agent.agent_id,
          title: "Hello World HTML",
          message: "Create hello world html page",
          state_id: "in_progress",
          priority: "high",
          source: "integration_test",
          source_ref: null,
          created_by: "test",
          assigned_at: now,
          created_at: now,
          updated_at: now,
          completed_at: null
        },
        run: {
          schema_version: SCHEMA_VERSION,
          run_id: runId,
          task_id: taskId,
          parent_run_id: null,
          agent_id: agent.agent_id,
          trigger_event_id: eventId,
          status: "running",
          attempt: 1,
          provider: agent.provider,
          model: agent.model,
          reasoning_effort: agent.reasoning_effort,
          started_at: now,
          completed_at: null,
          duration_ms: null,
          token_usage: null,
          cost_estimate: null
        },
        business: {
          business_id: "demo_business"
        },
        project: {
          project_id: "demo_project"
        },
        related_memory: [],
        related_artifacts: [],
        related_people: [],
        constraints: ["single_shot"],
        objective: "Create hello world html page",
        memory_scope_order: ["project", "business", "agent", "global_patterns"],
        generated_at: now
      },
      tool_registry: runtimeTools.map((tool) => tool.definition),
      constraints: {
        max_tool_calls: agent.max_tool_calls
      },
      prompt: {
        instructions:
          "Create a hello world page using the write tool, then return a compact JSON result with status and message."
      }
    } as const;

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      fetchImpl: () => {
        const payload = fetchResponses.shift();

        if (!payload) {
          throw new Error("Unexpected fetch call");
        }

        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          })
        );
      }
    });

    const outcome = await executeRun({
      invocation,
      maxAttempts: 3,
      provider,
      runtimeTools,
      store
    });
    const persistedRun = await store.getRun(runId);
    const artifacts = await store.listArtifactsForRun(runId);

    expect(outcome.runStatus).toBe("succeeded");
    expect(persistedRun?.status).toBe("succeeded");
    expect(persistedRun?.resultPayload).toEqual(
      expect.objectContaining({
        agent_id: agent.agent_id,
        outcome: "success",
        run_id: runId,
        state_id: "completed",
        summary: "Created hello world page",
        task_id: taskId
      })
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      path: "artifacts/generated/hello-world.html",
      type: "file"
    });
  });
});
