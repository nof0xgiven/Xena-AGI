# North Star Task List

Updated: 2026-02-12

Status legend: `Planned` | `In Progress` | `Done` | `Blocked`

Architecture standard: best-in-class means thin workflows + registry/policy-driven matrices + shared matrix runtime + adapter-based tool execution.

## Completed Foundations
- [x] `NS-0001` Operator workflow delegates lifecycle via durable orchestration (`Done`)
- [x] `NS-0002` Registry loader/resolver and execution planning integrated (`Done`)
- [x] `NS-0003` Memory namespace policy + mem0 workflow integration (`Done`)
- [x] `NS-0004` Discovery matrix strategy switching + learned pattern persistence (`Done`)

## P0 Active Execution Backlog
- [x] `NS-0010` Universal Engine State Machine (`Done`)
  Deliverable: single reusable runtime loop implementing Understand/Prove/Plan/Confidence/Execute/Validate/Learn/Adapt.
  Acceptance proof:
  - `src/operator/kernel.ts` now emits `engineTransitions` for the full stage sequence with rationale.
  - `src/temporal/workflows/operatorWorkflow.ts` and `src/temporal/workflows/ticketWorkflowV2Core.ts` route stage changes through shared engine transition tracking.
  - `npm run typecheck` and `npm run build` passed on 2026-02-11.

- [x] `NS-0011` Confidence Gate Loopback (`Done`)
  Deliverable: if confidence is below threshold, workflow auto-loops to deeper discovery/proving before execution.
  Acceptance proof:
  - `src/temporal/workflows/operatorWorkflow.ts` now runs bounded confidence loopback attempts with discovery re-proving before any delegation.
  - Low-confidence runs fail closed after loopback exhaustion with explicit reason (`Confidence gate blocked execution...`) and trust-event metadata.
  - Runtime confidence proof executed on 2026-02-11: low-confidence coding intent (`0.571 < 0.600`) vs strengthened re-plan context (`0.864 >= 0.600`).

