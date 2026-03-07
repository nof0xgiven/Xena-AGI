# Agentic Startup Specification

Status: Draft v1  
Type: Technical Service Specification  
Purpose: Deterministic webhook-driven orchestration system for stateless, single-shot AI agents that execute tasks recursively through structured delegation, scoped memory retrieval, and event-based re-entry

---

# Document Ownership

This document is the normative source of truth for:
- system purpose and bounded context
- runtime lifecycle and legal orchestration behavior
- Trigger-first execution semantics
- retry, barrier, re-entry, reconciliation, and dead-letter behavior
- memory lifecycle and governance at the behavior level
- implementation phases and acceptance criteria

The companion schema document is the normative source of truth for:
- canonical payloads and entity contracts
- field definitions, enum values, and identifier rules
- schema version policy and unknown field policy
- JSON examples and validation expectations
- memory contracts, scopes, and promotion lineage

If the two documents overlap, this document wins on lifecycle behavior and the companion schema wins on payload shape.

---

# 1. Problem Statement

Modern AI agent systems often depend on long-lived chat threads, hidden memory, tool access that is too broad, and orchestration that lives inside model context instead of durable workflow state. That creates token waste, weak auditability, hard-to-replay execution, and operational drift as context windows accrete unrelated material over time.

Agentic Startup exists to solve this by separating orchestration truth from model reasoning. Every agent invocation is stateless, single-shot, and event-triggered. The platform reconstructs a fresh working context for each run from persisted task state, project and business state, artifacts, and scoped memory retrieval. Agents do one bounded piece of work, emit a structured result, optionally delegate through structured child-task requests, and exit.

The target environment is a business operating system with many role-specialized agents working across one or more businesses and one or more projects. The runtime must preserve tenant boundaries while still allowing curated cross-business learning through abstract global patterns.

Expected outcomes:
- deterministic orchestration around non-deterministic reasoning
- lower token use and lower context drift
- replayable task lineage from ingress to completion
- clear business, project, agent, and global memory boundaries
- scalable recursive delegation without shared conversational threads

---

# 2. Goals and Non-Goals

## 2.1 Goals

The system must:
- execute all agent work through deterministic webhook-triggered workflows
- treat every agent invocation as a stateless single-shot execution
- build a fresh context bundle for every invocation from current task, business, project, artifact, and scoped memory state
- support recursive delegation where supervisors emit child tasks as structured tool outputs
- separate orchestration state from model context
- support fan-out and fan-in execution patterns
- enable barrier-based coordination for multi-subtask completion
- support typed completion contracts and artifact outputs
- provide traceable lineage from parent task to child tasks and results
- maintain strict tool allowlists per agent
- support retry, failure recovery, and reconciliation without conversational continuity
- support adaptive memory while keeping business facts isolated and cross-business sharing curated
- minimize token use by retrieving only the memory needed for the current run

## 2.2 Non-Goals

The system does not:
- provide persistent conversational memory inside agents
- rely on long-lived agent sessions as the core runtime model
- allow sub-agents to act as peers inside a shared chat thread
- allow unrestricted tool access across all agents
- perform open-ended autonomous execution without explicit task events
- guarantee identical model outputs for identical prompts
- replace deterministic workflow logic with LLM reasoning
- store business truth only inside semantic memory systems
- implement human approval UX in v1 beyond explicit review-state handoffs
- adopt actor-native runtime state as the v1 execution model

---

# 3. System Overview

Agentic Startup is a deterministic orchestration platform built around a recursive event pipeline and a scoped memory subsystem.

The core runtime pipeline is:

`Webhook ingress -> validation and dedupe -> task/run persistence -> context build -> Trigger execution -> result validation -> artifact and memory persistence -> follow-up routing`

Every event triggers a fresh single-shot invocation. The receiving agent gets a fully assembled context bundle and a constrained toolset. It executes one bounded reasoning cycle, returns structured outputs, optionally emits child tasks through tool invocations, and exits.

