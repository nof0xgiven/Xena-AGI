import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetRuntimeSchema,
  runMigrations
} from "../../../src/persistence/migrations.js";
import { createDatabaseClient } from "../../../src/persistence/db.js";
import { createDurableStore } from "../../../src/persistence/repositories/durable-store.js";

const configureMock = vi.hoisted(() => vi.fn());
const triggerMock = vi.hoisted(() => vi.fn());
const pollMock = vi.hoisted(() => vi.fn());

vi.mock("@trigger.dev/sdk/v3", () => ({
  configure: configureMock,
  runs: {
    poll: pollMock
  },
  tasks: {
    trigger: triggerMock,
    triggerAndWait: vi.fn(() =>
      Promise.reject(
        new Error("triggerAndWait should not be used from HTTP ingress")
      )
    )
  }
}));

describe.sequential("webhook processor trigger integration", () => {
  const sql = createDatabaseClient();
  const store = createDurableStore(sql);

  beforeAll(async () => {
    await resetRuntimeSchema(sql);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await resetRuntimeSchema(sql);
    await sql.end({ timeout: 1 });
  });

  beforeEach(() => {
    vi.stubEnv("TRIGGER_PROJ_REF", "proj_test");
    vi.stubEnv("TRIGGER_SECRET_KEY", "tr_dev_test");
    configureMock.mockReset();
    triggerMock.mockReset();
    pollMock.mockReset();
    triggerMock.mockResolvedValue({
      id: "run_trigger_123"
    });
    pollMock.mockResolvedValue({
      id: "run_trigger_123",
      isCompleted: true,
      isSuccess: true,
      output: {
        runStatus: "succeeded"
      },
      status: "COMPLETED"
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("triggers the task and polls the run when invoked from HTTP ingress", async () => {
    const { createWebhookProcessor } = await import(
      "../../../src/ingress/process-webhook.js"
    );
    const processor = createWebhookProcessor({
      sql,
      store
    });

    const result = await processor.process({
      agent_id: "agent_html_page_builder",
      business_id: "demo_business",
      emitted_by: "xena.api",
      event_type: "task.submitted",
      external_event_id: null,
      idempotency_key: "task-http-trigger-proof",
      ingress_id: "ingress_http_trigger_proof",
      payload: {
        task_request: {
          agent_id: "agent_html_page_builder",
          business_id: "demo_business",
          idempotency_key: "task-http-trigger-proof",
          message: "Create hello world html page",
          project_id: "demo_project",
          source_ref: null,
          title: "Hello World HTML"
        }
      },
      project_id: "demo_project",
      received_at: new Date().toISOString(),
      schema_version: "1.0",
      task_id: null
    });

    expect(result.webhook_status).toBe(201);
    expect(triggerMock).toHaveBeenCalledTimes(1);
    expect(triggerMock).toHaveBeenCalledWith(
      "run-agent",
      expect.objectContaining({
        invocation: expect.objectContaining({
          agent: expect.objectContaining({
            agent_id: "agent_html_page_builder"
          }),
          task_id: result.task_id
        })
      }),
      expect.anything()
    );
    expect(pollMock).toHaveBeenCalledWith("run_trigger_123", expect.anything());
  });
});