- [x] `NS-0012` Matrix Strategy for Plan Stage (`Done`)
  Deliverable: adaptive strategy family switching for planning (like discovery matrix).
  Acceptance: failed primary planner attempts switch to alternate strategy family and still return deterministic plan output.
  Acceptance proof:
  - `src/temporal/workflows/planWorkflow.ts` now includes planning strategy matrix, bounded recursive strategy, quality gate scoring, and replay-safe patch markers (`plan-strategy-matrix-v1`, `plan-recursive-strategy-v1`, `plan-strategy-matrix-learning-v1`).
  - `src/temporal/activities/registryLearningActivities.ts` now persists learned planning patterns via `registryUpsertLearnedPlanningPattern(...)`.
  - Recursive planning prompts added: `docs/planner.recursive.decompose.md`, `docs/planner.recursive.subplan.md`, `docs/planner.recursive.synthesize.md`.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0013` Matrix Strategy for Code Stage (`Done`)
  Deliverable: adaptive strategy family switching during implementation stage.
  Acceptance: repeated failures trigger controlled strategy family switch with bounded attempts and recovery logs.
  Acceptance proof:
  - `src/temporal/workflows/codeWorkflow.ts` now includes coding strategy matrix selection, error classification, enough-is-enough family switching, and replay-safe patch markers (`code-strategy-matrix-v1`, `code-strategy-matrix-learning-v1`).
  - Code strategies are bounded (`MAX_CODE_ATTEMPTS_TOTAL=3`) and include change-proof enforcement (`git status --porcelain`) with explicit `no_changes` classification.
  - `src/temporal/activities/registryLearningActivities.ts` now persists learned coding patterns via `registryUpsertLearnedCodingPattern(...)`.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0014` Matrix Strategy for Review Stage (`Done`)
  Deliverable: adaptive strategy family switching in review/revision loop with bounded retries and failure classification.
  Acceptance: review loop can recover from tool/model failures without manual intervention and emits strategy-switch telemetry.
  Acceptance proof:
  - `src/temporal/workflows/codeWorkflow.ts` review loop now uses bounded matrix switching (`review-strategy-matrix-v1`) with classified error kinds and enough-is-enough family switching.
  - Review and revision execution are adapterized by policy tool IDs (`REVIEW_TOOL_ADAPTERS`, `REVISION_TOOL_ADAPTERS`) with tool-tagged failure propagation.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0017` Shared Matrix Runtime Extraction (`Done`)
  Deliverable: shared matrix runtime module used by discover/plan/code/review for selection, switching, and attempt gating.
  Acceptance: per-stage workflows delegate matrix decisions to shared runtime and remove duplicated matrix logic blocks.
  Acceptance proof:
  - Shared runtime module is live at `src/temporal/workflows/matrixRuntime.ts` with reusable selection and failure formatting helpers.
  - Discover, plan, code, and review selectors now delegate to shared runtime helper `selectNextStrategy(...)` in:
    - `src/temporal/workflows/discoverWorkflow.ts`
    - `src/temporal/workflows/planWorkflow.ts`
    - `src/temporal/workflows/codeWorkflow.ts`
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.
  - Runtime proof: family-switch fallback ordering exercised via `selectNextStrategy(...)` returned distinct normal vs switch-family fallback picks.

- [x] `NS-0018` Registry-Driven Matrix Policy + Tool Adapters (`Done`)
  Deliverable: matrix policy and stage strategy definitions moved from workflow code into registry/config with adapter execution by `toolId`.
  Acceptance: adding/reordering strategies for a stage requires config changes only (no workflow code edits).
  Acceptance proof:
  - Stage matrix policy now covers discover/plan/code/review in `src/config/matrix-policies.ts` with strict parsing in `src/temporal/workflows/matrixPolicyConfig.ts`.
  - Workflows route execution by `toolId` adapters instead of strategy-id switches in:
    - `src/temporal/workflows/discoverWorkflow.ts`
    - `src/temporal/workflows/planWorkflow.ts`
    - `src/temporal/workflows/codeWorkflow.ts`
  - Registry now contains all policy tool IDs (discover/plan/code/review) in `config/registry/tools.json`.
  - Runtime proof on 2026-02-11:
    - policy load includes all four stages,
    - policy tool ID check returned `missing: []`,
    - family-switch path selection verified via `selectNextStrategy(...)`.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0015` Learned Workflow Auto-Selection in Resolver (`Done`)
  Deliverable: resolver can pick learned workflows from `learned-workflows.json` based on context + error signatures.
  Acceptance: at least one real run uses learned workflow selection without hardcoded fallback branch.
  Acceptance proof:
  - `src/operator/kernel.ts` now extracts and forwards deterministic `contextSignals` and `errorSignatures` into resolution requests.
  - `src/registry/resolver.ts` now computes learned activation score from context/error overlap and uses deterministic ranking (`RESOLVER_VERSION=1.3.0`) so learned agents are selected only when activated.
  - Runtime proof on 2026-02-11:
    - no signatures -> selected `agent.coding.primary`
    - `error_kind: unknown` with matching learned metadata -> selected `agent.coding.discovery.matrix`
    - mismatched signature (`timeout`) -> selected `agent.coding.primary`
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0016` Learned Pattern Quality Scoring (`Done`)
  Deliverable: score learned patterns by success rate, recency, and confidence lift.
  Acceptance: low-quality learned patterns are down-ranked or disabled automatically.
  Acceptance proof:
  - `src/temporal/activities/registryLearningActivities.ts` now computes per-pattern quality metadata on every learned upsert:
    - `successRate`, `recencyScore`, `avgConfidenceLift`, `avgQualitySignal`, `qualityScore`
  - `src/registry/resolver.ts` now consumes learned `qualityScore` in deterministic tie-breaking for activated learned candidates.
  - Runtime proof on 2026-02-11 (isolated registry copy):
    - low-quality planning learned pattern (`qualityScore=30`) was auto-disabled with `promotionState=disabled` and `enabled=false`.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0019` Learned Pattern Promotion Gate (`Done`)
  Deliverable: promotion policy requiring repeated successful proofs before learned patterns affect resolver selection.
  Acceptance: learned strategies remain observational until promotion thresholds are met and logged.
  Acceptance proof:
  - `src/temporal/activities/registryLearningActivities.ts` now applies promotion policy with deterministic states:
    - `observational` -> `promoted` -> `disabled`
    - metadata fields: `promoted`, `promotionState`, `promotedAt`, `promotionReason`
  - `src/registry/resolver.ts` now blocks learned activation unless `promoted=true`.
  - Runtime proof on 2026-02-11 (isolated registry copy):
    - after first learned discovery success: `promotionState=observational`, `promoted=false`, resolver selected `agent.coding.primary`
    - after second learned discovery success: `promotionState=promoted`, `promoted=true`, resolver selected `agent.coding.discovery.matrix`
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

