# Xena v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Xena v1 Trigger-first orchestration runtime from the roadmap/spec/docs into a working TypeScript service with local development infrastructure, durable persistence, scoped memory, Trigger execution, delegation, reconciliation, and verification.

**Architecture:** Use a TypeScript Node service with explicit bounded contexts: contracts, ingress, persistence, memory, context assembly, runtime, and orchestration. Postgres is the source of truth, MinIO provides local object storage, Trigger.dev executes bounded runs, and tests prove red-green behavior at contract, integration, and scenario levels.

**Tech Stack:** Node.js, TypeScript, pnpm, Vitest, Zod, postgres, pgvector, Trigger.dev, Docker Compose, MinIO

---

### Task 1: Foundation and Local Runtime

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `prettier.config.mjs`
- Create: `.env.example`
- Create: `docker-compose.local.yml`
- Create: `trigger.config.ts`
- Create: `.github/workflows/ci.yml`
- Create: `src/config/env.ts`
- Test: `tests/unit/config/env.test.ts`

**Step 1: Write the failing test**

Write `tests/unit/config/env.test.ts` that proves env loading supplies defaults for local Postgres/MinIO ports, requires Trigger credentials for Trigger-aware paths, and rejects malformed URLs.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/config/env.test.ts`
Expected: FAIL because the runtime/tooling files do not exist yet.

**Step 3: Write minimal implementation**

Add project toolchain, scripts, env loader, Docker Compose with non-conflicting ports, Trigger config, and baseline CI.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/config/env.test.ts`
Expected: PASS

**Step 5: Verify the foundation**

Run:
- `pnpm install`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `docker compose -f docker-compose.local.yml up -d`

Expected:
- install succeeds
- baseline checks are green
- local Postgres and MinIO containers start on alternate ports

### Task 2: Canonical Contracts and Validation

**Files:**
- Create: `src/contracts/enums.ts`
- Create: `src/contracts/common.ts`
- Create: `src/contracts/*.ts`
- Create: `src/ingress/idempotency.ts`
- Test: `tests/unit/contracts/contracts.test.ts`
- Test: `tests/unit/ingress/idempotency.test.ts`

**Step 1: Write the failing test**

Write contract tests that prove:
- every named contract validates required fields
- unknown fields are rejected
- unsupported schema versions are rejected
- lineage rules catch broken `root_task_id` / `parent_task_id`
- ingress idempotency dedupes identical payloads and rejects conflicting duplicates

**Step 2: Run test to verify it fails**

Run:
- `pnpm vitest run tests/unit/contracts/contracts.test.ts`
- `pnpm vitest run tests/unit/ingress/idempotency.test.ts`

Expected: FAIL because contracts and validators are not implemented.

**Step 3: Write minimal implementation**

Create Zod-backed schemas, enum sets, identifier helpers, artifact reference rules, lineage validation, and ingress dedupe helpers.

**Step 4: Run test to verify it passes**

Run:
- `pnpm vitest run tests/unit/contracts/contracts.test.ts`
- `pnpm vitest run tests/unit/ingress/idempotency.test.ts`

Expected: PASS

### Task 3: Persistence, Migrations, and Artifact Storage

**Files:**
- Create: `migrations/*.sql`
- Create: `scripts/db-reset.ts`
- Create: `src/persistence/db.ts`
- Create: `src/persistence/repositories/*.ts`
- Create: `src/artifacts/object-store.ts`
- Test: `tests/integration/persistence/persistence.test.ts`
- Test: `tests/integration/artifacts/object-store.test.ts`

**Step 1: Write the failing test**

Write integration tests that prove:
- database bootstrap from scratch succeeds
- migrations are idempotent
- uniqueness and lineage queries work
- dead letters can be written and read
- artifact metadata persists and object payloads can be uploaded/downloaded against local MinIO

**Step 2: Run test to verify it fails**

Run:
- `pnpm vitest run tests/integration/persistence/persistence.test.ts`
- `pnpm vitest run tests/integration/artifacts/object-store.test.ts`

Expected: FAIL because persistence and storage layers do not exist.

**Step 3: Write minimal implementation**

Add SQL migrations, Postgres connection code, repositories, local reset/bootstrap utilities, and an object-storage adapter backed by MinIO/S3 API.

**Step 4: Run test to verify it passes**

Run:
- `pnpm vitest run tests/integration/persistence/persistence.test.ts`
- `pnpm vitest run tests/integration/artifacts/object-store.test.ts`

Expected: PASS

### Task 4: Agent Registry, Memory, and Context Builder

**Files:**
- Create: `src/agents/registry.ts`
- Create: `src/prompts/render.ts`
- Create: `src/memory/service.ts`
- Create: `src/memory/ranking.ts`
- Create: `src/runtime/context-builder.ts`
- Create: `src/providers/tool-registry.ts`
- Test: `tests/unit/agents/registry.test.ts`
- Test: `tests/integration/memory/memory-service.test.ts`
- Test: `tests/unit/runtime/context-builder.test.ts`

