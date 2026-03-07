# Agentic Startup Companion Schema Specification

Status: Draft v1  
Type: Schema and Contract Specification  
Purpose: Define the canonical schemas, validation rules, scope boundaries, and payload structures for the Agentic Startup deterministic single-shot orchestration system

---

# Document Ownership

This document is the normative source of truth for:
- canonical entity and payload contracts
- field definitions, required and optional attributes, and enum values
- schema version policy and unknown field policy
- identifier rules and lineage requirements
- memory contracts, scope rules, and promotion lineage
- JSON examples and validation expectations

The runtime specification is the normative source of truth for:
- lifecycle behavior
- Trigger-first orchestration semantics
- retry, re-entry, reconciliation, and dead-letter policy
- memory lifecycle at the behavior level
- implementation phases and readiness criteria

If the two documents overlap, this document wins on payload shape and enum values.

---

# 1. Problem Statement

The Agentic Startup runtime requires strict, durable schemas so that ingress events, tasks, runs, delegations, artifacts, memory writes, and agent outputs can be validated deterministically across a recursive workflow.

Without explicit contracts, the platform becomes vulnerable to silent drift between services, ambiguous tool behavior, invalid state transitions, weak auditability, brittle retries, unsafe cross-business memory recall, and inconsistent agent outputs. This is especially dangerous in a system where agents are stateless and every invocation is reconstructed from external state.

This companion specification exists to define the data contracts that all services in the platform must obey.

---

# 2. Goals and Non-Goals

## 2.1 Goals

This specification must:
- define canonical schemas for core runtime entities
- define the minimum valid payload for webhook ingress
- define the internal event envelope used across the system
- define the agent configuration contract
- define the prompt input contract
- define the supervisor delegation and re-entry contract
- define the completion contract for all agents
- define artifact metadata rules
- define memory records, memory queries, and promotion contracts
- define idempotency, duplicate handling, and dead-letter expectations
- define schema versioning and unknown field policy
- support recursive task creation with lineage
- support adaptive memory while preserving tenant isolation

## 2.2 Non-Goals

This specification does not:
- prescribe a specific database engine beyond the contract assumptions needed for validation
- prescribe a specific queue implementation beyond the event and retry semantics needed for v1
- standardize every third-party provider payload
- define UI forms or operator dashboards
- define prompt wording for individual agents
- guarantee semantic correctness of model outputs

---

# 3. Contract Overview

## 3.1 v1 Assumptions

v1 assumes:
- TypeScript and Node.js runtime
- Trigger.dev for serverless execution
- Postgres for system-of-record persistence
- object storage for durable artifacts
- lexical search through Postgres FTS or BM25-style indexing
- semantic search through `pgvector` or equivalent vector indexing

These assumptions shape example payloads and validation rules, but the contracts remain transport-safe and provider-neutral where possible.

## 3.2 Main Contracts

The platform contracts are:
- `WebhookEnvelope`
- `AgentDefinition`
- `Task`
- `Run`
- `Event`
- `ContextBundle`
- `Artifact`
- `DelegationContract`
- `AgentResult`
- `AgentInvocationPayload`
- `SpawnRequest`
- `MemoryRecord`
- `MemoryQuery`
- `MemoryPromotionRequest`

Named enum types:
- `MemoryClass`
- `MemoryScope`

---

# 4. Canonical Contracts

## 4.1 Contract: WebhookEnvelope

Purpose: minimum valid ingress payload before normalization into an internal `Event`.

Fields:

- `schema_version` (string)  
  Version of the ingress schema

- `ingress_id` (string)  
  Unique identifier for the received ingress request

- `event_type` (string)  
  External or platform ingress event type

- `idempotency_key` (string)  
  Stable dedupe key for ingress replay protection

- `business_id` (string|null)  
  Owning business if known at ingress time

- `project_id` (string|null)  
  Owning project if known at ingress time

- `task_id` (string|null)  
  Existing task identifier if the ingress addresses an existing task

- `agent_id` (string|null)  
  Explicit target agent if provided

- `payload` (object)  
  Ingress-specific body

- `emitted_by` (string)  
  External system or internal component emitting the envelope

- `external_event_id` (string|null)  
  Upstream provider event identifier if available

- `received_at` (datetime)  
  UTC receive timestamp

## 4.2 Contract: AgentDefinition

Fields:

