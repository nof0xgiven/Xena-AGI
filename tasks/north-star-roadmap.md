# Xena North Star Roadmap

Updated: 2026-02-11

## North Star Goal
Build Xena into a personal, proactive, always-learning operator where the method is constant and tools/resources/agents are modular.

## Best-In-Class Architecture Contract
- Keep orchestration workflows thin: stage control-flow only, no provider-specific strategy trees embedded inline.
- Define stage strategies and matrix policies as versioned registry/config data, not hardcoded arrays in workflow files.
- Execute providers through adapters (`toolId -> adapter`) so Codex/Teddy/others are swappable without workflow rewrites.
- Share one matrix runtime for discover/plan/code/review switching semantics (attempt caps, enough-is-enough, family switch rules, telemetry).
- Promote learned strategies only after repeated successful proofs, with explicit quality/recency thresholds before resolver auto-selection.
- Preserve north-star invariants: immutable method (engine), modular registry (tools/resources/skills/agents), personal-first behavior.

## Done Now (Implemented)
- Operator + registry composition is live (`src/operator/kernel.ts`, `src/registry/*`, `config/registry/*`).
- Durable coding lifecycle orchestration is live (`src/temporal/workflows/operatorWorkflow.ts`, `src/temporal/workflows/ticketWorkflowV2Core.ts`).
- Universal engine transition contract is live across planning + workflow execution with rationale (`src/operator/engineRuntime.ts`, `src/operator/kernel.ts`, `src/temporal/workflows/operatorWorkflow.ts`, `src/temporal/workflows/ticketWorkflowV2Core.ts`).
- Memory namespaces and mem0 integration are live (`src/memory/policy.ts`, `src/mem0.ts`, `src/temporal/activities/mem0Activities.ts`).
- Adaptive matrix is live across discover/plan/code/review with shared runtime + policy-driven strategy definitions + adapterized execution (`src/temporal/workflows/discoverWorkflow.ts`, `src/temporal/workflows/planWorkflow.ts`, `src/temporal/workflows/codeWorkflow.ts`, `src/temporal/workflows/matrixRuntime.ts`, `src/temporal/workflows/matrixPolicyConfig.ts`, `src/config/matrix-policies.ts`, `config/registry/tools.json`).
- Resolver learned-workflow auto-selection is live and deterministic from context + error signatures with promotion gating (`src/operator/kernel.ts`, `src/registry/schema.ts`, `src/registry/resolver.ts`, `config/registry/learned-workflows.json`).
- Learned workflow quality scoring + promotion lifecycle is live (`src/temporal/activities/registryLearningActivities.ts`, `src/registry/resolver.ts`) with metadata-backed states (`observational`, `promoted`, `disabled`).
- Personal preference memory model is live:
  - typed profile + cadence logic (`src/memory/userPreferences.ts`)
  - mem0 `user.preferences` retrieval (`src/temporal/activities/mem0Activities.ts`)
  - operator planning preference injection (`src/temporal/workflows/operatorWorkflow.ts`)
  - teammate reply preference shaping across discover/plan/code/ticket workflows (`src/temporal/workflows/*.ts`, `src/temporal/activities/openaiActivities.ts`)
  - resolver preference-aware selection for preferred/blocked tool/resource IDs (`src/registry/schema.ts`, `src/operator/kernel.ts`, `src/registry/resolver.ts`)
- Mem0 metadata contract hardening is live:
  - structured write metadata (`type`, `intent`, `stage`, `outcome`, `source`, `confidence`, `qualityScore`, `tags`, `recordedAt`)
  - scoped search/write support (`agent_id`, `app_id`, `run_id`) and metadata filters
  - graph lane toggle support (`MEM0_ENABLE_GRAPH`) for selective namespaces
  (`src/mem0.ts`, `src/temporal/activities/mem0Activities.ts`, workflow mem0 callsites)
- Hybrid memory retrieval + decision signatures are live:
  - relationship-aware multi-lane memory retrieval (`ticket.context`, `code.decisions`, `quality.signals`, `research.findings`, `user.preferences`)
  - aggregated decision signature extraction and planning injection
  (`src/temporal/activities/mem0Activities.ts`, `src/temporal/workflows/planWorkflow.ts`, `src/temporal/workflows/operatorWorkflow.ts`)
- Memory distillation + retention lifecycle is live:
  - planning-triggered distillation snapshots
  - namespace retention rules + archive/delete actions
  - periodic maintenance workflow started at server bootstrap
  (`src/temporal/activities/mem0Activities.ts`, `src/memory/policy.ts`, `src/mem0.ts`, `src/temporal/workflows/memoryMaintenanceWorkflow.ts`, `src/server/index.ts`)
