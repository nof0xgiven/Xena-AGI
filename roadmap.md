# Xena v1 Roadmap

This roadmap turns the current Xena documentation set into an end-to-end build order for the whole project.

Primary source docs:
- [specification.md](./specification.md)
- [companion-schema.md](./companion-schema.md)
- [docs/adr/0001-trigger-first-runtime.md](./docs/adr/0001-trigger-first-runtime.md)
- [docs/runtime-flow-state.md](./docs/runtime-flow-state.md)
- [docs/memory-architecture-governance.md](./docs/memory-architecture-governance.md)
- [docs/implementation-readiness.md](./docs/implementation-readiness.md)

## How To Use This Roadmap

- Treat phases as ordered unless a task is explicitly safe to parallelize.
- Do not mark a phase done until every task and every check in that phase is complete.
- Update the specs when implementation changes reality.
- Add tests and verification artifacts in the same phase as the code they protect.

## Suggested Project Structure To Create Early

- `src/config/`
- `src/contracts/`
- `src/ingress/`
- `src/persistence/`
- `src/agents/`
- `src/prompts/`
- `src/runtime/`
- `src/orchestration/`
- `src/memory/`
- `src/artifacts/`
- `src/providers/`
- `src/observability/`
- `src/security/`
- `src/reconciliation/`
- `trigger/`
- `migrations/`
- `scripts/`
- `tests/unit/`
- `tests/integration/`
- `tests/scenarios/`

---

## Phase 0: Repository and Delivery Foundation

**Goal:** Create the base repo, runtime skeleton, tooling, and local development environment.

**Create:**
- package manager and workspace configuration
- TypeScript and Node runtime configuration
- linting, formatting, and test tooling
- local env loading and secret stubs
- local Postgres and object-storage development setup
- Trigger.dev project configuration
- CI baseline

**Tasks**
- [ ] Initialize package management, lockfile, and workspace conventions.
- [ ] Add TypeScript compiler config and baseline scripts.
- [ ] Set up testing framework for unit, integration, and scenario tests.
- [ ] Set up linting and formatting rules.
- [ ] Add environment loading with `.env.example`.
- [ ] Add local Postgres and object-storage setup.
- [ ] Add Trigger.dev config and local dev command.
- [ ] Add CI workflow that runs baseline quality checks.

**Checks**
- [ ] `pnpm install` completes successfully.
- [ ] `pnpm typecheck` passes on the skeleton.
- [ ] `pnpm test` passes on the skeleton.
- [ ] `pnpm lint` passes on the skeleton.
- [ ] Local Postgres is reachable from the app.
- [ ] Trigger dev runtime boots successfully.

---

## Phase 1: Canonical Contracts and Validation

**Goal:** Implement the contract layer exactly as defined in the specs.

**Create:**
- schema modules for all canonical contracts
- enum definitions
- validators for ingress, internal events, agent results, memory contracts
- dedupe and idempotency validation helpers

**Tasks**
- [ ] Create contract definitions for `WebhookEnvelope`, `AgentDefinition`, `Task`, `Run`, `Event`, `ContextBundle`, `Artifact`, `DelegationContract`, `AgentResult`, `AgentInvocationPayload`, `SpawnRequest`, `MemoryRecord`, `MemoryQuery`, and `MemoryPromotionRequest`.
- [ ] Create named enum types for `MemoryClass` and `MemoryScope`.
- [ ] Add strict unknown-field rejection policy.
- [ ] Add identifier and lineage validation helpers.
- [ ] Add artifact reference validation rules.
- [ ] Add schema version enforcement.
- [ ] Add ingress idempotency validation.

**Checks**
- [ ] Contract tests cover every required field and enum value.
- [ ] Invalid unknown fields are rejected.
- [ ] Unsupported schema versions are rejected.
- [ ] Duplicate ingress requests with the same idempotency key are deduplicated.
- [ ] Lineage validation catches broken `root_task_id` and `parent_task_id` chains.

---

## Phase 2: Persistence Model and Migrations

**Goal:** Create the durable system-of-record layer.

**Create:**
- Postgres schema and migrations for tasks, runs, events, artifacts, delegation contracts, dead letters, agent definitions, memory records, and promotion requests
- repository or query layer
- migration and reset scripts

**Tasks**
- [ ] Design relational tables and indexes for every durable contract.
- [ ] Add uniqueness constraints for IDs and dedupe keys.
- [ ] Add indexes for business, project, agent, task, run, and event access patterns.
- [ ] Add artifact metadata storage.
- [ ] Add dead-letter table and retention policy.
- [ ] Add migration scripts and local reset scripts.

**Checks**
- [ ] Fresh database bootstrap works from scratch.
- [ ] Re-running migrations is safe.
- [ ] Dedupe-key uniqueness works.
- [ ] Lineage queries across task and run chains work.
- [ ] Dead-letter rows can be written and read.

---

## Phase 3: Agent Registry, Prompts, and Tool Manifests

