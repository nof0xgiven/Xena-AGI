import { serve } from "@hono/node-server";

import { loadProcessEnv } from "../config/env.js";
import { createWebhookProcessor } from "../ingress/process-webhook.js";
import { createApiApp } from "./app.js";

const env = loadProcessEnv({
  requireIngressAuth: true,
  requireTrigger: true
});
const webhookProcessor = createWebhookProcessor();

const app = createApiApp({
  async deliverTaskEnvelope(envelope, headers = {}) {
    const response = await fetch(`${env.publicBaseUrl}/webhooks/ingress`, {
      body: JSON.stringify(envelope),
      headers: {
        ...headers,
        "content-type": "application/json"
      },
      method: "POST"
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed with status ${String(response.status)}`);
    }

    return (await response.json()) as {
      proof_url: string | null;
      run_id: string | null;
      task_id: string;
      webhook_status: number;
    };
  },
  getTaskProof(taskId) {
    return webhookProcessor.buildTaskProof(taskId);
  },
  processWebhookEnvelope(envelope) {
    return webhookProcessor.process(envelope);
  }
});

serve(
  {
    fetch: app.fetch,
    port: env.apiPort
  },
  (info) => {
    console.log(
      `xena-api listening on http://127.0.0.1:${String(info.port)} and forwarding via ${env.publicBaseUrl}`
    );
  }
);