**Step 1: Write the failing test**

Write tests that prove:
- agent resolution works by id/version
- prompt rendering fails on missing variables
- undeclared tools are rejected
- scope-safe memory retrieval order is project -> business -> agent -> global_patterns
- task-linked artifacts rank ahead of generalized memory
- context assembly is deterministic and respects size limits

**Step 2: Run test to verify it fails**

Run:
- `pnpm vitest run tests/unit/agents/registry.test.ts`
- `pnpm vitest run tests/integration/memory/memory-service.test.ts`
- `pnpm vitest run tests/unit/runtime/context-builder.test.ts`

Expected: FAIL because these modules are not implemented.

**Step 3: Write minimal implementation**

Add agent definition loading, prompt rendering, tool allowlist enforcement, memory persistence/query logic, ranking helpers, and `AgentInvocationPayload` assembly.

**Step 4: Run test to verify it passes**

Run:
- `pnpm vitest run tests/unit/agents/registry.test.ts`
- `pnpm vitest run tests/integration/memory/memory-service.test.ts`
- `pnpm vitest run tests/unit/runtime/context-builder.test.ts`

Expected: PASS

### Task 5: Trigger Runtime and Provider Execution

**Files:**
- Create: `src/providers/openai-provider.ts`
- Create: `src/runtime/run-executor.ts`
- Create: `src/runtime/result-persistence.ts`
- Create: `src/trigger/tasks/run-agent.ts`
- Test: `tests/integration/runtime/run-executor.test.ts`
- Test: `tests/integration/runtime/provider-timeout.test.ts`

**Step 1: Write the failing test**

Write tests that prove:
- a single run executes end to end and persists a valid `AgentResult`
- malformed results are rejected safely
- provider timeouts classify to retry or terminal states correctly
- retry metadata is reflected into durable run state

**Step 2: Run test to verify it fails**

Run:
- `pnpm vitest run tests/integration/runtime/run-executor.test.ts`
- `pnpm vitest run tests/integration/runtime/provider-timeout.test.ts`

Expected: FAIL because execution/runtime modules do not exist.

**Step 3: Write minimal implementation**

Add provider abstraction, Trigger task wrapper, model invocation adapter, result validation, artifact/memory persistence hooks, and retry classification behavior.

**Step 4: Run test to verify it passes**

Run:
- `pnpm vitest run tests/integration/runtime/run-executor.test.ts`
- `pnpm vitest run tests/integration/runtime/provider-timeout.test.ts`

Expected: PASS

### Task 6: Delegation, Re-entry, Reconciliation, and Observability

**Files:**
- Create: `src/orchestration/delegation.ts`
- Create: `src/orchestration/retry.ts`
- Create: `src/reconciliation/jobs.ts`
- Create: `src/observability/logger.ts`
- Create: `src/observability/metrics.ts`
- Test: `tests/scenarios/fanout-reentry.test.ts`
- Test: `tests/scenarios/retry-dead-letter.test.ts`
- Test: `tests/scenarios/promotion-governance.test.ts`

**Step 1: Write the failing test**

Write scenario tests that prove:
- three-child fan-out and barrier re-entry works
- optional children do not block re-entry
- required child failure routes to the correct review or terminal state
- retry exhaustion writes a dead letter
- reconciliation can recover stale awaiting-subtasks state
- promotion requests preserve provenance and never leak raw local facts into `global_patterns`

**Step 2: Run test to verify it fails**

Run:
- `pnpm vitest run tests/scenarios/fanout-reentry.test.ts`
- `pnpm vitest run tests/scenarios/retry-dead-letter.test.ts`
- `pnpm vitest run tests/scenarios/promotion-governance.test.ts`

Expected: FAIL because orchestration/reconciliation/observability modules do not exist.

**Step 3: Write minimal implementation**

Add spawn transformation, delegation contracts, barrier evaluation, re-entry event emission, retry scheduling, dead-letter handling, reconciliation jobs, promotion workflow, and basic logs/metrics.

**Step 4: Run test to verify it passes**

Run:
- `pnpm vitest run tests/scenarios/fanout-reentry.test.ts`
- `pnpm vitest run tests/scenarios/retry-dead-letter.test.ts`
- `pnpm vitest run tests/scenarios/promotion-governance.test.ts`

Expected: PASS

### Task 7: Final Verification

**Files:**
- Modify: `roadmap.md`
- Modify: `docs/implementation-readiness.md`
- Modify: `specification.md`
- Modify: `companion-schema.md`

**Step 1: Verify spec and implementation alignment**

Check that state names, contract names, and phase gates still match implemented behavior. Update docs only if code forced a reality change.

**Step 2: Run complete verification**

Run:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `docker compose -f docker-compose.local.yml ps`
- `pnpm trigger:dev --help`

Expected:
- all repo checks pass
- local service containers are healthy
- Trigger CLI is wired correctly

**Step 3: Capture final status**

Summarize passed checks, any external blockers, and any intentionally deferred work that remains outside the v1 roadmap.
