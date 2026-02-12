# Skill Playbooks

Source of truth:
- Registry schema: `src/registry/schema.ts`
- Skill definitions: `config/registry/skills.json`
- Agent composition: `config/registry/agents.json`

## Why Skills Exist

Tools describe what can be done.  
Skills describe how to combine tools safely for a specific objective.

For Xena, skills should encode:
- objective intent (`coding` or `research`)
- required capabilities
- preferred tool order
- hard guardrails
- output contract

## Skill Definition Pattern

Each skill entry in `config/registry/skills.json` should include:
- `id`, `name`, `version`, `description`
- `intentTypes`
- `requiredCapabilities`
- `preferredToolIds`
- `preferredResourceIds`
- `guardrails`
- `outputContract.required`

Use capabilities to express behavior contracts, not provider names.

## Async Task Playbook Pattern (Temporal + Webhook)

For long-running tasks (for example Manus research):
1. Start task via controller tool (`research.task.start`).
2. Persist correlation context (task id, requester, objective) in workflow state.
3. Wait durably in Temporal for webhook signal (`workflow.signal.receive`).
4. On completion signal:
   - fetch/finalize provider output
   - send teammate follow-up
   - attach artifacts
   - persist learning + outcome metadata.
5. On `ask`/clarification stop reasons:
   - send one concrete question
   - keep task correlation active for continued follow-up.

This keeps orchestration deterministic and avoids synthetic fallback replies.

## Current Live Example

`skill.research.async_followup` in `config/registry/skills.json` uses:
- `tool.manus.research`
- `tool.manus.webhook.signal`
- `tool.communication.email.semantic`
- `tool.communication.email.attachment`

and maps to runtime paths:
- `src/temporal/workflows/agentmailWorkflow.ts`
- `src/temporal/activities/researchActivities.ts`
- `src/server/index.ts` (`POST /webhooks/manus?workflowType=agentmail&workflowId=<id>&projectKey=<project>`)
- `config/registry/tools.json` (`tool.manus.webhook.signal.metadata.workflowRoutes`)
