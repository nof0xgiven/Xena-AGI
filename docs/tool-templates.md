# Tool Templates

Use these copy-paste templates when adding new tools to `config/registry/tools.json`.

Companion guide:
- Process + rules: `docs/tool-registry.md`

## 1) Coding Tool (Strategy Execution)

Use for discover/plan/code/review style execution tools.

```json
{
  "id": "tool.code.example.exec",
  "name": "Code Example Exec",
  "version": "1.0.0",
  "description": "Executes coding tasks using Example provider.",
  "enabled": true,
  "tags": ["coding", "implementation"],
  "metadata": {},
  "surface": {
    "domains": ["coding"],
    "entities": ["repository", "patch"],
    "operations": ["execute", "analyze", "write"],
    "taskRoles": ["controller"],
    "authority": 0.75,
    "freshnessSlaSec": 120
  },
  "capabilities": ["code.implement"],
  "deterministic": false,
  "riskLevel": "medium"
}
```

## 2) Research Tool (Manus-Style)

Use for source retrieval, synthesis, or verification.

```json
{
  "id": "tool.manus.research",
  "name": "Manus Research",
  "version": "1.0.0",
  "description": "Runs web-connected research and returns synthesis plus artifacts.",
  "enabled": true,
  "tags": ["research", "web", "manus", "presentation"],
  "metadata": {},
  "surface": {
    "domains": ["research", "integration"],
    "entities": ["web.source", "research.brief", "presentation.deck"],
    "operations": ["execute", "search", "analyze", "read"],
    "taskRoles": ["controller", "source"],
    "authority": 0.9,
    "freshnessSlaSec": 180
  },
  "capabilities": ["research.fetch", "research.summarize", "web.navigate", "research.presentation.generate"],
  "deterministic": false,
  "riskLevel": "medium"
}
```

## 3) Communication Tool (Email/Reply)

Use for classification, response composition, and message-aware behavior.

```json
{
  "id": "tool.communication.email.example",
  "name": "Email Example Strategy",
  "version": "1.0.0",
  "description": "Classifies and composes email replies.",
  "enabled": true,
  "tags": ["communication", "email"],
  "metadata": {},
  "surface": {
    "domains": ["communication", "tasks"],
    "entities": ["email.message"],
    "operations": ["classify", "read", "reply"],
    "taskRoles": ["controller", "source"],
    "authority": 0.75,
    "freshnessSlaSec": 120
  },
  "capabilities": ["communication.email.classify", "communication.email.reply"],
  "deterministic": false,
  "riskLevel": "medium"
}
```

## 4) Task Source Tool (Probe-Capable)

Use when a system can provide task/status truth.

```json
{
  "id": "tool.tasks.example.source",
  "name": "Tasks Example Source",
  "version": "1.0.0",
  "description": "Probes active tasks from Example system.",
  "enabled": true,
  "tags": ["tasks", "example"],
  "metadata": {},
  "surface": {
    "domains": ["tasks", "integration"],
    "entities": ["example.task"],
    "operations": ["probe", "list", "read"],
    "taskRoles": ["source", "observer"],
    "authority": 0.85,
    "freshnessSlaSec": 60
  },
  "capabilities": ["tasks.probe", "tasks.list"],
  "deterministic": true,
  "riskLevel": "low"
}
```

Critical:
- `tasks.probe` must be present.
- `taskRoles` must include `source`.
- Add adapter in `src/temporal/activities/operatorStatusActivities.ts` (`TASK_PROBE_ADAPTERS`).

## 5) Observer-Only Tool

Use when a tool reads/validates but should not execute control actions.

```json
{
  "id": "tool.example.verify",
  "name": "Example Verification",
  "version": "1.0.0",
  "description": "Validates output sources.",
  "enabled": true,
  "tags": ["verification"],
  "metadata": {},
  "surface": {
    "domains": ["observability", "integration"],
    "entities": ["example.record"],
    "operations": ["verify", "read"],
    "taskRoles": ["observer"],
    "authority": 0.9,
    "freshnessSlaSec": 180
  },
  "capabilities": ["example.verify"],
  "deterministic": true,
  "riskLevel": "low"
}
```

## Adapter Skeleton (Task Probe)

Use this when registering a new probe adapter.

```ts
// src/temporal/activities/operatorStatusActivities.ts
const TASK_PROBE_ADAPTERS: Record<string, ProbeAdapter> = {
  "tool.tasks.example.source": async (ctx) => {
    const rows = await fetchExampleRows(ctx);
    return {
      // map to normalized task array used by snapshot summary
      memoryFollowupTasks: rows.map((row) => ({
        id: row.id,
        title: row.title,
        source: "example",
        intent: row.intent,
        outcome: row.state,
        updatedAt: row.updatedAt,
      })),
    };
  },
};
```

## Quick Checklist

1. Add JSON entry in `config/registry/tools.json`.
2. Add matrix/adapter wiring if execution tool.
3. Add skill/agent references if needed.
4. For `tasks.probe` tools, add `TASK_PROBE_ADAPTERS` mapping.
5. Validate:
   - `npm run typecheck`
   - `npm run build`
