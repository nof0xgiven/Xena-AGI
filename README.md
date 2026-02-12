# Xena 2p0 (Personal Operator Orchestrator)

Xena is a personal operator.

Current focus is durable coding/research execution with adaptive strategy switching and learning.

## North-Star Alignment

North-star source: `north-star.md`

- Method is constant: Xena runs the durable operator engine flow (`Understand -> Prove -> Plan -> Confidence Gate -> Execute -> Validate -> Learn -> Adapt`).
- Everything else is modular: tools/resources/skills/agents are registry-driven and swappable.
- Repeated successful patterns are persisted as learned workflows, then promoted toward reusable agents.
- Scope is personal-first: built for one operator (you), with proactive follow-up and cross-channel communication as roadmap priorities.

Xena is webhook-driven and durable:
- Linear drives assignment and teammate interactions.
- GitHub PR events drive sandbox lifecycle.
- Temporal stores task state for long-running tickets.

Primary flow:
`discover -> plan -> worktree -> code -> review loop -> PR -> sandbox (frontend) -> smoke -> handoff`

Current adaptive matrix coverage:
- Discovery stage: live
- Plan stage: live
- Code implementation stage: live
- Review stage: live
- Communication (AgentMail) stage: live

## Tool Registry Contract

Registry source: `config/registry/*.json`
Implementation guide (how to add tools): `docs/tool-registry.md`
Copy-paste tool templates: `docs/tool-templates.md`
Skill playbook guide: `docs/skills-playbooks.md`

Tool definitions are strict and first-class. Each tool must declare:
- `surface.domains`: functional lanes (`coding`, `research`, `communication`, `tasks`, etc.)
- `surface.entities`: what it can act on/read (`linear.issue`, `temporal.workflow`, `email.message`, etc.)
- `surface.operations`: allowed operation verbs (`probe`, `list`, `read`, `execute`, ...)
- `surface.taskRoles`: whether the tool is a task `source`, `controller`, or `observer`
- `surface.authority`: trust score (0-1) for ranking probe sources
- `surface.freshnessSlaSec`: expected freshness target for that source

Task snapshot behavior is registry-driven:
- Xena discovers enabled task sources by capability (`tasks.probe`) + role (`surface.taskRoles` includes `source`).
- Probes run through explicit `toolId -> adapter` handlers.
- Current live task probe tools:
  - `tool.tasks.temporal.running`
  - `tool.tasks.linear.assigned`
  - `tool.tasks.email.followups`
  - `tool.tasks.memory.followups`

## Architecture

- `src/ingress/index.ts`
  - Public local ingress (`XENA_INGRESS_PORT`, default `9876`).
  - ngrok should point here.
- `src/server/index.ts`
  - Internal webhook server (`XENA_HTTP_PORT`, default `3001`).
  - Linear webhook verification.
  - GitHub PR webhook ingestion and routing into Temporal signals.
- `src/temporal/worker.ts`
  - Runs workflows and activities.
- `src/temporal/workflows/operatorWorkflow.ts`
  - Main durable operator orchestrator.
  - Teammate-style comments, no command spam.
  - Frontend classification and automated sandbox/QA behavior.
  - Delegates coding lifecycle execution to `ticketWorkflowV2Core` child workflow.
- `infra/docker-compose.temporal.yml`
  - Local Temporal stack.

## Webhooks

Use your ngrok URL (currently forwarding to `http://localhost:9876`).

### Linear

- Endpoint:
  - `POST https://<ngrok>/webhooks/linear`
  - Back-compat: `POST https://<ngrok>/webhook`
- Secret:
  - Must match `LINEAR_WEBHOOK_SECRET`.

### GitHub

- Endpoint:
  - `POST https://<ngrok>/github/webhook`
- Events:
  - `Pull requests`
- Secret:
  - Recommended: set `GITHUB_WEBHOOK_SECRET` in `.env` and set the same value in GitHub webhook settings.
  - If unset, signature verification is skipped.

### Manus

- Endpoint:
  - `POST https://<ngrok>/webhooks/manus?workflowType=<type>&workflowId=<id>&projectKey=<project>`
  - Health check: `GET https://<ngrok>/webhooks/manus`