Supervisors do not wait inside model context. If they require downstream results, the workflow enters an orchestration waiting state such as `awaiting_subtasks`. When required child outputs are available, the orchestrator emits a new event that re-invokes the supervisor with a fresh context bundle containing the relevant child results and memory.

## 3.1 v1 Runtime Baseline

v1 is locked to the following baseline:
- TypeScript and Node.js runtime
- Trigger.dev as the serverless execution substrate
- Postgres as the durable system-of-record store
- object storage for durable artifacts
- Postgres full-text search or BM25-style lexical retrieval for exact recall
- `pgvector` or equivalent vector index for semantic retrieval
- Trigger-driven consolidation and promotion jobs for memory maintenance

One Trigger task run maps to one bounded agent execution attempt. A parent run may emit child tasks, but may not directly invoke nested model sessions inline.

## 3.2 Main Components

1. **Webhook Ingress**
   - Responsibility: receive external and internal task events
   - Inputs: HTTP event payloads from operators, systems, or internal platform producers
   - Outputs: validated ingress envelopes

2. **Schema Validator and Dedupe Layer**
   - Responsibility: validate payload shape, identifiers, idempotency keys, and transition legality
   - Inputs: raw ingress envelopes and internal event payloads
   - Outputs: normalized internal events or dead-letter records

3. **Task, Run, and Event Store**
   - Responsibility: persist orchestration truth
   - Inputs: normalized events, routing decisions, run outcomes
   - Outputs: durable state and lineage

4. **Context Builder**
   - Responsibility: construct a per-run context bundle
   - Inputs: task state, business state, project state, artifacts, scoped memory results, invocation objective
   - Outputs: prompt-ready context bundle

5. **Agent Registry**
   - Responsibility: resolve agent definitions by ID and version
   - Inputs: agent identifier
   - Outputs: provider config, prompt reference, tools, skills, execution constraints

6. **Trigger Execution Runtime**
   - Responsibility: execute one bounded agent run
   - Inputs: agent invocation payload, runtime constraints, tool registry
   - Outputs: structured agent result, tool emissions, artifacts, errors

7. **Delegation Orchestrator**
   - Responsibility: manage child-task creation, barrier contracts, re-entry, retries, and reconciliation
   - Inputs: agent results, child completions, timeout events, retry events
   - Outputs: next events, state transitions, dead-letter records, reconciliation actions

8. **Artifact Store**
   - Responsibility: persist files, URLs, logs, reports, and structured outputs
   - Inputs: artifact metadata and storage payloads
   - Outputs: durable artifact references

9. **Memory Service**
   - Responsibility: store, retrieve, consolidate, and promote scoped memory
   - Inputs: task outcomes, artifacts, transcripts, explicit memory writes, promotion requests
   - Outputs: memory records, query results, promotion decisions, abstract global patterns

10. **Observability Layer**
   - Responsibility: capture logs, metrics, traces, dead-letter records, and operator status
   - Inputs: system events and execution metadata
   - Outputs: dashboards, audit records, diagnostics

## 3.3 Deferred Capabilities

These are intentionally deferred from v1:
- actor-native runtime and long-lived in-memory workers
- realtime collaboration control plane
- interactive human approval UX
- polyglot execution runtime
- separate graph database for memory relationships

---

# 4. Bounded Context and Runtime Responsibilities

## 4.1 Core Runtime Responsibilities

The runtime revolves around these responsibilities:

- **AgentDefinition** defines who an agent is allowed to be and do.
- **Task** is the durable business work item that survives retries and re-entry.
- **Run** is one execution attempt of one task.
- **Event** is the immutable routing signal that advances the workflow.
- **ContextBundle** is the fresh, bounded working memory assembled for one run.
- **Artifact** is durable evidence or output created by a run.
- **DelegationContract** defines how parent and child tasks coordinate.
- **AgentResult** is the only valid completion shape an agent may return.

Field-level definitions live in the companion schema. This document defines how those contracts behave together.

