# Xena v1 Implementation Readiness

This checklist turns the specs into an implementation order with proof gates. It is intentionally strict: no phase is complete without evidence.

## 1. Phase Order

### Phase 1: Schema and Validation Layer

Deliver:
- canonical schemas for ingress, runtime, and memory contracts
- enum sets and unknown-field policy
- idempotency and duplicate-handling validation

Proof:
- contract validation tests
- duplicate ingress tests
- unsupported schema version tests

Source sections:
- [specification.md#17-implementation-readiness-phases](/Users/ava/main/projects/openSource/xena/specification.md)
- [companion-schema.md#4-canonical-contracts](/Users/ava/main/projects/openSource/xena/companion-schema.md)
- [companion-schema.md#5-enumerations-and-validation-rules](/Users/ava/main/projects/openSource/xena/companion-schema.md)

### Phase 2: Event, Task, Run, and Artifact Persistence

Deliver:
- durable Postgres tables for tasks, runs, events, and delegation contracts
- artifact metadata persistence
- dead-letter persistence

Proof:
- lineage preservation tests
- artifact reference validation tests
- illegal transition rejection tests

### Phase 3: Memory Contracts and Storage Schema

Deliver:
- `MemoryRecord`, `MemoryQuery`, and `MemoryPromotionRequest` persistence
- scope-safe indexes and lookup paths
- provenance and versioning support

Proof:
- scope isolation tests
- provenance preservation tests
- promotion target validation tests

### Phase 4: Context Builder and Invocation Payload Assembly

Deliver:
- ranked memory retrieval
- artifact and state hydration
- `AgentInvocationPayload` assembly

Proof:
- retrieval precedence tests
- context bundle size-limit tests
- missing-variable prompt construction tests

### Phase 5: Trigger Execution Runtime

Deliver:
- bounded single-shot run execution through Trigger.dev
- provider integration and result capture
- run state updates and metrics

Proof:
- successful end-to-end single-run execution
- provider timeout classification tests
- retry scheduling tests

### Phase 6: Delegation, Barrier Coordination, and Re-entry

Deliver:
- `SpawnRequest` transformation
- child-task creation
- delegation contract handling
- barrier-based re-entry

Proof:
- three-child fan-out and re-entry scenario
- optional child non-blocking scenario
- required child failure scenario

### Phase 7: Consolidation and Promotion Jobs

Deliver:
- episodic, semantic, and procedural memory extraction
- promotion candidate creation
- curator review path for `global_patterns`

Proof:
- local memory creation tests
- promotion redaction tests
- provenance-preserving promotion tests

### Phase 8: Retry, Reconciliation, and Dead-Letter Handling

Deliver:
- bounded retry logic
- reconciliation workers
- dead-letter inspection path

Proof:
- retry exhaustion tests
- stale awaiting-subtasks recovery tests
- malformed agent-result dead-letter tests

### Phase 9: Minimal Observability

Deliver:
- logs, metrics, and status surfaces for runtime and memory
- dead-letter and promotion visibility

Proof:
- metric emission checks
- audit-log checks
- operator inspection path checks

## 2. Final Acceptance Gates

Before implementation can be called ready:
- every state name matches across specs and runtime code
- every public contract named in the runtime spec exists in the schema layer
- local memory always outranks global patterns in context assembly
- global pattern promotion is curated and provenance-preserving
- no implementation-critical decision remains runtime-neutral inside the v1 core

## 3. Stop Rules

Stop and fix the design before continuing if:
- a proposed implementation bypasses persisted event or task state
- a parent agent tries to call a child model session inline
- memory becomes the only source of business truth
- raw business data can cross businesses through the pattern layer
- a phase claims completion without direct verification evidence