- Behavior:
  - Receives Manus `task_created` / `task_progress` / `task_stopped` events.
  - Requires explicit routing params from the caller:
    - `workflowType` (currently supported: `agentmail`)
    - `workflowId` (Temporal workflow id to signal)
    - `projectKey` (project context for workflow bootstrap)
  - Dispatch route is registry-driven via `tool.manus.webhook.signal.metadata.workflowRoutes` in
    `config/registry/tools.json` (no hardcoded webhook-to-workflow coupling).
  - Signals/starts the configured target workflow for async follow-up.
- Security (recommended):
  - Manus signs webhook requests using `X-Webhook-Signature` and `X-Webhook-Timestamp`.
  - Xena verifies these signatures by default (`MANUS_WEBHOOK_REQUIRE_SIGNATURE=true`) using Manus public key material.
  - You can optionally pin the public key with `MANUS_WEBHOOK_PUBLIC_KEY`; otherwise Xena fetches it from Manus API.
- Optional legacy token guard:
  - `MANUS_WEBHOOK_TOKEN` adds URL query validation (`token=<value>`) for self-generated webhook URLs.
  - Manus does not require app-level token configuration for webhook delivery.

## Ticket Behavior

When assigned, Xena starts/continues `operatorWorkflow` with workflow id `xena:<issueId>`.

Founder override (controlled):
- If issue is not assigned to Xena, only users in `XENA_FOUNDER_LINEAR_USER_IDS` can start evaluate-only mode with `xena evaluate`.
- Evaluate-only mode answers and assesses ticket questions without running discover/plan/code/PR.

Legacy workflow cleanup:
- Server runs periodic cleanup to terminate any active legacy `ticketWorkflow` runs.
- Interval is controlled by `XENA_LEGACY_CLEANUP_INTERVAL_MINUTES` (default `30`, set `0` to disable).

Memory maintenance scheduler:
- Server ensures one durable Temporal workflow per project (`xena:memory-maintenance:<projectKey>`).
- Workflow runs periodic distillation + retention/archive cleanup independent of plan runs.
- Cadence is controlled by `XENA_MEMORY_MAINTENANCE_INTERVAL_MINUTES` (default `360`, set `0` to disable).
- Safe rollout mode is available via `XENA_MEMORY_RETENTION_DRY_RUN=true`.

### Adaptive Matrix (Discover / Plan / Code / Review / Communication)

Xena uses bounded strategy matrices with error-kind classification and family switching.
Stage policies are centralized in `src/config/matrix-policies.ts` and validated in `src/temporal/workflows/matrixPolicyConfig.ts`.

Discover:
- starts with `teddy --quiet`
- switches across strategy families (including `codex exec`) when enough-is-enough triggers
- persists learned successful paths into registry + memory

Plan:
- starts with direct codex planning
- applies quality-gate scoring
- escalates to bounded recursive planning when quality/reliability is low
- persists learned strategy paths into registry + memory

Code implementation:
- starts with codex execution
- switches strategy family on repeated implementation failures
- enforces real worktree change checks (`git status --porcelain`) to detect no-op runs
- persists learned strategy paths into registry + memory

Review:
- runs adaptive review + revision loops
- switches families on repeated blocker/tool failures
- uses focused revision strategy when unresolved `[p0]/[p1]` findings persist
- persists learned strategy paths into registry + memory

Communication (AgentMail):
- runs matrix-selected communication strategies (`semantic` -> `attachment-aware`) with strict no-canned-fallback behavior
- applies confidence and failure-kind switching before outbound email execution
- if strategies exhaust or confidence stays low, asks one explicit clarification question instead of sending a synthetic status reply
- records matrix selection path and failure signatures in memory for learning
- keeps sender trust enforcement as a hard gate before any action

### PR and frontend gate

After PR creation or PR webhook signal:
- Xena classifies frontend vs non-frontend using:
  - issue labels/title/description
  - changed PR files (`gh pr view --json files`)

If frontend:
- Xena provisions Vercel Sandbox from PR branch.
- Xena posts one sandbox-ready comment.
- Xena runs Hyperbrowser QA and posts pass/fail summary.

If non-frontend:
- Xena skips sandbox provisioning and proceeds through smoke/handoff path using CI/manual signals.

### PR close teardown