## 4.2 Memory as a Bounded Context

Memory is a first-class bounded context with four layers:

- `ground_truth`: tasks, runs, events, artifacts, entities, project state, and business state stored in durable typed tables
- `retrieval_memory`: exact and semantic recall over prior conversations, outcomes, artifacts, and documents
- `consolidated_knowledge`: extracted facts, relationships, playbooks, and heuristics derived from prior work
- `working_memory`: the transient context bundle for a single run

The memory subsystem must support these memory classes:
- `episodic`
- `semantic`
- `procedural`
- `working`

The memory subsystem must support these scopes:
- `business`
- `project`
- `agent`
- `global_patterns`

Governance rules:
- business facts remain isolated to their owning business and project scopes
- cross-business sharing is allowed only through `global_patterns`
- `global_patterns` may contain abstracted tactics, playbooks, and heuristics only
- raw customer data, raw business facts, and project-specific artifacts must not be promoted into `global_patterns`
- promotion into `global_patterns` is curated, not direct from every agent
- retrieval precedence is local then global: task and project context first, then business memory, then agent memory, then global patterns

---

# 5. Configuration Baseline

Configuration precedence is:

1. runtime arguments and validated event payload overrides
2. Postgres-backed business and project configuration
3. static configuration files and registry definitions
4. environment variables
5. built-in defaults

Runtime configuration must cover:
- concurrency limits by global, business, agent, and provider dimensions
- retry bounds and backoff policy
- Trigger queue names and routing policy
- context bundle size limits
- memory retrieval limits and scope order
- artifact storage roots and retention policy
- secret resolution
- observability enablement

---

# 6. Runtime Behaviour

## 6.1 State Machine

The runtime maintains separate state machines for task state, run state, and delegation state.

Task states:
- `created`
- `backlog`
- `in_progress`
- `awaiting_subtasks`
- `awaiting_review`
- `qa_validation`
- `completed`
- `failed`
- `blocked`

Run states:
- `queued`
- `running`
- `succeeded`
- `failed`
- `retrying`
- `timed_out`
- `cancelled`

Delegation states:
- `pending`
- `satisfied`
- `failed`
- `expired`

Dead-lettering is an orchestration outcome for invalid or irrecoverable events, not a task state.

## 6.2 Lifecycle

Typical lifecycle:

1. ingress receives a webhook or internal system event
2. ingress envelope is validated and deduplicated
3. internal event is persisted
4. task and routing rules are resolved
5. run record is created
6. context bundle is assembled from durable state, artifacts, and scoped memory
7. Trigger executes one bounded agent run
8. returned `AgentResult` is validated
9. artifacts and memory writes are persisted
10. task state and delegation contracts are updated
11. router emits follow-up events, retry events, or review events
12. reconciliation jobs repair missed transitions or stale waiting states

## 6.3 Trigger Mapping

Trigger.dev is the serverless runtime substrate, not the source of orchestration truth.

Rules:
- one Trigger task execution equals one platform run attempt
- Trigger retry behavior must be reflected into persisted run attempt metadata
- parent tasks emit child tasks through `SpawnRequest` transformation, never by direct nested model execution
- barrier satisfaction and parent re-entry are platform orchestration decisions driven by stored state
- long waits are represented by persisted task state plus future events, not hidden agent suspension

## 6.4 Idempotency and Dead-Letter Handling

The runtime must:
- deduplicate ingress requests using an idempotency key or stable dedupe key
- reject duplicate internal events that would cause illegal repeated state mutation
- send malformed ingress payloads to dead-letter storage before any task mutation
- dead-letter malformed `AgentResult` payloads after bounded repair attempts
- preserve event, task, and run lineage for every dead-lettered record

---

# 7. Execution Engine

## 7.1 Scheduling

The engine is event-driven. Work enters through:
- external webhook events
- internal task creation events
- retry timer events
- barrier satisfaction events
- reconciliation events
- memory consolidation and promotion jobs