- `schema_version` (string)
- `agent_id` (string)
- `version` (string)
- `name` (string)
- `description` (string)
- `provider` (string)
- `model` (string)
- `reasoning_effort` (string)
- `system_prompt_ref` (string)
- `tools` (array<string>)
- `skills` (array<string>)
- `execution_mode` (string)  
  Allowed value in v1: `single_shot`
- `supervisor_mode` (boolean)
- `output_schema_ref` (string|null)
- `timeout_ms` (integer)
- `max_tool_calls` (integer)
- `enabled` (boolean)
- `created_at` (datetime)
- `updated_at` (datetime)

## 4.3 Contract: Task

Fields:

- `schema_version` (string)
- `task_id` (string)
- `root_task_id` (string)
- `parent_task_id` (string|null)
- `business_id` (string)
- `project_id` (string)
- `requested_agent_id` (string)
- `title` (string)
- `message` (string)
- `state_id` (string)
- `priority` (string)
- `source` (string)
- `source_ref` (string|null)
- `created_by` (string)
- `assigned_at` (datetime|null)
- `created_at` (datetime)
- `updated_at` (datetime)
- `completed_at` (datetime|null)

## 4.4 Contract: Run

Fields:

- `schema_version` (string)
- `run_id` (string)
- `task_id` (string)
- `parent_run_id` (string|null)
- `agent_id` (string)
- `trigger_event_id` (string)
- `status` (string)
- `attempt` (integer)
- `provider` (string)
- `model` (string)
- `reasoning_effort` (string)
- `started_at` (datetime)
- `completed_at` (datetime|null)
- `duration_ms` (integer|null)
- `token_usage` (object|null)
- `cost_estimate` (number|null)

## 4.5 Contract: Event

Purpose: internal event envelope used across the orchestration runtime.

Fields:

- `schema_version` (string)
- `event_id` (string)
- `event_type` (string)
- `task_id` (string|null)
- `run_id` (string|null)
- `agent_id` (string|null)
- `business_id` (string|null)
- `project_id` (string|null)
- `payload` (object)
- `emitted_by` (string)
- `correlation_id` (string|null)
- `causation_id` (string|null)
- `dedupe_key` (string|null)
- `created_at` (datetime)

## 4.6 Contract: ContextBundle

Fields:

- `schema_version` (string)
- `context_bundle_id` (string)
- `task` (object)  
  Snapshot projection of `Task`
- `run` (object)  
  Snapshot projection of `Run`
- `business` (object)
- `project` (object)
- `related_memory` (array<object>)  
  Ranked memory projections derived from `MemoryRecord`
- `related_artifacts` (array<object>)
- `related_people` (array<object>)
- `constraints` (array<string>)
- `objective` (string)
- `memory_scope_order` (array<string>)
- `generated_at` (datetime)

## 4.7 Contract: Artifact

Fields:

- `schema_version` (string)
- `artifact_id` (string)
- `task_id` (string)
- `run_id` (string)
- `type` (string)
- `name` (string)
- `path` (string|null)
- `uri` (string|null)
- `mime_type` (string|null)
- `inline_payload` (object|string|null)
- `metadata` (object)
- `created_at` (datetime)

## 4.8 Contract: DelegationContract

Fields:

- `schema_version` (string)
- `delegation_id` (string)
- `parent_task_id` (string)
- `parent_run_id` (string)
- `reentry_agent_id` (string)
- `mode` (string)
- `required_children` (array<object>)
- `optional_children` (array<object>)
- `child_task_ids` (array<string>)
- `reentry_objective` (string)
- `status` (string)
- `expires_at` (datetime|null)
- `created_at` (datetime)
- `updated_at` (datetime)

## 4.9 Contract: AgentResult

Fields:

- `schema_version` (string)
- `run_id` (string)
- `task_id` (string)
- `agent_id` (string)
- `summary` (string)
- `state_id` (string)
- `outcome` (string)
- `result` (object|null)
- `artifacts` (array<object>)
- `spawn` (array<object>)
- `reentry_mode` (string|null)
- `reentry_objective` (string|null)
- `errors` (array<object>)
- `memory_writes` (array<object>)  
  Optional local-scope memory upserts emitted by the run
- `completed_at` (datetime)

## 4.10 Contract: AgentInvocationPayload

Fields:

- `schema_version` (string)
- `run_id` (string)
- `task_id` (string)
- `agent` (object)
- `context_bundle` (object)
- `tool_registry` (array<object>)
- `constraints` (object)
- `prompt` (object)

## 4.11 Contract: SpawnRequest