## P0 Orchestrator Simplicity Backlog
- [ ] `NS-0043` Orchestrator-Only Task Contract (`Planned`)
  Deliverable: central contract that Xena never executes directly; all actions are delegated through durable Temporal workflows.
  Acceptance:
  - inbound command handling always resolves to a workflow action (`start|stop|restart|status`) with matrix guardrails.
  - no direct-action bypass path exists in communication handlers.

- [x] `NS-0044` Tool Registry Surface as First-Class Operator API (`Done`)
  Deliverable: explicit operator tool surface (email/code/review/discovery/research/tasks) mapped to registry capabilities and adapter handlers.
  Acceptance proof:
  - `src/registry/schema.ts` now enforces first-class tool surface contract (`surface.domains`, `surface.entities`, `surface.operations`, `surface.taskRoles`, `surface.authority`, `surface.freshnessSlaSec`).
  - `config/registry/tools.json` now declares tool surface metadata for every tool and splits task sources into explicit probe tools:
    - `tool.tasks.temporal.running`
    - `tool.tasks.linear.assigned`
    - `tool.tasks.email.followups`
    - `tool.tasks.memory.followups`
  - `src/temporal/activities/operatorStatusActivities.ts` now resolves enabled `tasks.probe` sources from registry and probes via `toolId -> adapter` mapping (not hardcoded Temporal+Linear-only logic).
  - `src/temporal/workflows/agentmailWorkflow.ts` now passes `projectKey` into task snapshots so memory-backed follow-up probes run with correct scope.
  - `config/registry/skills.json` operator status skill now uses `tasks.probe` as required capability and prefers explicit probe tools.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [ ] `NS-0045` Skill Playbook Routing (`Planned`)
  Deliverable: skill playbooks that encode how to use tool combinations per objective (`design-review`, `code-discovery`, `status-snapshot`, etc.).
  Acceptance:
  - matrix execution records selected skill id alongside strategy id.
  - at least one communication intent and one coding intent execute with an explicit playbook id recorded in memory.

- [x] `NS-0046` Personality-Driven Teammate Voice (`Done`)
  Deliverable: use `docs/personality.md` as runtime prompt personality source for teammate/email replies.
  Acceptance proof:
  - prompt activities now load and apply `docs/personality.md` (with fallback profile) in `src/temporal/activities/openaiActivities.ts`.
  - communication + teammate replies now enforce lead-with-answer, natural human phrasing, and no canned filler.
  - validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0047` Manus Web Research Tool Integration (`Done`)
  Deliverable: add Manus as first-class research tool for live web research, navigation, and presentation-capable artifact output.
  Acceptance proof:
  - Added Manus API client in `src/manus.ts` (`createTask`, `getTask`, `cancelTask`).
  - `researchRun` now executes through Manus with polling + timeout controls and run artifact persistence in `src/temporal/activities/researchActivities.ts`.
  - Registry updated with Manus-first research surface:
    - `tool.manus.research` in `config/registry/tools.json`
    - `resource.manus.default` in `config/registry/resources.json`
    - research skill/agent now prefer Manus (`config/registry/skills.json`, `config/registry/agents.json`)
  - Worker env and examples updated for Manus config (`src/env.ts`, `.env.example`).
  - validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0048` Async Manus Completion via Temporal Webhook Signals (`Done`)
  Deliverable: long Manus research runs are started durably, then finalized only after webhook-driven Temporal signal wake-up.
  Acceptance proof:
  - Added Manus signal contract + payload typing:
    - `src/temporal/signals.ts` (`SIGNAL_MANUS_EVENT`)
    - `src/temporal/shared.ts` (`ManusEventSignal`)
  - Added webhook ingress path and routing:
    - `src/server/index.ts` (`GET/POST /webhooks/manus`)
    - Manus signature verification (`X-Webhook-Signature`, `X-Webhook-Timestamp`) with public-key validation
      (`src/manusWebhookVerify.ts`, `MANUS_WEBHOOK_REQUIRE_SIGNATURE`, optional `MANUS_WEBHOOK_PUBLIC_KEY`)
    - optional legacy query-token validation through `MANUS_WEBHOOK_TOKEN`
    - explicit query-parameter routing (`workflowType`, `workflowId`, `projectKey`) for signal dispatch
    - route dispatch is registry-driven through `tool.manus.webhook.signal.metadata.workflowRoutes`
      in `config/registry/tools.json` (no hardcoded webhook->workflow coupling)
  - Added async research activity split:
    - `researchStart(...)`
    - `researchFinalizeTask(...)`
    - retained `researchRun(...)` for synchronous paths
    in `src/temporal/activities/researchActivities.ts`
  - AgentMail workflow now uses replay-safe async research mode (`agentmail-manus-webhook-research-v1`):
    - starts Manus tasks with webhook correlation
    - stores pending task context by `taskId`
    - handles `task_created`/`task_progress`/`task_stopped`
    - sends teammate follow-up only on webhook completion or `ask` clarification
    in `src/temporal/workflows/agentmailWorkflow.ts`
  - validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