Only schema-valid events may schedule work.

## 7.2 Concurrency and Idempotency

Concurrency limits must be configurable by:
- global active run cap
- per-business active run cap
- per-agent active run cap
- per-provider request cap
- per-task child fan-out cap

The runtime must reject or queue excess work rather than oversubscribe providers or infrastructure capacity.

Concurrency safety requirements:
- a task may not have more than one active run unless routing policy explicitly permits it
- a spawn item may not create more than one child task
- barrier contracts must remain consistent under concurrent child completions
- duplicate events must resolve to the same durable outcome

## 7.3 Retry Strategy

Retryable conditions include:
- transient provider API failures
- temporary tool unavailability
- rate limiting
- network interruptions
- object storage write failures
- temporary vector or lexical retrieval service failures

Non-retryable conditions include:
- invalid configuration
- invalid prompt rendering inputs
- illegal state transition attempts
- missing required identifiers
- schema-invalid agent outputs after bounded repair attempts
- forbidden cross-scope memory access attempts

Backoff must use exponential growth with jitter. Retry attempts must be bounded and visible in run metadata.

## 7.4 Reconciliation

The system must periodically verify:
- queued tasks are still eligible for dispatch
- running tasks have not exceeded timeout
- barrier contracts accurately reflect child completion state
- artifact references remain resolvable
- awaiting parents are re-triggered when conditions are satisfied
- failed retries are marked terminal when limits are reached
- memory promotion requests are not stuck in intermediate states
- dead-letter records are visible for operator inspection

---

# 8. Memory Lifecycle

## 8.1 Memory Layers

v1 memory is a layered subsystem, not a single store.

The layers are:
- durable ground truth in Postgres and object storage
- lexical recall for exact matches, transcripts, and identifiers
- semantic recall for concept-level matching
- consolidation jobs that extract durable semantic and procedural memory
- per-run working memory assembled by the context builder

## 8.2 Retrieval Precedence

Context assembly must query memory in this order:

1. task-linked artifacts and prior run outputs
2. project-scoped memory
3. business-scoped memory
4. agent-scoped memory
5. curated `global_patterns`

Global patterns are a late-stage assist, not the primary source of truth.

## 8.3 Consolidation and Promotion

After terminal task events, Trigger jobs may:
- summarize run outcomes into episodic memory
- extract facts and relationships into semantic memory
- extract reusable SOPs and heuristics into procedural memory
- propose promotion candidates for `global_patterns`

Promotion rules:
- promotion must strip or abstract business-specific details
- promotion must preserve provenance to the source memories or source tasks
- promotion must be reviewed by a curator flow before becoming globally visible
- rejected promotions remain local or are discarded according to policy

## 8.4 What v1 Memory Is Not

v1 memory is not:
- hidden persistent chat memory
- the sole system of record for task or business truth
- unrestricted cross-business recall
- an actor-native long-lived memory runtime

---

# 9. Execution Environment

## 9.1 Workspace Model

v1 defaults to a logical per-run workspace model rather than a mandatory filesystem workspace for all agents.

Workspace rules:
- each run may allocate an isolated execution directory if needed
- directories must be namespaced by business, project, task, and run
- workspaces may be ephemeral or persisted based on artifact policy
- agents that do not require local file operations should run without workspace allocation

## 9.2 Lifecycle Hooks

Optional hooks may include:
- `after_event_ingest`
- `before_context_build`
- `before_run`
- `after_run`
- `before_retry`
- `after_artifact_persist`
- `after_memory_persist`
- `before_task_complete`

Hooks must be deterministic and observable. Hook failures must not silently mutate execution state.

## 9.3 Safety Constraints

The system must enforce:
- path validation for filesystem operations
- tool allowlists per agent
- maximum tool call counts per run
- payload size limits for context and outputs
- restricted external network access where appropriate
- model and provider allowlists
- schema validation before state mutation
- prevention of direct inline agent-to-agent execution outside the event pipeline

---