**Goal:** Make agents resolvable and runnable with clear capability boundaries.

**Create:**
- agent definition registry
- prompt assets and rendering system
- tool registry and allowlist enforcement
- agent override model for businesses and projects

**Tasks**
- [ ] Create storage and loader for agent definitions.
- [ ] Create prompt asset layout and rendering helpers.
- [ ] Create tool registry with per-agent allowlists.
- [ ] Support output-schema references and run limits.
- [ ] Add business-level override support within safe boundaries.
- [ ] Add validation that non-supervisor agents cannot emit spawn requests when disallowed.

**Checks**
- [ ] Agent resolution works by ID and version.
- [ ] Prompt rendering fails on missing variables.
- [ ] Undeclared tools are rejected.
- [ ] Supervisor vs non-supervisor policy is enforced.
- [ ] Business overrides do not bypass contract validation.

---

## Phase 4: Memory Storage and Retrieval Core

**Goal:** Build the local-first memory subsystem without turning it into the system of record.

**Create:**
- memory persistence layer
- lexical retrieval layer
- vector retrieval layer
- memory query service
- provenance and versioning support

**Tasks**
- [ ] Implement `MemoryRecord` persistence with scope and class constraints.
- [ ] Implement lexical retrieval for exact recall.
- [ ] Implement vector retrieval for semantic recall.
- [ ] Implement `MemoryQuery` execution and ranking.
- [ ] Add provenance, confidence, and supersession support.
- [ ] Add scope-safe read guards for business, project, agent, and `global_patterns`.

**Checks**
- [ ] Business-local memory cannot be read from another business context.
- [ ] Project memory outranks business memory in retrieval order.
- [ ] Agent memory never outranks local project or business truth.
- [ ] `global_patterns` are queried only after local scopes.
- [ ] Provenance is returned with memory results when requested.

---

## Phase 5: Context Builder and Invocation Assembly

**Goal:** Assemble deterministic per-run context bundles from durable state and memory.

**Create:**
- task hydration
- business and project state hydration
- artifact ranking
- memory ranking and trimming
- `AgentInvocationPayload` assembly

**Tasks**
- [ ] Load task, run, business, and project state for an invocation.
- [ ] Pull relevant artifacts for the task and prior related runs.
- [ ] Execute memory retrieval in the approved scope order.
- [ ] Rank and trim memory and artifact results to context limits.
- [ ] Assemble the `ContextBundle`.
- [ ] Render `AgentInvocationPayload` for Trigger execution.

**Checks**
- [ ] Same inputs produce the same context bundle ordering.
- [ ] Context size limits are enforced.
- [ ] Task-linked artifacts appear before generalized memory.
- [ ] Working memory is assembled per run and not persisted as hidden chat state.

---

## Phase 6: Trigger Runtime and Provider Execution

**Goal:** Execute one bounded run through Trigger.dev and capture structured outcomes.

**Create:**
- Trigger tasks for run execution
- provider adapters
- result validation and persistence hooks
- timeout and retry metadata handling

**Tasks**
- [ ] Create Trigger task wrapper for single-shot run execution.
- [ ] Implement provider adapter abstraction.
- [ ] Validate and persist `AgentResult`.
- [ ] Persist artifacts and local memory writes emitted by runs.
- [ ] Reflect retry metadata into persisted `Run` state.
- [ ] Add provider error classification.

**Checks**
- [ ] A single run can execute end to end and persist a valid result.
- [ ] Provider timeout becomes the correct retry or terminal path.
- [ ] Malformed `AgentResult` is rejected safely.
- [ ] Run state transitions are legal and auditable.

---

## Phase 7: Delegation, Barrier Coordination, and Re-entry

**Goal:** Support recursive child-task orchestration safely.

**Create:**
- `SpawnRequest` to child-task transformer
- delegation contract creator
- barrier evaluator
- re-entry event emitter

**Tasks**
- [ ] Convert each valid `SpawnRequest` into a child `Task` and `Event`.
- [ ] Create `DelegationContract` records for delegated parent runs.
- [ ] Track required vs optional children.
- [ ] Evaluate barrier satisfaction on child completion.
- [ ] Re-enter the parent task with a fresh run and fresh context when the barrier is satisfied.
- [ ] Add required-child failure policy and review-state path.

**Checks**
- [ ] Three-child fan-out and re-entry scenario passes.
- [ ] Optional child completion does not block parent progress.
- [ ] Required child failure follows the configured failure or review path.
- [ ] Parent re-entry uses a fresh context bundle and not previous chat state.

---

## Phase 8: Artifacts and External Integrations

**Goal:** Make artifacts, external tools, and upstream metadata usable without breaking deterministic contracts.

**Create:**
- artifact storage adapters
- transcript or report persistence
- external metadata adapters
- tool output normalizers

**Tasks**
- [ ] Implement artifact storage for file, URL, and inline payload cases.
- [ ] Add transcript and report storage for later recall.
- [ ] Normalize external tool results into internal contracts.
- [ ] Add business and project metadata fetchers.
- [ ] Add failure classification for external integrations.