Fields:

- `tool_name` (string)
- `target_agent_id` (string)
- `title` (string)
- `message` (string)
- `required` (boolean)
- `priority` (string)
- `context_overrides` (object|null)
- `expected_output` (object|null)
- `tags` (array<string>)

## 4.12 Contract: MemoryRecord

Purpose: canonical durable memory record used for episodic, semantic, and procedural memory.

Fields:

- `schema_version` (string)
- `memory_id` (string)
- `memory_class` (string)
- `scope` (string)
- `business_id` (string|null)
- `project_id` (string|null)
- `agent_id` (string|null)
- `title` (string)
- `summary` (string)
- `content` (object|string)
- `keywords` (array<string>)
- `source_type` (string)
- `source_ref` (string)
- `provenance` (array<object>)
- `confidence` (number)
- `version` (integer)
- `supersedes_memory_id` (string|null)
- `status` (string)  
  Suggested values: `active`, `superseded`, `archived`
- `created_at` (datetime)
- `updated_at` (datetime)

## 4.13 Contract: MemoryQuery

Purpose: normalized retrieval request used by the context builder and memory service.

Fields:

- `schema_version` (string)
- `query_id` (string)
- `requester_agent_id` (string)
- `task_id` (string|null)
- `business_id` (string|null)
- `project_id` (string|null)
- `query_text` (string)
- `scope_order` (array<string>)
- `allowed_classes` (array<string>)
- `max_results` (integer)
- `include_global_patterns` (boolean)
- `include_provenance` (boolean)
- `created_at` (datetime)

## 4.14 Contract: MemoryPromotionRequest

Purpose: controlled request to promote local memory into curated `global_patterns`.

Fields:

- `schema_version` (string)
- `promotion_request_id` (string)
- `source_memory_ids` (array<string>)
- `requested_by_agent_id` (string)
- `target_scope` (string)  
  Allowed value in v1: `global_patterns`
- `abstracted_title` (string)
- `abstracted_content` (object|string)
- `redaction_notes` (string|null)
- `provenance_refs` (array<string>)
- `status` (string)
- `reviewed_by` (string|null)
- `reviewed_at` (datetime|null)
- `created_at` (datetime)

---

# 5. Enumerations and Validation Rules

## 5.1 Task States

Allowed values:
- `created`
- `backlog`
- `in_progress`
- `awaiting_subtasks`
- `awaiting_review`
- `qa_validation`
- `completed`
- `failed`
- `blocked`

## 5.2 Run States

Allowed values:
- `queued`
- `running`
- `succeeded`
- `failed`
- `retrying`
- `timed_out`
- `cancelled`

## 5.3 Delegation States

Allowed values:
- `pending`
- `satisfied`
- `failed`
- `expired`

## 5.4 Agent Outcomes

Allowed values for `AgentResult.outcome`:
- `success`
- `delegated`
- `blocked`
- `failed`
- `needs_review`

## 5.5 Artifact Types

Allowed values in v1:
- `file`
- `json`
- `report`
- `log`
- `url`
- `image`
- `diff`
- `transcript`

## 5.6 Type: MemoryClass

Allowed values:
- `episodic`
- `semantic`
- `procedural`
- `working`

`working` exists only inside a `ContextBundle` and must not be persisted as a durable `MemoryRecord`.

## 5.7 Type: MemoryScope

Allowed values:
- `business`
- `project`
- `agent`
- `global_patterns`

## 5.8 Identifier Rules

- all core entity IDs must be opaque and immutable
- IDs must not be recycled
- root lineage must always be preserved across task chains
- event correlation must support both `correlation_id` and `causation_id`
- timestamps must be UTC ISO 8601 strings
- suggested prefixes are:
  - `ingress_`
  - `agent_`
  - `task_`
  - `run_`
  - `evt_`
  - `artifact_`
  - `ctx_`
  - `delegation_`
  - `memory_`
  - `memqry_`
  - `promote_`

## 5.9 Schema Version Policy

- every contract must carry `schema_version`
- v1 examples use `1.0`
- version mismatches are reject-by-default
- version migrations must be explicit and version-aware

## 5.10 Unknown Field Policy

- unknown fields are rejected by default
- only explicitly marked metadata objects may accept additional properties
- sensitive contracts such as `WebhookEnvelope`, `Event`, `AgentResult`, `MemoryQuery`, and `MemoryPromotionRequest` must use strict unknown-field rejection

## 5.11 Artifact Reference Rules