# 10. Agent Integration Protocol

## 10.1 Session Startup

Every agent session is a fresh single-shot invocation. Startup includes:
- resolve agent definition and version
- resolve current task and run metadata
- assemble context bundle from durable state and memory retrieval
- render prompt with objective, constraints, and available tools
- pass execution settings including provider, model, reasoning effort, and run limits

No persistent thread state is carried between sessions. Re-entry is always a new invocation built from stored system state.

## 10.2 Communication Contract

The minimum runtime-to-agent contract includes:
- invocation metadata
- rendered prompt
- tool registry
- output schema or completion schema
- timeout and token budget constraints
- explicit reminder that the agent is operating in single-shot mode

Agent results must return structured output including:
- summary
- next task state
- optional artifacts
- optional child task emissions
- optional structured result payload
- optional failure reasons

## 10.3 Tool and Approval Behaviour

Tools are exposed to agents as callable capabilities. A sub-agent is represented as a tool that emits a new task request rather than directly invoking another model session.

Tool rules:
- agents may only access tools explicitly declared in their definition
- unsupported tool names must hard fail validation
- tool outputs must be structured and validated
- sub-agent tools must return task creation metadata immediately
- approval behavior is non-interactive in v1; tasks requiring review must transition to a review state and await an external event

---

# 11. External Integrations

## 11.1 Required Operations

External integrations must support:
- provider model invocation
- lexical and semantic memory retrieval
- artifact storage and retrieval
- business and project metadata retrieval
- task event emission
- metrics and tracing emission

## 11.2 Data Normalization

External data must be normalized into internal models before use in prompts or state transitions. This includes:
- canonical ID mapping
- UTC timestamp normalization
- structured extraction of external results
- transformation of provider-specific outputs into platform-standard contracts
- deduplication of memory fragments and artifacts

## 11.3 Error Handling

Expected error categories include:
- provider authentication failure
- rate limiting
- malformed external response
- unavailable service
- partial result retrieval
- timeout
- incompatible schema version

Each category must map to retryable or terminal handling rules.

---

# 12. Observability

## 12.1 Logging

Required log fields:
- `event_id`
- `event_type`
- `task_id`
- `run_id`
- `agent_id`
- `business_id`
- `project_id`
- `parent_task_id`
- `root_task_id`
- `state_before`
- `state_after`
- `run_status`
- `tool_name`
- `provider`
- `model`
- `latency_ms`
- `retry_attempt`
- `artifact_count`
- `memory_result_count`
- `memory_scope_order`
- `promotion_request_id`
- `error_code`

## 12.2 Metrics

The system should track:
- event ingestion rate
- task throughput
- run success rate
- retry rate
- failure rate by class
- average prompt size
- average token usage
- fan-out size by supervisor
- barrier wait duration
- average re-entry count per task
- artifact generation counts
- provider latency
- cost per task and per business
- memory hit rate by scope and class
- promotion acceptance rate
- duplicate event rejection count

## 12.3 Status Surface

Operator surfaces may include:
- admin dashboard
- task execution timeline view
- run detail pages
- delegation graph visualization
- barrier status view
- dead-letter explorer
- queue depth dashboard
- memory promotion review queue
- health endpoints
- metrics endpoints
- audit export APIs

---

# 13. Failure Model

## 13.1 Failure Classes

Failure classes include:
- configuration errors
- identifier resolution errors
- illegal transition errors
- prompt construction errors
- provider execution failures
- tool execution failures
- external integration failures
- artifact persistence failures
- schema validation failures
- orchestration reconciliation failures
- timeout failures
- partial child completion failures
- forbidden memory scope access failures
- promotion redaction failures

## 13.2 Recovery Strategy

Recovery must use:
- bounded retries for transient failures
- explicit terminal failure marking for non-retryable failures
- reconciliation jobs for stale states
- barrier expiry handling
- dead-letter storage for irrecoverable events
- re-dispatch logic for recoverable queued work
- operator intervention through explicit override events where necessary
- curator review flows for global pattern promotion

