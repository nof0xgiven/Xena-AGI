# Xena

Xena is not "a chatbot with tools."

It is a deterministic runtime for AI work that needs to survive contact with reality.

If most agent systems feel like this:

- one huge prompt
- one long thread
- hidden state everywhere
- unclear retries
- unclear ownership
- unclear audit trail

Xena takes the opposite approach.

Every piece of work is turned into a durable task.
Every execution attempt is a run.
Every state change is an event.
Every agent call is single-shot.
Every retry, delegation, artifact, and memory write is explicit.

The core idea is simple:

> orchestration truth lives in the system, not inside the model

That means Xena can rebuild context from persisted state, re-enter work cleanly, fan out to child tasks, and keep a real lineage of what happened.

## The Shape Of The System

At a high level, Xena is a Trigger-first, Postgres-backed orchestration layer for stateless agents.

- `Trigger.dev` runs bounded agent executions
- `Postgres` is the system of record
- `MinIO / object storage` holds durable artifacts
- `pgvector + lexical retrieval` power scoped memory recall
- `TypeScript` holds the contracts, runtime, and orchestration logic together

This project is aimed at one kind of problem:

You want multiple agents doing real work across businesses and projects, but you do not want the system to dissolve into untraceable prompt soup.

## How Work Actually Flows

This is the mental model:

```text
                +----------------------+
                |   external webhook   |
                |  or internal event   |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | validate + dedupe    |
                | reject bad payloads  |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | create / load Task   |
                | create Run + Event   |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | build ContextBundle  |
                | task + artifacts +   |
                | scoped memory        |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | Trigger execution    |
                | one agent, one shot  |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | validate AgentResult |
                | persist outputs      |
                +----------+-----------+
                           |
            +--------------+---------------+
            |                              |
            v                              v
 +----------------------+      +----------------------+
 | terminal update      |      | delegated update     |
 | completed / failed   |      | child tasks created  |
 +----------------------+      | parent waits         |
                               +----------+-----------+
                                          |
                                          v
                               +----------------------+
                               | barrier satisfied?   |
                               | if yes, re-enter     |
                               | with fresh context   |
                               +----------------------+
```

The important part is what does *not* happen:

- the parent agent does not keep waiting in memory
- sub-agents do not become hidden nested chats
- retries do not silently mutate history
- memory does not become the only source of truth

## Giving Xena A Task

Right now the first real operator path is live and intentionally small:

- `POST /tasks` is the public entrypoint
- it validates the request against the OpenAPI contract
- it forwards the canonical envelope into `POST /webhooks/ingress`
- the webhook path persists `Task`, `Run`, and `Event`
- Trigger executes one agent
- the proof bundle is available at `GET /tasks/{taskId}/proof`

That flow currently powers one simple proof agent:

- `agent_html_page_builder`
- prompt asset: [`src/prompts/assets/html-page-builder.md`](/Users/ava/main/projects/openSource/xena/src/prompts/assets/html-page-builder.md)
- tools: `Read`, `Write`
- write sandbox: `artifacts/generated/`

So the current human workflow is:

1. Send a task to `/tasks`.
2. Xena runs the agent through Trigger.
3. Xena writes the output artifact.
4. You inspect the proof bundle.

The public shape looks like this:

```text
      Bearer token
human -------------> POST /tasks
                         |
                         | validate request
                         v
                 self-forward with
                 webhook token header
                         |
                         v
              POST /webhooks/ingress
                         |
                         | persist Task / Run / Event
                         v
                    Trigger.dev
                         |
                         | execute one agent
                         v
                  tool calls + result
                         |
             +-----------+------------+
             |                        |
             v                        v
 artifacts/generated/*       GET /tasks/{id}/proof
```

What the proof route gives you:

- original API input
- resolved agent definition
- rendered prompt
- context bundle
- tool registry
- tool execution events
- final result
- persisted artifacts
- run and task state

Agent configuration now lives in validated manifests under [`agents`](/Users/ava/main/projects/openSource/xena/agents), with prompts still stored separately under [`src/prompts/assets`](/Users/ava/main/projects/openSource/xena/src/prompts/assets). The runtime loads those manifests at boot, validates prompt refs, known tools, and delegation topology, and then feeds the resulting definitions into the registry.

## A Concrete Example

Imagine the system receives:

"Launch this campaign and coordinate copy, creative, and benchmarks."

Xena does not hand that whole thing to one giant agent session and hope for the best.

Instead it:

1. Validates the incoming payload.
2. Creates a durable `Task`.
3. Creates a `Run` for the current execution attempt.
4. Builds a `ContextBundle` from task state, related artifacts, and scoped memory.
5. Executes one agent through Trigger.
6. Accepts a structured `AgentResult`.
7. If the result delegates:
   - creates child tasks
   - stores a `DelegationContract`
   - moves the parent to `awaiting_subtasks`
8. When required child tasks finish:
   - evaluates the barrier
   - emits a re-entry event
   - runs the parent again with fresh context

This is why Xena is useful: it turns agent work into something inspectable.

## The Core Objects

If you understand these, you understand the project:

- `Task`: the durable unit of business work
- `Run`: one execution attempt of one task
- `Event`: the immutable fact that moved the workflow forward
- `ContextBundle`: the fresh per-run working context
- `AgentResult`: the only valid shape an agent is allowed to return
- `DelegationContract`: the durable agreement between a parent task and its children
- `Artifact`: durable output like a report, file, URL, or transcript
- `MemoryRecord`: scoped memory that can help future runs without replacing truth