## P1 Personal Operator Backlog
- [x] `NS-0020` Personal Preference Memory Model (`Done`)
  Deliverable: dedicated profile schema for your defaults (tone, risk appetite, update frequency, tool preferences).
  Acceptance proof:
  - Preference schema + utilities now live in `src/memory/userPreferences.ts` with fields for:
    - `tone`, `replyVerbosity`, `updateCadence`, `maxRiskLevel`
    - `preferred/blocked` agent/tool/resource IDs
  - Preferences are loaded from mem0 namespace `user.preferences` via new activity `mem0GetUserPreferences(...)` in `src/temporal/activities/mem0Activities.ts`.
  - Operator planning now applies preference profile in `src/temporal/workflows/operatorWorkflow.ts`:
    - `maxRiskLevel`
    - `preferred/blocked` agent/tool/resource IDs
  - Resolver request/selection now supports tool/resource preferences (`src/registry/schema.ts`, `src/operator/kernel.ts`, `src/registry/resolver.ts`, `RESOLVER_VERSION=1.3.0`).
  - Teammate reply generation now includes preference directives and profile context (`src/temporal/activities/openaiActivities.ts`) and all stage workflows now pass profile context + cadence-gate posts:
    - `src/temporal/workflows/discoverWorkflow.ts`
    - `src/temporal/workflows/planWorkflow.ts`
    - `src/temporal/workflows/codeWorkflow.ts`
    - `src/temporal/workflows/ticketWorkflowV2Core.ts`
  - New command surface for profile management in ticket workflow:
    - `xena prefs show`
    - `xena prefs set {json}`
    - `xena prefs reset`
  - Runtime proof on 2026-02-11:
    - preference round-trip parse/serialize succeeded (`ROUND_TRIP_OK true`)
    - low cadence suppressed routine update (`discover_start=false`) while allowing critical/command updates (`blocked_notice=true`, `command_status=true`)
    - resolver selected learned coding agent by default, switched to primary when learned tool was blocked (`blockedToolIds`)
    - risk cap preference `maxRiskLevel=medium` blocked coding plan resolution as expected.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0021` Decision Signature Memory (`Done`)
  Deliverable: capture repeated decision tendencies and apply them during planning.
  Acceptance proof:
  - Added decision-signature aggregation API in `src/temporal/activities/mem0Activities.ts`:
    - `mem0GetDecisionSignatures(...)` groups repeated decision patterns by domain/strategy/error signatures with occurrence + recency + avg quality.
  - Planning now consumes decision signatures in both planner prompt context and operator execution planning:
    - `src/temporal/workflows/planWorkflow.ts` appends `Decision signatures (mem0)` to task description.
    - `src/temporal/workflows/operatorWorkflow.ts` appends decision signatures into planning comment context before resolver build.
  - Runtime proof on 2026-02-11:
    - aggregated signature count: `1`
    - top strategy: `codex-recursive`
    - occurrences aggregated: `2`
    - avg quality aggregated: `80.0`
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0024` Mem0 Metadata Contract + Scoped Memory Writes (`Done`)
  Deliverable: all core memory writes include structured metadata and support richer scoped retrieval.
  Acceptance proof:
  - Core mem0 client now supports:
    - scoped identifiers (`agent_id`, `app_id`, `run_id`)
    - metadata filters on search
    - search score propagation for ranking
    - optional graph extraction toggle (`enable_graph`)
    in `src/mem0.ts`.
  - Activity layer now enforces normalized metadata envelope on writes (`type`, `intent`, `stage`, `outcome`, `source`, `confidence`, `qualityScore`, `tags`, `recordedAt`) in `src/temporal/activities/mem0Activities.ts`.
  - Workflow write callsites now annotate core records (discover/plan/code/review/research/qa/preferences/pr/sandbox), including:
    - `src/temporal/workflows/discoverWorkflow.ts`
    - `src/temporal/workflows/planWorkflow.ts`
    - `src/temporal/workflows/codeWorkflow.ts`
    - `src/temporal/workflows/ticketWorkflowV2Core.ts`
    - `src/temporal/workflows/operatorWorkflow.ts`
    - `src/temporal/workflows/ticketWorkflow.ts`
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0025` Graph Memory Lane + Hybrid Retrieval (`Done`)
  Deliverable: relationship-aware memory lane for decision/preference/quality reasoning with hybrid vector+graph retrieval.
  Acceptance proof:
  - Added hybrid retrieval API in `src/temporal/activities/mem0Activities.ts`:
    - `mem0SearchHybridContext(...)` combines `ticket.context`, `code.decisions`, `quality.signals`, `research.findings`, and `user.preferences` lanes with relation-query heuristics and bounded selection.
  - Added graph-ready lane controls in mem0 client/activity layer:
    - optional `enable_graph` payload in `src/mem0.ts`
    - environment toggle `MEM0_ENABLE_GRAPH` in `src/env.ts` and `.env.example`
    - selective graph-enabled defaults for relationship-heavy namespaces in `src/temporal/activities/mem0Activities.ts`.
  - Planning now uses hybrid memory context in `src/temporal/workflows/planWorkflow.ts`.
  - Runtime proof on 2026-02-11:
    - hybrid lanes returned: `ticket_context:1, decision_history:2, quality_history:1, user_preferences:1`
    - relation-centric context includes decision history and user preferences sections.
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [x] `NS-0026` Memory Distillation + Retention Policy (`Done`)
  Deliverable: periodic memory compaction and stale-memory controls to keep retrieval high signal over time.
  Acceptance proof:
  - Retention policy is implemented and executed in `src/temporal/activities/mem0Activities.ts`:
    - `mem0ApplyRetentionPolicy(...)` performs namespace-specific stale/overflow selection.
    - supports `archive_then_delete` and `delete_only` actions.
    - writes run summaries to `workflow.state` with structured metadata.
  - Mem0 client now supports list/delete primitives required for retention execution in `src/mem0.ts`:
    - `mem0ListEntries(...)`
    - `mem0Delete(...)`
  - Namespace retention rules are centralized in `src/memory/policy.ts`:
    - `MEMORY_RETENTION_RULES`
    - `getMemoryRetentionRule(...)`
  - Scheduled periodic maintenance is live via dedicated Temporal workflow:
    - `src/temporal/workflows/memoryMaintenanceWorkflow.ts`
    - exported through `src/temporal/workflows/index.ts`
    - ensured from server bootstrap in `src/server/index.ts`
  - New runtime controls:
    - `XENA_MEMORY_MAINTENANCE_INTERVAL_MINUTES`
    - `XENA_MEMORY_RETENTION_DRY_RUN`
    in `.env.example`, `src/env.ts`, and `README.md`.
  - Runtime proof on 2026-02-11 (real mem0, dry run):
    - `DISTILL_RECORDED true`
    - retention scan coverage: `RETENTION_SCANNED 38`
    - namespace coverage: `ticket.context:28`, `code.decisions:2`, `quality.signals:2`, `research.findings:6`
    - `RETENTION_ERRORS 0`
  - Validation passed on 2026-02-11: `npm run typecheck`, `npm run build`.

- [ ] `NS-0022` Proactive Daily Brief Workflow (`Planned`)
  Deliverable: scheduled summary of open priorities, blockers, and recommended actions.
  Acceptance: daily brief is generated autonomously with real issue/workflow context.

- [ ] `NS-0023` Follow-Up and Reminder Loop (`Planned`)
  Deliverable: automatic follow-up on blocked/stale tasks after configurable thresholds.
  Acceptance: stale tasks get proactive nudges with explicit next action proposals.

## P1 Channel Expansion Backlog
- [ ] `NS-0030` Slack Communication Tools (`Planned`)
  Deliverable: tool definitions + activities + guardrails for Slack updates/threads.
  Acceptance: Xena can post/update Slack messages from workflow events.

- [ ] `NS-0031` Email Communication Tools (`In Progress`)
  Deliverable: tool definitions + activities for sending concise status and decision summaries.
  Progress:
  - AgentMail transport layer expanded in `src/agentmail.ts`:
    - inbox lifecycle (`list/create`)
    - message send
    - message fetch
    - attachment metadata fetch
    - attachment download URL support
  - Temporal activities added in `src/temporal/activities/agentmailActivities.ts`:
    - `agentmailEnsureInbox(...)`
    - `agentmailSendMessageFromXena(...)`
    - `agentmailHydrateInboundMessage(...)`
    - `agentmailBuildTextAttachment(...)`
  - Dedicated independent email workflow + webhook path implemented:
    - `src/temporal/workflows/agentmailWorkflow.ts`
    - `src/server/index.ts` (`POST /webhooks/agentmail`)
  - Matrix-first communication strategy is now live for AgentMail:
    - communication stage policies in `src/config/matrix-policies.ts`
    - policy parsing/types in `src/temporal/workflows/matrixPolicyConfig.ts`
    - matrix runtime selection/switching in `agentmailWorkflow` (`semantic` -> `attachment-aware`) with no canned fallback replies
    - matrix decision and quality writes persisted to memory (`workflow.state`, `code.decisions`)
    - task/status requests now use live snapshot activity (`operatorGetTaskSnapshot`) across Temporal + Linear before reply composition
  - Webhook normalization now supports nested AgentMail event payloads (`message.received` with `message` object) and attachment metadata propagation into Temporal signals.
  - Manus async follow-up path is now webhook-driven:
    - `POST /webhooks/manus` wakes workflow via `SIGNAL_MANUS_EVENT`
    - workflow starts Manus task, waits durably, then finalizes and replies on completion
    - `task_stopped` with `stop_reason=ask` triggers explicit clarification follow-up
    - optional `MANUS_WEBHOOK_TOKEN` guard supported
  - Outbound teammate replies can now include generated attachments (for example research summaries and attachment notes).
  - Identity trust guard implemented with strict safe sender list:
    - `src/identity/safeSenders.ts`
    - default allowlist: configured via `XENA_SAFE_SENDER_EMAILS` env var
    - non-allowlisted senders are ignored before execution (`agentmail_sender_ignored`).
  Remaining:
  - calendar/meeting execution tooling (currently clarification-first; no calendar API action path yet).
  - end-to-end live proof for inbound email -> Manus async completion webhook -> final follow-up email in real inbox traffic.
  Acceptance:
  - workflow emits structured email summaries with source links and optional attachment artifacts.
  - matrix path and failure reasons are captured in memory for replayable learning.

- [ ] `NS-0032` WhatsApp Integration Design + MVP (`Planned`)
  Deliverable: secure integration pattern and MVP send/receive workflow.
  Acceptance: Xena can receive command and send update through WhatsApp channel path.

- [ ] `NS-0033` Voice Interaction Capability Spike (`Planned`)
  Deliverable: evaluate and integrate a voice layer as optional channel.
  Acceptance: basic voice command path can trigger operator intent safely.

- [ ] `NS-0052` Communication Matrix Channel Expansion (`Planned`)
  Deliverable: add non-email strategy definitions (Slack, WhatsApp, Voice) to the communication stage matrix policy in `src/config/matrix-policies.ts` so the operating loop can select non-email channels.
  Acceptance:
  - communication stage in `MATRIX_POLICIES` includes at least Slack strategy entries alongside email strategies.
  - resolver can select a Slack communication path when Slack tools are registered and enabled.
  - matrix switching between email and Slack families works through shared `selectNextStrategy(...)` runtime.
  Dependencies: `NS-0030` (Slack Communication Tools), `NS-0032` (WhatsApp MVP), `NS-0033` (Voice Spike).
  Context: code review P2 finding — the communication stage only exposes email strategies, leaving core north-star channel requirements unimplemented in the active strategy framework.

- [ ] `NS-0049` Google Calendar API Tool Registry + Skill (`Planned`)
  Deliverable: add first-class Google Calendar event CRUD tooling and a matching skill so meeting requests execute through real Calendar API actions (not clarification-only).
  Scope:
  - register explicit tool definitions in `config/registry/tools.json` for Calendar API v3 event operations:
    - `events.list` (`GET /calendar/v3/calendars/{calendarId}/events`)
    - `events.get` (`GET /calendar/v3/calendars/{calendarId}/events/{eventId}`)
    - `events.insert` (`POST /calendar/v3/calendars/{calendarId}/events`)
    - `events.patch` (`PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}`)
    - `events.delete` (`DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}`)
  - add a calendar skill in `config/registry/skills.json` that routes meeting intents through the above tool IDs with deterministic operation selection.
  - implement adapter/runtime wiring for delegated OAuth 2.0 credentials with refresh-token support and explicit calendar scope handling.
  - enforce event payload validity for start/end values (`dateTime` RFC3339 or all-day `date`) and explicit timezone handling where required.
  Acceptance:
  - one real end-to-end proof run performs CRUD against a live Google Calendar: create -> get -> patch -> list (time window) -> delete.
  - scope configuration is least-privilege by default for event CRUD (`https://www.googleapis.com/auth/calendar.events`) and documented if broader scope is required.
  - production error paths are handled and logged with deterministic behavior for:
    - invalid credentials (`401 authError`)
    - resource not found (`404 notFound`)
    - invalid request parameters (`400`, e.g. `timeRangeEmpty`)
    - user/quota rate limits (`403/429` rate-limit reasons) with retry/backoff policy
  - outbound confirmation/state memory includes `calendarId`, `eventId`, `htmlLink`, attendees, and normalized start/end timezone data.
  Source baseline: Context7 `/websites/developers_google_workspace_calendar_api` (events reference, auth scopes, error handling guides).