---

# 14. Security Model

## 14.1 Trust Boundaries

Trusted components:
- orchestration engine
- validator
- context builder
- internal state store
- artifact metadata store
- memory service after normalization
- secret manager

Untrusted or semi-trusted components:
- model outputs
- external APIs
- user-supplied task payloads
- third-party tool responses
- retrieved memory fragments until validated and scoped

## 14.2 Secret Handling

Secrets must:
- be resolved at runtime from a secret manager
- never be embedded in prompts
- never be stored in logs
- be scoped per business, provider, or integration where applicable
- be rotated independently of agent definitions

## 14.3 Hardening Guidance

Recommended safeguards:
- enforce least-privilege tool access
- isolate business data by tenant boundaries
- restrict network access for sensitive agents
- use signed internal events where appropriate
- validate all structured outputs before persistence
- maintain immutable audit logs for event lineage
- enforce schema versioning on agent definitions, memory contracts, and tool contracts
- redact promoted memory before it reaches `global_patterns`

---

# 15. Reference Algorithms

## 15.1 Event Dispatch

```typescript
on_webhook(webhook_envelope):
    ingress = validate_webhook_envelope(webhook_envelope)

    if is_duplicate_ingress(ingress.idempotency_key):
        return existing_result_reference()

    event = normalise_ingress_to_event(ingress)
    persist_event(event)

    task = resolve_or_create_task(event)
    agent = resolve_agent(event.agent_id or task.requested_agent_id)

    if not transition_is_legal(task.state_id, event):
        dead_letter(event, "illegal_transition")
        return

    run = create_run(task, agent, event)
    context_bundle = build_context_bundle(task, run, event, agent)
    prompt = render_prompt(agent, context_bundle)

    result = execute_agent_once_via_trigger(agent, run, prompt)

    validated_result = validate_agent_result(result, run, task)
    persist_run_result(run, validated_result)
    persist_artifacts(validated_result.artifacts)
    persist_memory_writes(validated_result, task, run)

    update_task_state(task, validated_result.state_id)
    emit_follow_up_events(task, run, validated_result)
```

## 15.2 Supervisor Fan-Out with Barrier Re-entry

```typescript
on_supervisor_result(result):
    if result.spawn is empty:
        complete_task_if_terminal(result)
        return

    child_tasks = []
    for each spawn_item in result.spawn:
        child_task = create_child_task_from_spawn(spawn_item)
        emit_task_created_event(child_task)
        child_tasks.append(child_task.id)

    contract = create_delegation_contract(
        parent_task_id = result.task_id,
        parent_run_id = result.run_id,
        child_task_ids = child_tasks,
        mode = result.reentry_mode or "barrier",
        required_children = required_subset(child_tasks),
        optional_children = optional_subset(child_tasks),
        reentry_agent_id = result.agent_id,
        reentry_objective = result.reentry_objective
    )

    set_task_state(result.task_id, "awaiting_subtasks")
    persist_contract(contract)
```

## 15.3 Barrier Satisfaction

```typescript
on_child_task_completed(child_task_id):
    contract = find_active_delegation_for_child(child_task_id)
    if contract is null:
        return

    refresh_contract_status(contract)

    if barrier_conditions_satisfied(contract):
        mark_contract_satisfied(contract)
        parent_task = load_task(contract.parent_task_id)
        emit_reentry_event(
            task_id = parent_task.id,
            agent_id = contract.reentry_agent_id,
            objective = contract.reentry_objective
        )
```

## 15.4 Retry and Dead-Letter Handling

```typescript
on_run_failure(run, error):
    if not is_retryable(error):
        mark_run_failed(run)
        dead_letter(run.trigger_event_id, classify(error))
        mark_task_failed_if_terminal(run.task_id)
        return

    if run.attempt >= max_attempts(run):
        mark_run_failed(run)
        dead_letter(run.trigger_event_id, "retry_exhausted")
        mark_task_failed_if_terminal(run.task_id)
        return

    next_time = calculate_backoff(run.attempt)
    schedule_retry_event(run.task_id, run.agent_id, next_time)
    mark_run_retrying(run)
```