- an artifact may use exactly one of:
  - `path`
  - `uri`
  - `inline_payload`
- `inline_payload` is allowed only for bounded small objects within configured size limits
- `path` is for internal storage references
- `uri` is for external or object-store addresses
- empty artifacts with all three absent are invalid

## 5.12 Memory Visibility Rules

Allowed visibility transitions:
- `business` -> `business`
- `project` -> `project`
- `agent` -> `agent`
- `business|project|agent` -> `global_patterns` only through approved `MemoryPromotionRequest`
- direct writes to `global_patterns` from regular agent runs are forbidden

---

# 6. Runtime Contract Rules

## 6.1 Ingress and Idempotency

- a valid `WebhookEnvelope` must include `idempotency_key`
- two ingress envelopes with the same `idempotency_key` and same business context must resolve to the same durable outcome
- duplicate ingress must not create duplicate tasks, runs, or child tasks
- invalid ingress must be dead-lettered before any task mutation

## 6.2 State Transition Rules

- a `Task` may move to `awaiting_subtasks` only when `AgentResult.outcome == delegated`
- a `Task` may move to `completed` only from a valid terminal `AgentResult`
- a `Run` in `running` may transition only to `succeeded`, `failed`, `timed_out`, or `retrying`
- `qa_validation` and `awaiting_review` require external or operator follow-up events

## 6.3 Barrier Rules

- every `DelegationContract` must identify required and optional children separately
- optional children do not block parent progress
- a barrier is satisfied only when all required children complete successfully unless policy says otherwise
- failure of a required child must either fail the contract or move the parent to an explicit review or blocked state according to policy

## 6.4 Retry and Dead-Letter Rules

- a retry keeps the same `task_id` and increments `attempt`
- each retry creates a new `run_id`
- `parent_run_id` must preserve retry lineage when needed
- unsupported schema versions, malformed `AgentResult`, illegal transitions, and irrecoverable payload errors must dead-letter rather than mutate workflow state

## 6.5 Working Memory Assembly Rule

- `ContextBundle.related_memory` must be assembled from scoped retrieval, not hidden chat state
- retrieval order is project, then business, then agent, then `global_patterns`
- `global_patterns` must be consulted only after local scopes
- all memory results must carry enough provenance to explain why they were included

## 6.6 Promotion Rule

- only approved `MemoryPromotionRequest` records may create `global_patterns` memories
- promoted records must be abstracted and redacted before publication
- promoted records must preserve lineage back to the source memory IDs or source task references

---

# 7. Validation and Safety

Validation must reject:
- missing required fields
- invalid enum values
- duplicate IDs where uniqueness is required
- broken lineage chains on delegated tasks
- spawn requests from non-supervisor agents when policy disallows it
- cross-business memory queries without explicit platform policy
- promotion requests that target anything other than `global_patterns`
- artifacts exceeding inline payload limits
- unknown fields in strict contracts

---

# 8. Reference Algorithms

## 8.1 Validate Ingress Event

```typescript
validate_webhook_envelope(envelope):
    assert envelope.schema_version is supported
    assert envelope.idempotency_key exists
    assert envelope.event_type is valid
    assert required identifiers are well formed
    normalize timestamps to UTC
    return envelope
```

## 8.2 Convert SpawnRequest to Child Task

```typescript
create_child_task_from_spawn(parent_task, parent_run, spawn):
    assert spawn.target_agent_id exists
    assert parent agent is allowed to use spawn.tool_name
    child_task.task_id = new_id("task")
    child_task.root_task_id = parent_task.root_task_id
    child_task.parent_task_id = parent_task.task_id
    child_task.business_id = parent_task.business_id
    child_task.project_id = parent_task.project_id
    child_task.requested_agent_id = spawn.target_agent_id
    child_task.title = spawn.title
    child_task.message = spawn.message
    child_task.state_id = "created"
    persist child_task
    emit task.created event
```

## 8.3 Validate AgentResult

```typescript
validate_agent_result(result, run, task):
    assert result.run_id == run.run_id
    assert result.task_id == task.task_id
    assert result.agent_id == run.agent_id
    assert result.summary is present
    assert result.state_id is valid
    assert result.outcome is valid
    validate artifacts array
    validate spawn array
    validate memory_writes array
    validate error objects
    return valid_result
```

## 8.4 Query Memory