## Memory, In Human Terms

Xena does not pretend "memory" is magic.

It splits memory into layers:

- ground truth: tasks, runs, events, artifacts, business/project state
- retrieval memory: things worth recalling later
- consolidated knowledge: extracted patterns and procedures
- working memory: the temporary context bundle for one run

And it is strict about scope:

- project memory first
- then business memory
- then agent memory
- then `global_patterns`

So if a local project truth and a generic pattern disagree, the local truth wins.

That is the whole point.

## What This Repo Contains Right Now

This repo now includes the v1 runtime backbone:

- toolchain and local dev setup
- strict contracts and validation
- durable Postgres schema + migrations
- object storage adapter
- agent registry + prompt rendering
- memory persistence, lexical retrieval, and pgvector-backed semantic recall
- deterministic context builder
- OpenAI provider execution path
- Trigger task wrapper
- authenticated HTTP ingress + webhook handoff
- delegation, retry, reconciliation, and promotion flows
- unit, integration, and scenario coverage

Main runtime folders:

- [`src/api`](/Users/ava/main/projects/openSource/xena/src/api)
- [`src/contracts`](/Users/ava/main/projects/openSource/xena/src/contracts)
- [`src/ingress`](/Users/ava/main/projects/openSource/xena/src/ingress)
- [`src/persistence`](/Users/ava/main/projects/openSource/xena/src/persistence)
- [`src/memory`](/Users/ava/main/projects/openSource/xena/src/memory)
- [`src/runtime`](/Users/ava/main/projects/openSource/xena/src/runtime)
- [`src/orchestration`](/Users/ava/main/projects/openSource/xena/src/orchestration)
- [`src/reconciliation`](/Users/ava/main/projects/openSource/xena/src/reconciliation)
- [`src/providers`](/Users/ava/main/projects/openSource/xena/src/providers)
- [`tests`](/Users/ava/main/projects/openSource/xena/tests)

## Running It Locally

1. Copy env values into `.env`.
2. Start local infrastructure:

```bash
docker compose -f docker-compose.local.yml up -d
```

3. Run verification:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Quality guardrails beyond the basics:

```bash
pnpm check:boundaries
pnpm check:unused
pnpm check:duplication
pnpm check:structure
pnpm check:quality
```

What they do:

- `check:boundaries`: enforces module boundaries and blocks circular dependencies
- `check:unused`: finds dead exports, unused files, and stale dependencies
- `check:duplication`: catches copy-paste logic in production code
- `check:structure`: enforces file-size and export-count limits, with a small exception list for known schema/repository hotspots
- `check:quality`: runs the full quality gate in one command

GitHub Actions now uses `pnpm check:quality` as the branch gate and boots the same local Postgres + MinIO stack from `docker-compose.local.yml` before running it.

4. Boot Trigger locally:

```bash
pnpm trigger:dev
```

5. Start the authenticated API:

```bash
pnpm api:start
```

For the public tunnel / managed local setup in this repo, PM2 is the intended operator path:

```bash
pm2 start ecosystem.config.cjs
```

Local service ports are intentionally non-default so this project does not collide with existing containers:

- Postgres: `55432`
- MinIO API: `19000`
- MinIO Console: `19001`
- API: `18791` via PM2 in the local ecosystem file

### Required Ingress Auth

The operator surface is protected now:

- `POST /tasks` requires `Authorization: Bearer $XENA_API_TOKEN`
- `POST /webhooks/ingress` requires `x-xena-webhook-token: $XENA_WEBHOOK_TOKEN`
- `GET /tasks/{taskId}/proof` also requires `Authorization: Bearer $XENA_API_TOKEN`

Add these to `.env`:

```bash
XENA_API_TOKEN=replace-me
XENA_WEBHOOK_TOKEN=replace-me
```

Example task submission:

```bash
curl -X POST https://xena.ngrok.app/tasks \
  -H "Authorization: Bearer $XENA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent_html_page_builder",
    "business_id": "demo_business",
    "project_id": "demo_project",
    "title": "Hello World HTML",
    "message": "Create hello world html page"
  }'
```

Then inspect the proof:

```bash
curl https://xena.ngrok.app/tasks/<task_id>/proof \
  -H "Authorization: Bearer $XENA_API_TOKEN"
```

## If You Only Read Three Files

Start here:

- [`README.md`](/Users/ava/main/projects/openSource/xena/README.md)
- [`specification.md`](/Users/ava/main/projects/openSource/xena/specification.md)
- [`docs/runtime-flow-state.md`](/Users/ava/main/projects/openSource/xena/docs/runtime-flow-state.md)

Then use these when you need detail:

- [`companion-schema.md`](/Users/ava/main/projects/openSource/xena/companion-schema.md)
- [`roadmap.md`](/Users/ava/main/projects/openSource/xena/roadmap.md)
- [`docs/memory-architecture-governance.md`](/Users/ava/main/projects/openSource/xena/docs/memory-architecture-governance.md)

## What Xena Is Not

Xena is not:

- a persistent chat thread
- an "autonomous agent" toy
- a hidden-memory black box
- a workflow engine that lets the model invent its own truth

It is a runtime that treats AI work like a system that must be replayed, audited, retried, and understood by humans.

That is the project.
