import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "../../../src/api/app.js";

describe("tasks API", () => {
  beforeEach(() => {
    vi.stubEnv("XENA_API_TOKEN", "api_test_token");
    vi.stubEnv("XENA_WEBHOOK_TOKEN", "webhook_test_token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects invalid task payloads", async () => {
    const app = createApiApp({
      deliverTaskEnvelope: vi.fn(),
      getTaskProof: vi.fn()
    });

    const response = await app.request("/tasks", {
      body: JSON.stringify({
        title: "Missing message"
      }),
      headers: {
        authorization: "Bearer api_test_token",
        "content-type": "application/json"
      },
      method: "POST"
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects unauthenticated task requests", async () => {
    const app = createApiApp({
      deliverTaskEnvelope: vi.fn(),
      getTaskProof: vi.fn()
    });

    const response = await app.request("/tasks", {
      body: JSON.stringify({
        agent_id: "agent_html_page_builder",
        message: "Create hello world html page",
        title: "Hello World HTML"
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    expect(response.status).toBe(401);
  });

  it("normalizes a task request into a webhook envelope and forwards it", async () => {
    const deliverTaskEnvelope = vi.fn(() =>
      Promise.resolve({
        proof_url: null,
        run_id: null,
        task_id: "task_123",
        webhook_status: 201
      })
    );
    const app = createApiApp({
      deliverTaskEnvelope,
      getTaskProof: vi.fn()
    });

    const response = await app.request("/tasks", {
      body: JSON.stringify({
        agent_id: "agent_html_page_builder",
        idempotency_key: "task-hello-world",
        message: "Create hello world html page",
        title: "Hello World HTML"
      }),
      headers: {
        authorization: "Bearer api_test_token",
        "content-type": "application/json"
      },
      method: "POST"
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(deliverTaskEnvelope).toHaveBeenCalledTimes(1);
    expect(deliverTaskEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "agent_html_page_builder",
        event_type: "task.submitted",
        payload: expect.objectContaining({
          task_request: expect.objectContaining({
            agent_id: "agent_html_page_builder",
            message: "Create hello world html page",
            title: "Hello World HTML"
          })
        }),
        project_id: "demo_project"
      }),
      expect.objectContaining({
        "x-xena-webhook-token": "webhook_test_token"
      })
    );
    expect(body).toEqual(
      expect.objectContaining({
        task_id: "task_123"
      })
    );
  });

  it("rejects unauthenticated webhook requests", async () => {
    const app = createApiApp({
      deliverTaskEnvelope: vi.fn(),
      getTaskProof: vi.fn(),
      processWebhookEnvelope: vi.fn()
    });

    const response = await app.request("/webhooks/ingress", {
      body: JSON.stringify({
        agent_id: "agent_html_page_builder",
        business_id: "demo_business",
        emitted_by: "xena.api",
        event_type: "task.submitted",
        external_event_id: null,
        idempotency_key: "webhook-auth-test",
        ingress_id: "ingress_webhook_auth_test",
        payload: {
          task_request: {
            agent_id: "agent_html_page_builder",
            business_id: "demo_business",
            message: "Create hello world html page",
            project_id: "demo_project",
            title: "Hello World HTML"
          }
        },
        project_id: "demo_project",
        received_at: new Date().toISOString(),
        schema_version: "1.0",
        task_id: null
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    expect(response.status).toBe(401);
  });

  it("accepts authenticated webhook requests", async () => {
    const processWebhookEnvelope = vi.fn(() =>
      Promise.resolve({
        proof_url: null,
        run_id: "run_123",
        task_id: "task_123",
        webhook_status: 201
      })
    );
    const app = createApiApp({
      deliverTaskEnvelope: vi.fn(),
      getTaskProof: vi.fn(),
      processWebhookEnvelope
    });

    const response = await app.request("/webhooks/ingress", {
      body: JSON.stringify({
        agent_id: "agent_html_page_builder",
        business_id: "demo_business",
        emitted_by: "xena.api",
        event_type: "task.submitted",
        external_event_id: null,
        idempotency_key: "webhook-auth-success",
        ingress_id: "ingress_webhook_auth_success",
        payload: {
          task_request: {
            agent_id: "agent_html_page_builder",
            business_id: "demo_business",
            message: "Create hello world html page",
            project_id: "demo_project",
            title: "Hello World HTML"
          }
        },
        project_id: "demo_project",
        received_at: new Date().toISOString(),
        schema_version: "1.0",
        task_id: null
      }),
      headers: {
        "content-type": "application/json",
        "x-xena-webhook-token": "webhook_test_token"
      },
      method: "POST"
    });

    expect(response.status).toBe(201);
    expect(processWebhookEnvelope).toHaveBeenCalledTimes(1);
  });
});