```typescript
query_memory(memory_query):
    assert memory_query.scope_order is valid
    assert memory_query.allowed_classes is valid
    assert memory_query.max_results > 0
    results = lexical_search(memory_query)
    results += semantic_search(memory_query)
    ranked = rank_and_dedupe(results)
    return trim(ranked, memory_query.max_results)
```

## 8.5 Promote Memory

```typescript
promote_memory(request):
    assert request.target_scope == "global_patterns"
    assert request.status in ["pending_review", "approved"]
    assert request.source_memory_ids is not empty

    abstracted = redact_business_specific_details(request.abstracted_content)
    if abstracted.failed:
        reject request
        return

    memory.scope = "global_patterns"
    memory.memory_class = "procedural"
    memory.provenance = request.provenance_refs
    persist memory
    mark request completed
```

---

# 9. Test and Validation Matrix

## 9.1 Core Conformance Tests

Required tests:
- `WebhookEnvelope` validates and deduplicates correctly
- `AgentDefinition` validates against schema
- `Task` validates with lineage rules
- `Run` validates with trigger linkage
- `Event` validates with supported event type and dedupe rules
- `ContextBundle` validates with bounded context arrays and scope order
- `Artifact` validates across `path`, `uri`, and `inline_payload` modes
- `DelegationContract` validates required and optional child structure
- `AgentResult` validates for each allowed outcome
- `SpawnRequest` validates and creates proper child tasks
- `MemoryRecord` validates for scope, class, and provenance
- `MemoryQuery` validates retrieval precedence and scope safety
- `MemoryPromotionRequest` validates target scope and promotion lineage

## 9.2 Integration Tests

Required tests:
- model provider response maps to `AgentResult`
- object storage write maps to `Artifact`
- external memory retrieval maps to `MemoryRecord` projections correctly
- webhook request maps to `Event` and `Task` correctly
- sub-agent tool call maps to `SpawnRequest` and child `Task` correctly
- approved promotion request creates a `global_patterns` `MemoryRecord`

## 9.3 Operational Tests

Runtime scenarios:
- parent task fans out three children and re-enters correctly
- parent task receives partial optional child completion without blocking
- malformed `AgentResult` is rejected and retried or dead-lettered
- missing artifact path causes persistence failure classification
- duplicate ingress submission is safely handled
- unsupported `schema_version` is rejected without state mutation
- business-local memory is not returned outside the owning business scope
- global pattern promotion strips business-specific details and preserves provenance

---

# 10. JSON Examples

