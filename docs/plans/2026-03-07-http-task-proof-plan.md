# Xena HTTP Task Proof Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove that a real task can enter Xena through a validated HTTP API, flow through the public webhook path, execute via Trigger.dev, use tools, write a real HTML file, and expose durable proof of what happened.

**Architecture:** One Hono service on port `18790` exposes `POST /tasks` and `POST /webhooks/ingress`. The public task route validates a typed request, converts it to `WebhookEnvelope`, forwards it to `https://xena.ngrok.app/webhooks/ingress`, and the webhook handler persists lineage, builds context, triggers the `run-agent` Trigger task, and records proof events. A single html-page-builder agent uses `Read` and `Write` tools to create `artifacts/generated/hello-world.html`, which is also persisted as a durable artifact.

**Tech Stack:** Hono, Zod OpenAPI, Trigger.dev, OpenAI Responses API, Postgres, MinIO, PM2, ngrok

---

### Task 1: HTTP/OpenAPI Ingress

**Files:**
- Create: `src/api/app.ts`
- Create: `src/api/server.ts`
- Create: `src/api/routes/tasks.ts`
- Create: `src/api/routes/webhooks.ts`
- Create: `src/api/schemas.ts`
- Test: `tests/integration/api/tasks-api.test.ts`

**Proof:** `POST /tasks` validates input, produces `WebhookEnvelope`, and forwards into `/webhooks/ingress`.

### Task 2: Single HTML Agent + Tools

**Files:**
- Modify: `src/agents/default-definitions.ts`
- Create: `src/prompts/assets/html-page-builder.md`
- Create: `src/tools/filesystem.ts`
- Modify: `src/providers/tool-registry.ts`
- Modify: `src/providers/openai-provider.ts`
- Modify: `src/runtime/run-executor.ts`
- Test: `tests/integration/runtime/html-page-builder.test.ts`

**Proof:** the html agent runs through Trigger/OpenAI, calls `Write`, creates `artifacts/generated/hello-world.html`, and persists a durable artifact.

### Task 3: Durable Proof Surface

**Files:**
- Create: `src/ingress/process-webhook.ts`
- Create: `src/api/routes/proof.ts`
- Modify: `src/persistence/repositories/durable-store.ts`
- Test: `tests/integration/api/proof-api.test.ts`

**Proof:** task proof output includes request, webhook envelope, resolved agent, rendered prompt, tools, memory/context snapshot, final result, and artifacts.

### Task 4: Service Wiring

**Files:**
- Create: `ecosystem.config.cjs`
- Create: `scripts/start-xena-api.sh`
- Modify: `package.json`

**Proof:** PM2 runs the Hono app on `18790`, and `ngrok` forwards `https://xena.ngrok.app` to it.

### Task 5: Live End-to-End Verification

**Proof commands:**
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pm2 start ecosystem.config.cjs --only xena-api`
- `pm2 start ecosystem.config.cjs --only xena-ngrok`
- `curl -X POST https://xena.ngrok.app/tasks ...`
- `curl https://xena.ngrok.app/tasks/<task_id>/proof`

**Success condition:** one externally submitted task completes through the public API and webhook pipeline, writes a real HTML file, persists an artifact, and returns inspectable proof.