## 15.5 Context Memory Assembly

```typescript
build_context_bundle(task, run, event, agent):
    artifacts = load_relevant_artifacts(task, run)
    memory = []
    memory += query_memory(scope="project", task=task, agent=agent)
    memory += query_memory(scope="business", task=task, agent=agent)
    memory += query_memory(scope="agent", task=task, agent=agent)
    memory += query_memory(scope="global_patterns", task=task, agent=agent)

    return assemble_bundle(
        task = task,
        run = run,
        objective = event.payload.objective or task.message,
        related_artifacts = prioritize(artifacts),
        related_memory = trim_and_rank(memory),
    )
```

## 15.6 Pattern Promotion

```typescript
promote_memory_candidate(candidate):
    assert candidate.target_scope == "global_patterns"
    assert candidate.status == "pending_review"

    abstracted = redact_business_specific_details(candidate)
    if abstracted.redaction_failed:
        reject_promotion(candidate, "redaction_failed")
        return

    curated_record = create_global_pattern_memory(abstracted)
    persist_memory(curated_record)
    mark_promotion_completed(candidate, curated_record.memory_id)
```

---

# 16. Test and Validation Matrix

## 16.1 Core Conformance Tests

Required correctness tests:
- validate ingress schema enforcement and dedupe behavior
- validate agent definition resolution
- validate prompt rendering fails on missing required variables
- validate legal and illegal state transitions
- validate single-shot execution contract
- validate sub-agent tool call emits child task event rather than inline model execution
- validate artifact persistence and reference integrity
- validate barrier satisfaction logic
- validate run retry limits and terminal states
- validate root and parent lineage preservation
- validate memory retrieval precedence stays local before global
- validate forbidden cross-business memory reads are rejected

## 16.2 Integration Tests

Required integration tests:
- model provider invocation succeeds with expected configuration
- provider timeout and rate limit handling behave as configured
- lexical and semantic retrieval return normalized memory fragments
- artifact storage round-trip succeeds
- webhook ingress handles valid, invalid, and duplicate payloads
- external tool failures classify correctly as retryable or terminal
- promotion jobs preserve provenance and remove business-specific details

## 16.3 Operational Tests

Runtime validation scenarios:
- a single task succeeds without delegation
- a supervisor fans out to three child agents and re-enters once at barrier completion
- one optional child completes late without blocking parent progress
- one required child fails and parent remains awaiting policy resolution
- reconciliation recovers a stale `awaiting_subtasks` parent after a missed child event
- retry worker correctly re-dispatches transient provider failures
- queue backpressure prevents concurrency overrun
- malformed `AgentResult` is rejected and dead-lettered
- business-local memory is visible only inside the owning scope
- global pattern promotion strips business-specific details and preserves provenance

---

# 17. Implementation Readiness Phases

Build order for v1:

1. schema and validation layer
2. event, task, run, and artifact persistence
3. memory contracts and storage schema
4. context builder and invocation payload assembly
5. Trigger execution runtime
6. delegation, barrier coordination, and re-entry
7. consolidation and promotion jobs
8. retry, reconciliation, and dead-letter handling
9. minimal observability and operator surfaces

Definition of done for v1:
- webhook ingress implemented
- event schema validation and dedupe implemented
- task, run, artifact, and memory persistence implemented
- agent definition registry implemented
- context builder implemented
- Trigger-based single-shot execution runtime implemented
- tool registry with structured sub-agent spawn support implemented
- delegation contract handling implemented
- barrier coordination logic implemented
- retry logic implemented
- reconciliation workers implemented
- dead-letter storage and inspection implemented
- memory consolidation and curated promotion implemented
- observability stack implemented
- core conformance tests passing
- integration tests passing
- operational workflow tests passing