On GitHub `pull_request.closed`:
- Xena tears down the sandbox (if one exists).
- Teardown state is tracked in Temporal.

### AgentMail Channel (Independent of Linear Tickets)

Xena email is now a standalone channel:
- Dedicated durable workflow: `agentmailWorkflow`.
- Inbound webhook path: `POST /webhooks/agentmail` (Svix signature verification supported via `AGENTMAIL_WEBHOOK_SECRET`).
- Inbound messages are classified (research/digest/meeting/update/task-status/attachment/unknown) with confidence + clarification behavior.
- Low-confidence requests get one clarification question by email.
- Research requests run through Manus (web-connected research engine) and return a sourced summary by email.
- Research requests are started asynchronously through Manus; Xena waits durably and sends follow-up only after Manus webhook completion.
- Task/status requests query live Temporal + Linear state before composing a reply.
- Task/status requests now use registry-driven task probes (Temporal + Linear + email follow-ups + memory follow-ups) before composing a reply.
- Inbound attachments are hydrated (metadata + download handles + inline text extraction for text-like files).
- Outbound replies can include generated attachments (for example research summaries and attachment notes).
- Inbound execution now uses communication-stage matrix switching, not a single hardcoded strategy.
- Periodic digest emails can run on channel cadence (`XENA_AGENTMAIL_INTERVAL_MINUTES`) without any ticket dependency.
- All inbound/tick outcomes are recorded in memory (`workflow.state`) for learning and traceability.

## Teammate Interaction

Supported controls:
- `xena status`
- `xena stop`
- `xena continue`
- `xena restart`
- `xena evaluate`
- `xena prefs show`
- `xena prefs set {"tone":"direct","updateCadence":"balanced","maxRiskLevel":"high"}`
- `xena prefs reset`
- `xena sandbox https://...`
- `xena smoke pass`
- `xena smoke fail <details>`
- `xena research <topic> :: <objective>` (objective optional)

Xena should respond like a teammate:
- concise
- no emoji spam
- no command-list spam in routine updates
- one clarification question max when uncertainty blocks a reliable answer
- reply text generated via LLM with live context (ticket, recent comments, memory, task state), not canned templates
- personality source of truth is `docs/personality.md` (loaded by prompt activities with fallback profile)

Preference profile behavior:
- Profile is stored in mem0 namespace `user.preferences`.
- Profile fields include tone, reply verbosity, update cadence, risk cap, and preferred/blocked agent/tool/resource IDs.
- Low update cadence suppresses routine chatter and preserves critical/command responses.
- Operator planning consumes the profile to shape `maxRiskLevel` and resolver preferences.

Memory model behavior:
- Every memory write is now tagged with structured metadata (`type`, `intent`, `stage`, `outcome`, `source`, optional `confidence`/`qualityScore`, `recordedAt`, `tags`).
- Search supports metadata filters and scoped identifiers (`agent_id`, `app_id`, `run_id`) through activity wrappers.
- Optional graph extraction lane is supported behind `MEM0_ENABLE_GRAPH=true` for relationship-heavy namespaces (`user.preferences`, `code.decisions`, `quality.signals`, `research.findings`).
- Planning uses hybrid memory retrieval across context/decision/quality/preferences lanes and injects aggregated decision signatures into planning prompts.
- Periodic memory maintenance is live:
  - distillation snapshots from planning + scheduled maintenance ticks
  - retention policy with namespace-specific staleness/volume thresholds
  - archive-then-delete cleanup for low-value stale entries, with dry-run support

## Current Boundaries (Honest Status)

Implemented now:
- Durable webhook-driven coding lifecycle across Linear + GitHub + Temporal
- Adaptive strategy matrix in discover/plan/code/review with shared runtime + policy-driven strategy definitions
- Learned workflow persistence to `config/registry/learned-workflows.json` and mem0 namespaces
- Resolver auto-selection of learned workflows based on context + error signatures (deterministic ranking with promotion gating)
- Learned pattern quality scoring and lifecycle states (`observational`, `promoted`, `disabled`)
- Personal preference memory model with planning/reply behavior shaping
- Frontend sandbox + Hyperbrowser QA path for frontend PRs

Not implemented yet:
- Autonomous daily brief/follow-up scheduler (`NS-0022`, `NS-0023`)
- Slack/WhatsApp/Voice communication channels
- Presentation-generation workflow from research outputs