- Research run and source validation pipeline are live (`src/capabilities/research/*`, `src/temporal/activities/researchActivities.ts`).
- Manus is now first-class for research execution (web-connected research + artifact links, including presentation-capable outputs via Manus files) (`src/manus.ts`, `src/temporal/activities/researchActivities.ts`, `config/registry/tools.json`, `config/registry/resources.json`).
- Manus async completion is now webhook-signaled into Temporal for long-running email research requests (`src/server/index.ts`, `src/temporal/signals.ts`, `src/temporal/shared.ts`, `src/temporal/workflows/agentmailWorkflow.ts`, `src/temporal/activities/researchActivities.ts`).
- AgentMail independent channel foundation is integrated:
  - inbox auto-ensure + message send activities
  - dedicated `agentmailWorkflow` for inbound commands + periodic digest ticks
  - webhook intake path and signal routing (`/webhooks/agentmail`)
  - strict safe-sender identity guard for trusted sender execution
  (`src/agentmail.ts`, `src/temporal/activities/agentmailActivities.ts`, `src/temporal/workflows/agentmailWorkflow.ts`, `src/server/index.ts`, `src/identity/safeSenders.ts`)
- AgentMail matrix-first communication runtime is now integrated:
  - communication stage matrix policy (`semantic` -> `attachment-aware`) with bounded retries and family-switch rules
  - no canned fallback responses; low-confidence/exhausted paths now force explicit clarification
  - task/status requests now pull live Temporal + Linear snapshots before reply generation
  - webhook payload normalization for nested `message.received` events and attachment metadata capture
  - inbound attachment hydration (metadata + download handles + inline text extraction for text-like files)
  - outbound attachment support for generated teammate artifacts (research summaries and attachment notes)
  - matrix decision trail persisted in memory (`workflow.state`, `code.decisions`)
  (`src/config/matrix-policies.ts`, `src/temporal/workflows/matrixPolicyConfig.ts`, `src/temporal/workflows/agentmailWorkflow.ts`, `src/temporal/activities/agentmailActivities.ts`, `src/server/index.ts`, `src/agentmail.ts`)
- Registry-driven task-source probing is now integrated:
  - strict tool surface contract in registry schema (domains/entities/operations/task roles/authority/SLA)
  - dynamic task probe selection by capability (`tasks.probe`) rather than hardcoded sources
  - explicit task probe tools for Temporal, Linear, email follow-ups, and memory follow-ups
  (`src/registry/schema.ts`, `config/registry/tools.json`, `src/temporal/activities/operatorStatusActivities.ts`, `config/registry/skills.json`)
- Skill playbook contract is now documented with async-task routing pattern and live Manus follow-up example (`docs/skills-playbooks.md`, `config/registry/skills.json`, `config/registry/agents.json`).

## Partially Done
- Engine stage contract now spans Understand/Prove/Plan/Confidence Gate/Execute/Validate/Learn/Adapt with confidence loopback; remaining work is personalization/proactivity/channel expansion.
- Proactive behavior exists for webhook-driven events, but not for autonomous daily/continuous operation.
- Multi-tool operations are strong for coding/research + Linear/GitHub, but not yet for all target communication channels.
- Email channel now has independent inbound + outbound loop with sender trust guard, matrix strategy switching, and attachment send/receive support; calendar/tool expansion remains.

## Outstanding for North Star
- Orchestrator-only task contract hardening: every command path should route through durable workflow actions (`start|stop|restart|status`) with no direct-action bypass.
- Skill playbook routing: objective-specific playbooks that select tool combinations and persist playbook outcomes for learning.
- Calendar execution tool path remains unimplemented (meeting requests currently handled as clarification-first).
- Manus async orchestration path is live, but full inbox-driven end-to-end proof coverage (finish + ask) is still outstanding.
- Learned workflow tuning and promotion-threshold calibration from live production incidents.
- Proactive scheduler: independent task detection, check-ins, reminders, and follow-ups.
- Cross-channel communications: Slack, WhatsApp, Voice strategies need to be added to the communication matrix policy (`NS-0052`) so the operating loop can select non-email paths. Blocked on channel tool implementations (`NS-0030`, `NS-0032`, `NS-0033`).
- Research-to-presentation execution path for strategy/brief outputs.
- Operator observability: confidence trends, strategy switch reasons, learned pattern quality, trust score movement.

## Execution Order
1. P1 Memory Intelligence: retrieval precision tuning from retention outcomes and live recall quality.
2. P1 Proactivity: scheduler + autonomous follow-up loops.
3. P1 Channel expansion: Slack + inbound email loop first, then WhatsApp/Voice.
4. P2 Refinement: observability dashboards and learning-quality metrics.

## Definition of North Star Readiness
- Xena selects strategies dynamically without hardcoded fallback trees.
- Learning updates influence future execution paths automatically.
- Behavior is personalized to your preferences and decision style.
- Xena proactively surfaces work and communicates across selected channels.
- All major actions are traceable with explicit confidence, rationale, and outcome proof.
