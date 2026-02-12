# Tool Registry Guide

Source of truth:
- Registry files: `config/registry/*.json`
- Schema: `src/registry/schema.ts`
- Loader: `src/registry/loader.ts`
- Copy-paste templates: `docs/tool-templates.md`
- Skill playbook contract: `docs/skills-playbooks.md`

This doc defines exactly how to add tools to Xena.

## Why This Exists

Xena should not hardcode system-specific behavior (for example, "tasks always mean Linear + Temporal").
Xena should discover what tools can do by reading the registry contract.

## Tool Contract (Required)

Each tool entry in `config/registry/tools.json` must include:

- Base fields:
  - `id`
  - `name`
  - `version`
  - `description`
  - `enabled`
  - `tags`
  - `metadata`
- Surface contract:
  - `surface.domains`
  - `surface.entities`
  - `surface.operations`
  - `surface.taskRoles`
  - `surface.authority`
  - `surface.freshnessSlaSec`
- Runtime fields:
  - `capabilities`
  - `deterministic`
  - `riskLevel`

## Allowed Surface Values

`surface.domains`:
- `coding`
- `research`
- `communication`
- `tasks`
- `workflow`
- `memory`
- `project_management`
- `observability`
- `integration`

`surface.operations`:
- `probe`
- `list`
- `read`
- `start`
- `stop`
- `restart`
- `execute`
- `analyze`
- `classify`
- `reply`
- `comment`
- `verify`
- `write`
- `search`

`surface.taskRoles`:
- `source`
- `controller`
- `observer`

## Capability Naming Rules

Use dot-separated verb/object semantics:
- `tasks.probe`
- `tasks.list`
- `linear.issue.read`
- `communication.email.reply`
- `code.implement`

Rules:
- Keep capabilities provider-agnostic when possible (`tasks.probe`).
- Add provider-specific capabilities only when needed (`linear.issue.read`).
- Reuse existing capabilities before adding new ones.

## Add a Standard Tool (Non-Task Probe)

1. Add the tool entry to `config/registry/tools.json`.
2. Set `surface` to describe real behavior.
3. Add any required `capabilities`.
4. Add the tool to relevant skills and/or agents:
   - `config/registry/skills.json`
   - `config/registry/agents.json`
5. If this tool is used by a matrix strategy, map it in policy/config and adapter:
   - `src/config/matrix-policies.ts`
   - `src/temporal/workflows/*Workflow.ts` adapter map

## Add a Webhook Route Tool (Dynamic Workflow Dispatch)

Some integration tools route inbound events to Temporal workflows.  
For Manus, routes are declared in tool metadata (not hardcoded in handlers).

Current contract (`tool.manus.webhook.signal.metadata.workflowRoutes`):

```json
{
  "workflowRoutes": [
    {
      "workflowType": "agentmail",
      "workflowName": "agentmailWorkflow",
      "signalName": "manusEvent",
      "dispatchMode": "signalWithStart",
      "bootstrap": "agentmail"
    }
  ]
}
```

Field semantics:
- `workflowType`: query param selector from webhook URL.
- `workflowName`: Temporal workflow type to target.
- `signalName`: Temporal signal name to emit.
- `dispatchMode`:
  - `signalWithStart`: start workflow if needed, then signal.
  - `signalOnly`: signal running workflow only.
- `bootstrap`:
  - `agentmail`: build AgentMail start args from `projectKey` + env.
  - `none`: no start args (use for workflows that can start without args or when using `signalOnly`).

## Add a Task Source Tool (Probe-Capable)

A tool is treated as a task source when:

1. `enabled === true`
2. `capabilities` includes `tasks.probe`
3. `surface.taskRoles` includes `source`

Required wiring:

1. Add the tool entry to `config/registry/tools.json` with:
   - `capabilities` including `tasks.probe`
   - `surface.taskRoles` including `source`
2. Register a probe adapter in:
   - `src/temporal/activities/operatorStatusActivities.ts`
   - `TASK_PROBE_ADAPTERS` map (`toolId -> adapter`)
3. Ensure adapter returns normalized task observations with timestamps/states.
4. If operator intent depends on task visibility, include `tasks.probe` in skill requirements:
   - `config/registry/skills.json`

If a `tasks.probe` tool has no adapter, snapshot output reports it as `unsupported`.

## Add a Learned Tool (Runtime Upsert Path)

If a workflow creates learned tool entries, the generated tool objects must also include `surface`.
Current implementation:
- `src/temporal/activities/registryLearningActivities.ts`

Any learned tool missing `surface` will fail registry validation.

## Example Template

```json
{
  "id": "tool.tasks.example.source",
  "name": "Tasks Example Source",
  "version": "1.0.0",
  "description": "Probes pending tasks from Example system.",
  "enabled": true,
  "tags": ["tasks", "example"],
  "metadata": {},
  "surface": {
    "domains": ["tasks", "integration"],
    "entities": ["example.task"],
    "operations": ["probe", "list", "read"],
    "taskRoles": ["source", "observer"],
    "authority": 0.8,
    "freshnessSlaSec": 120
  },
  "capabilities": ["tasks.probe", "tasks.list"],
  "deterministic": true,
  "riskLevel": "low"
}
```

## Validation Checklist

Run after every tool change:

```bash
npm run typecheck
npm run build
```

Optional runtime checks:

```bash
node -e "import('./dist/registry/loader.js').then(async (m)=>{const r=await m.loadRegistryBundle();console.log(r.tools.length)})"
```

For task probes:

```bash
set -a && source .env >/dev/null 2>&1 && set +a
node -e "import('./dist/temporal/activities/operatorStatusActivities.js').then(async (m)=>{const s=await m.operatorGetTaskSnapshot({projectKey:process.env.DEFAULT_PROJECT_KEY});console.log(s.probes)})"
```

## Common Failure Modes

- Registry parse error on startup:
  - Tool entry violates schema (usually missing `surface` fields or invalid enum values).
- Task tool never used:
  - Missing `tasks.probe` capability or missing `source` role.
- Task probe shows `unsupported`:
  - `toolId` missing from `TASK_PROBE_ADAPTERS`.
- Runtime probe errors:
  - Missing env vars for that backend (Temporal/Linear/Mem0/etc.).

## Design Principle

Tools are interchangeable execution surfaces.
The matrix decides strategy; the registry describes capability; adapters execute.
Do not hardcode source systems in intent handlers when registry-driven probing can be used.