**Checks**
- [ ] File, URL, and inline artifact cases all validate and persist correctly.
- [ ] External tool failures are classified as retryable or terminal.
- [ ] Artifact provenance stays linked to task and run lineage.

---

## Phase 9: Consolidation and Pattern Promotion

**Goal:** Turn successful work into useful memory without contaminating cross-business knowledge.

**Create:**
- consolidation jobs for episodic, semantic, and procedural memory
- promotion candidate generation
- curator review flow
- `global_patterns` write path

**Tasks**
- [ ] Add post-run consolidation jobs.
- [ ] Extract episodic summaries from terminal run results.
- [ ] Extract stable facts and relationships into semantic memory.
- [ ] Extract playbooks and heuristics into procedural memory.
- [ ] Create `MemoryPromotionRequest` records for promotion candidates.
- [ ] Implement curator approval and rejection flow.
- [ ] Redact and abstract approved candidates before writing to `global_patterns`.

**Checks**
- [ ] Local memory is created from completed work.
- [ ] Promotion requests preserve source provenance.
- [ ] Approved promotions remove business-specific details.
- [ ] Regular agents cannot write directly to `global_patterns`.

---

## Phase 10: Retry, Reconciliation, Dead-Letter, and Review Queues

**Goal:** Make the runtime repairable and operable when things go wrong.

**Create:**
- retry scheduler hooks
- reconciliation workers
- dead-letter storage and inspection endpoints
- review queue support for `awaiting_review`
- operator override events

**Tasks**
- [ ] Implement bounded retry scheduling.
- [ ] Implement reconciliation scans for stale runs and parent tasks.
- [ ] Add dead-letter persistence and inspection path.
- [ ] Add review-queue persistence for tasks awaiting human review.
- [ ] Add explicit operator override events.

**Checks**
- [ ] Retry exhaustion produces the correct terminal outcome.
- [ ] Stale `awaiting_subtasks` parents can be recovered.
- [ ] Dead-letter entries are queryable and linked to lineage.
- [ ] Review-state tasks can be resumed only through explicit follow-up events.

---

## Phase 11: Observability, Security, and Tenancy Hardening

**Goal:** Make the platform safe and diagnosable for real business use.

**Create:**
- structured logging
- metrics and traces
- audit export path
- secret manager integration
- tenant isolation enforcement

**Tasks**
- [ ] Implement structured logs with task, run, event, and memory metadata.
- [ ] Implement metrics for throughput, failures, retries, fan-out, memory hits, and promotions.
- [ ] Add tracing across ingress, execution, memory, and persistence.
- [ ] Integrate secret resolution.
- [ ] Enforce business-level data isolation in persistence and retrieval.
- [ ] Add redaction rules for logs and promoted memories.

**Checks**
- [ ] Sensitive values do not appear in logs.
- [ ] Memory and artifact reads are tenant-safe.
- [ ] Metrics cover dead-letter, retries, and promotion flow.
- [ ] Audit exports include lineage and operator actions.

---

## Phase 12: Operator Surface and Pilot Readiness

**Goal:** Make the system usable by operators and safe enough for a first real business.

**Create:**
- basic operator API or UI for task timeline, dead letters, and promotion review
- health and readiness endpoints
- sample business and project bootstrap path
- pilot runbook

**Tasks**
- [ ] Add task and run inspection endpoints or views.
- [ ] Add dead-letter inspection endpoint or view.
- [ ] Add promotion-review endpoint or view.
- [ ] Add health and readiness endpoints.
- [ ] Create bootstrap flow for a first business, project, and initial agent pack.
- [ ] Write pilot runbook for incident handling and rollback.

**Checks**
- [ ] An operator can inspect a task from ingress through completion.
- [ ] An operator can review dead-lettered events.
- [ ] An operator can approve or reject a promotion request.
- [ ] A pilot business can complete one full parent-child workflow successfully.

---

## Phase 13: Release Readiness and Launch

**Goal:** Ship v1 with proof, not hope.

**Create:**
- release checklist
- backup and restore procedures
- capacity assumptions and limits
- launch acceptance report

**Tasks**
- [ ] Run full contract, integration, and scenario test suites.
- [ ] Run failure drills for timeout, malformed result, duplicate ingress, and stale barrier states.
- [ ] Verify backup and restore for Postgres and artifact storage.
- [ ] Verify rollout and rollback procedure.
- [ ] Produce launch acceptance report with known limits and deferred items.

**Checks**
- [ ] Full validation suite passes.
- [ ] Failure drills complete with expected outcomes.
- [ ] Backup and restore are proven.
- [ ] Deferred items are documented and explicitly not blocking launch.

---

## Deferred After v1

Do not include these in the v1 critical path:
- actor-native runtime
- separate graph database for memory relationships
- interactive human approval UX
- polyglot runtime
- advanced realtime collaboration control plane