- [ ] `NS-0050` Manus Async E2E Proof Run (`Planned`)
  Deliverable: execute a full real-flow proof (`email -> Manus start -> webhook stop -> follow-up email with attachment`) and capture artifact evidence in `runs/` + task docs.
  Acceptance:
  - one completed run with real webhook callback and final teammate reply.
  - one `stop_reason=ask` run with clarification follow-up behavior.

- [ ] `NS-0051` Research Provider Router (Coding vs General) (`Planned`)
  Deliverable: enforce deterministic provider routing so coding-task research uses ExaCode/Context7 adapters (only when needed) and Manus remains general/product/lifestyle research only.
  Acceptance:
  - Linear coding workflows never select Manus research path.
  - General research intents select Manus by default.
  - routing decision + provider id persisted in memory decision records.

## P2 Reliability and Observability Backlog
- [ ] `NS-0040` Operator Metrics Surface (`Planned`)
  Deliverable: confidence, trust, strategy-switch, and learned-pattern metrics.
  Acceptance: operator status includes actionable quality signals per workflow.

- [ ] `NS-0041` Failure Matrix Expansion (`Planned`)
  Deliverable: richer error taxonomy and strategy matrix tuning from real incidents.
  Acceptance: classification coverage increases and unknown/error bucket shrinks over time.

- [ ] `NS-0042` Self-Healing Playbook Registry (`Planned`)
  Deliverable: reusable remediation playbooks generated from repeated failures.
  Acceptance: repeated failures trigger known playbook before escalating.

## Suggested Immediate Next 3
- [ ] `NS-0040` Operator Metrics Surface
- [ ] `NS-0030` Slack Communication Tools
- [ ] `NS-0031` Email Communication Tools
