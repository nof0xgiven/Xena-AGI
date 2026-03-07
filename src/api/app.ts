import { randomUUID } from "node:crypto";

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { loadProcessEnv } from "../config/env.js";
import { WebhookEnvelopeSchema } from "../contracts/index.js";
import {
  isAuthorizedApiRequest,
  isAuthorizedWebhookRequest,
  WEBHOOK_TOKEN_HEADER
} from "./auth.js";
import {
  TaskAcceptedSchema,
  TaskProofSchema,
  TaskRequestSchema
} from "./schemas.js";

type ApiDependencies = {
  deliverTaskEnvelope: (
    envelope: unknown,
    headers?: Record<string, string>
  ) => Promise<{
    proof_url: string | null;
    run_id: string | null;
    task_id: string;
    webhook_status: number;
  }>;
  getTaskProof: (taskId: string) => Promise<unknown>;
  processWebhookEnvelope?: (envelope: unknown) => Promise<{
    proof_url: string | null;
    run_id: string | null;
    task_id: string;
    webhook_status: number;
  }>;
};
const AuthErrorSchema = z.object({
  error: z.string()
});

const taskRoute = createRoute({
  method: "post",
  path: "/tasks",
  request: {
    body: {
      content: {
        "application/json": {
          schema: TaskRequestSchema
        }
      },
      required: true
    }
  },
  responses: {
    401: {
      content: {
        "application/json": {
          schema: AuthErrorSchema
        }
      },
      description: "Missing or invalid API token."
    },
    201: {
      content: {
        "application/json": {
          schema: TaskAcceptedSchema
        }
      },
      description: "Task accepted and forwarded into the webhook pipeline."
    }
  },
  tags: ["tasks"]
});

const webhookRoute = createRoute({
  method: "post",
  path: "/webhooks/ingress",
  request: {
    body: {
      content: {
        "application/json": {
          schema: WebhookEnvelopeSchema
        }
      },
      required: true
    }
  },
  responses: {
    401: {
      content: {
        "application/json": {
          schema: AuthErrorSchema
        }
      },
      description: "Missing or invalid webhook token."
    },
    201: {
      content: {
        "application/json": {
          schema: TaskAcceptedSchema
        }
      },
      description: "Webhook envelope processed."
    },
    500: {
      content: {
        "application/json": {
          schema: TaskAcceptedSchema
        }
      },
      description: "Webhook processing unavailable."
    }
  },
  tags: ["webhooks"]
});

const proofRoute = createRoute({
  method: "get",
  path: "/tasks/{taskId}/proof",
  request: {
    params: z.object({
      taskId: z.string().min(1)
    })
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: TaskProofSchema
        }
      },
      description: "Task proof bundle."
    },
    401: {
      content: {
        "application/json": {
          schema: AuthErrorSchema
        }
      },
      description: "Missing or invalid API token."
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string()
          })
        }
      },
      description: "Task not found."
    }
  },
  tags: ["proof"]
});

export function createApiApp(dependencies: ApiDependencies) {
  const env = loadProcessEnv({
    requireIngressAuth: true
  });
  const app = new OpenAPIHono();
  const apiToken = env.security.apiToken;
  const webhookToken = env.security.webhookToken;

  if (!apiToken || !webhookToken) {
    throw new Error("Xena ingress auth requires API and webhook tokens");
  }

  app.doc("/openapi.json", {
    info: {
      title: "Xena Task API",
      version: "1.0.0"
    },
    openapi: "3.1.0"
  });

  app.openapi(taskRoute, async (context) => {
    if (
      !isAuthorizedApiRequest(context.req.header("authorization"), apiToken)
    ) {
      return context.json(
        {
          error: "Unauthorized"
        },
        401
      );
    }

    const request = context.req.valid("json");
    const envelope = WebhookEnvelopeSchema.parse({
      schema_version: "1.0",
      ingress_id: `ingress_${randomUUID()}`,
      event_type: "task.submitted",
      idempotency_key: request.idempotency_key ?? `task-${randomUUID()}`,
      business_id: request.business_id,
      project_id: request.project_id,
      task_id: null,
      agent_id: request.agent_id,
      payload: {
        task_request: request
      },
      emitted_by: "xena.api",
      external_event_id: null,
      received_at: new Date().toISOString()
    });
    const delivery = await dependencies.deliverTaskEnvelope(envelope, {
      [WEBHOOK_TOKEN_HEADER]: webhookToken
    });

    return context.json(
      {
        ingress_id: envelope.ingress_id,
        proof_url: delivery.proof_url,
        run_id: delivery.run_id,
        task_id: delivery.task_id,
        webhook_status: delivery.webhook_status
      },
      201
    );
  });

  app.openapi(webhookRoute, async (context) => {
    if (
      !isAuthorizedWebhookRequest(
        context.req.header(WEBHOOK_TOKEN_HEADER),
        webhookToken
      )
    ) {
      return context.json(
        {
          error: "Unauthorized"
        },
        401
      );
    }

    if (!dependencies.processWebhookEnvelope) {
      return context.json(
      {
          ingress_id: "",
          proof_url: null,
          run_id: null,
          task_id: "",
          webhook_status: 500
        },
        500
      );
    }

    const envelope = context.req.valid("json");
    const result = await dependencies.processWebhookEnvelope(envelope);

    return context.json(
      {
        ingress_id: envelope.ingress_id,
        proof_url: result.proof_url,
        run_id: result.run_id,
        task_id: result.task_id,
        webhook_status: result.webhook_status
      },
      result.webhook_status as 201
    );
  });

  app.openapi(proofRoute, async (context) => {
    if (
      !isAuthorizedApiRequest(context.req.header("authorization"), apiToken)
    ) {
      return context.json(
        {
          error: "Unauthorized"
        },
        401
      );
    }

    const { taskId } = context.req.valid("param");
    const proof = await dependencies.getTaskProof(taskId);

    if (!proof) {
      return context.json(
        {
          error: "Task not found"
        },
        404
      );
    }

    return context.json(proof, 200);
  });

  app.get("/health", (context) =>
    context.json({
      port: env.apiPort,
      public_base_url: env.publicBaseUrl,
      status: "ok"
    })
  );

  return app;
}