## Environment

### Required core

- `LINEAR_API_KEY`
- `LINEAR_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- `MEM0_API_KEY`
- `MANUS_API_KEY` (required for web research runs)
- `TEMPORAL_ADDRESS`
- `TEMPORAL_NAMESPACE`
- `TEMPORAL_TASK_QUEUE`

### Required for PR + sandbox automation

- `GITHUB_TOKEN` (or `GH_TOKEN`)
- `VERCEL_ACCESS_TOKEN`
- `VERCEL_PROJECT_ID`
- `VERCEL_TEAM_ID`
- `HYPERBROWSER_API_KEY`

### Recommended security

- `GITHUB_WEBHOOK_SECRET`

### Optional tuning

- `XENA_HYPERBROWSER_MODEL` (default `gpt-5.2`)
- `MEM0_ENABLE_GRAPH` (`false` by default; enable selective graph extraction for relationship-heavy memory lanes)
- `MANUS_BASE_URL` (default `https://api.manus.ai/v1`)
- `MANUS_POLL_INTERVAL_MS` (default `5000`)
- `MANUS_TIMEOUT_SECONDS` (default `1200`, 20 minutes)
- `MANUS_WEBHOOK_REQUIRE_SIGNATURE` (`true|false`; default `true`; enforces Manus webhook signature verification)
- `MANUS_WEBHOOK_PUBLIC_KEY` (optional PEM pin for signature verification; if unset, Xena fetches Manus webhook public key)
- `MANUS_WEBHOOK_TOKEN` (optional legacy query token guard for `/webhooks/manus`)
- `XENA_FOUNDER_LINEAR_USER_IDS` (comma-separated Linear user IDs allowed to use unassigned `xena evaluate`)
- `XENA_LEGACY_CLEANUP_INTERVAL_MINUTES` (legacy workflow cleanup cadence; `0` disables)
- `XENA_MEMORY_MAINTENANCE_INTERVAL_MINUTES` (memory distill/retention cadence in minutes; `0` disables)
- `XENA_MEMORY_RETENTION_DRY_RUN` (`true|false`; dry-run retention without deleting source memories)
- `AGENTMAIL_API_KEY` (enables AgentMail integration)
- `AGENTMAIL_BASE_URL` (default `https://api.agentmail.to`)
- `AGENTMAIL_WEBHOOK_SECRET` (verifies AgentMail webhook signatures; supports Svix headers)
- `XENA_AGENTMAIL_INBOX_ID` (optional explicit inbox id; bypasses auto-ensure)
- `XENA_AGENTMAIL_USERNAME` / `XENA_AGENTMAIL_DOMAIN` / `XENA_AGENTMAIL_DISPLAY_NAME` (used when auto-creating inbox)
- `XENA_OWNER_EMAIL` (default recipient when no explicit email target is provided)
- `XENA_AGENTMAIL_INTERVAL_MINUTES` (`0` disables periodic email digest ticks; >0 enables cadence)
- `XENA_AGENTMAIL_DRY_RUN` (`true|false`; classify/process inbound but skip outbound sends)
- `XENA_SAFE_SENDER_EMAILS` (critical sender allowlist for identity trust; defaults to `mark@kahunas.io,mark@markfox.me`)
- `XENA_PUBLIC_BASE_URL` (preferred public base URL for Manus webhook callbacks, e.g. your ngrok URL)
- `XENA_INTERNAL_BASE_URL` (fallback internal base URL for local proxying)

Sender identity guard:
- Inbound AgentMail actions are executed only when sender email is in `XENA_SAFE_SENDER_EMAILS`.
- Anyone else (including messages claiming to be Mark by display name) is ignored and logged as `agentmail_sender_ignored`.

## Local Ops

### Build

```bash
npm run build
```

### Typecheck

```bash
npm run typecheck
```

### Bring up services (pm2 + Temporal bootstrap)

```bash
./scripts/up.sh
```

### Health checks

```bash
curl -fsS http://127.0.0.1:3001/healthz
curl -fsS http://127.0.0.1:9876/healthz
curl -fsS http://127.0.0.1:4040/api/tunnels
temporal operator cluster health --address 127.0.0.1:7233
```