```json
{
  "WebhookEnvelope": {
    "schema_version": "1.0",
    "ingress_id": "ingress_001",
    "event_type": "task.requested",
    "idempotency_key": "req_launch_campaign_2026_03_07",
    "business_id": "biz_001",
    "project_id": "proj_001",
    "task_id": null,
    "agent_id": "agent_cmo",
    "payload": {
      "title": "Launch campaign strategy",
      "message": "Create a launch campaign strategy for Project Atlas."
    },
    "emitted_by": "api_gateway",
    "external_event_id": "ext_991",
    "received_at": "2026-03-07T08:00:00Z"
  },
  "AgentDefinition": {
    "schema_version": "1.0",
    "agent_id": "agent_cmo",
    "version": "v1",
    "name": "CMO",
    "description": "Supervisory marketing agent",
    "provider": "openai",
    "model": "gpt-5.4-pro",
    "reasoning_effort": "xhigh",
    "system_prompt_ref": "prompts/cmo.md",
    "tools": ["tool_image_agent", "tool_research_agent", "tool_paid_ads_agent"],
    "skills": ["brand_strategy", "campaign_design", "growth_marketing"],
    "execution_mode": "single_shot",
    "supervisor_mode": true,
    "output_schema_ref": "schemas/agent-result/cmo-v1.json",
    "timeout_ms": 120000,
    "max_tool_calls": 12,
    "enabled": true,
    "created_at": "2026-03-07T08:00:00Z",
    "updated_at": "2026-03-07T08:00:00Z"
  },
  "Task": {
    "schema_version": "1.0",
    "task_id": "task_001",
    "root_task_id": "task_001",
    "parent_task_id": null,
    "business_id": "biz_001",
    "project_id": "proj_001",
    "requested_agent_id": "agent_cmo",
    "title": "Launch campaign strategy",
    "message": "Create a launch campaign strategy for Project Atlas.",
    "state_id": "created",
    "priority": "high",
    "source": "webhook",
    "source_ref": "ingress_001",
    "created_by": "ops_api",
    "assigned_at": null,
    "created_at": "2026-03-07T08:00:00Z",
    "updated_at": "2026-03-07T08:00:00Z",
    "completed_at": null
  },
  "Event": {
    "schema_version": "1.0",
    "event_id": "evt_001",
    "event_type": "task.created",
    "task_id": "task_001",
    "run_id": null,
    "agent_id": "agent_cmo",
    "business_id": "biz_001",
    "project_id": "proj_001",
    "payload": {
      "objective": "Create an initial launch strategy."
    },
    "emitted_by": "event_router",
    "correlation_id": "corr_001",
    "causation_id": null,
    "dedupe_key": "task_001:task.created",
    "created_at": "2026-03-07T08:00:01Z"
  },
  "SpawnRequest": {
    "tool_name": "tool_research_agent",
    "target_agent_id": "agent_research",
    "title": "Market research sweep",
    "message": "Find competitor launch positioning and summarize the three strongest patterns.",
    "required": true,
    "priority": "high",
    "context_overrides": {
      "window_days": 90
    },
    "expected_output": {
      "type": "competitor_research_summary"
    },
    "tags": ["launch", "research"]
  },
  "AgentResult": {
    "schema_version": "1.0",
    "run_id": "run_001",
    "task_id": "task_001",
    "agent_id": "agent_cmo",
    "summary": "Delegated strategy work into research and visual streams.",
    "state_id": "awaiting_subtasks",
    "outcome": "delegated",
    "result": {
      "strategy_mode": "launch_campaign"
    },
    "artifacts": [],
    "spawn": [
      {
        "tool_name": "tool_research_agent",
        "target_agent_id": "agent_research",
        "title": "Market research sweep",
        "message": "Find competitor launch positioning and summarize the three strongest patterns.",
        "required": true,
        "priority": "high",
        "context_overrides": null,
        "expected_output": {
          "type": "competitor_research_summary"
        },
        "tags": ["launch", "research"]
      }
    ],
    "reentry_mode": "barrier",
    "reentry_objective": "Merge child outputs into a final launch strategy.",
    "errors": [],
    "memory_writes": [],
    "completed_at": "2026-03-07T08:02:00Z"
  },
  "MemoryRecord": {
    "schema_version": "1.0",
    "memory_id": "memory_101",
    "memory_class": "procedural",
    "scope": "project",
    "business_id": "biz_001",
    "project_id": "proj_001",
    "agent_id": "agent_cmo",
    "title": "Launch messaging review loop",
    "summary": "Use founder narrative first, then competitor contrast, then CTA refinement.",
    "content": {
      "steps": [
        "Draft founder narrative",
        "Add contrast framing",
        "Refine CTA last"
      ]
    },
    "keywords": ["launch", "messaging", "playbook"],
    "source_type": "task_outcome",
    "source_ref": "task_001",
    "provenance": [
      {
        "task_id": "task_001",
        "run_id": "run_003"
      }
    ],
    "confidence": 0.87,
    "version": 1,
    "supersedes_memory_id": null,
    "status": "active",
    "created_at": "2026-03-07T08:10:00Z",
    "updated_at": "2026-03-07T08:10:00Z"
  },
  "MemoryQuery": {
    "schema_version": "1.0",
    "query_id": "memqry_001",
    "requester_agent_id": "agent_cmo",
    "task_id": "task_001",
    "business_id": "biz_001",
    "project_id": "proj_001",
    "query_text": "launch messaging playbooks for premium B2B product rollouts",
    "scope_order": ["project", "business", "agent", "global_patterns"],
    "allowed_classes": ["episodic", "semantic", "procedural"],
    "max_results": 8,
    "include_global_patterns": true,
    "include_provenance": true,
    "created_at": "2026-03-07T08:11:00Z"
  },
  "MemoryPromotionRequest": {
    "schema_version": "1.0",
    "promotion_request_id": "promote_001",
    "source_memory_ids": ["memory_101"],
    "requested_by_agent_id": "agent_ops_curator",
    "target_scope": "global_patterns",
    "abstracted_title": "Premium product launch messaging loop",
    "abstracted_content": {
      "pattern": "Founder narrative first, contrast second, CTA refinement last."
    },
    "redaction_notes": "Removed business name and project-specific positioning language.",
    "provenance_refs": ["memory_101", "task_001"],
    "status": "pending_review",
    "reviewed_by": null,
    "reviewed_at": null,
    "created_at": "2026-03-07T08:12:00Z"
  }
}
```
