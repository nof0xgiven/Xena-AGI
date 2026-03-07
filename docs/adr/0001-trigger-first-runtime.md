# ADR 0001: Trigger-First Runtime for Xena v1

Status: Accepted  
Date: 2026-03-07

## Context

Xena v1 needs a deterministic serverless runtime for stateless, single-shot agents that can:
- fan out child work safely
- retry failed runs without losing lineage
- rebuild fresh context on re-entry
- support adaptive memory without turning hidden chat state into system truth

The runtime also needs to support a business operating system with many role-specialized agents working across multiple businesses and projects.

## Decision

Xena v1 will use a Trigger-first runtime:
- TypeScript and Node.js runtime
- Trigger.dev as the serverless execution substrate
- Postgres as the durable system of record
- object storage for artifacts
- lexical search plus vector retrieval for memory recall

The runtime model remains stateless and single-shot:
- one Trigger task execution equals one bounded agent run attempt
- Trigger handles execution, but Postgres remains the orchestration source of truth
- parent-child coordination happens through persisted tasks, events, and delegation contracts
- re-entry always rebuilds context from persisted state

Memory is a separate bounded context:
- durable truth remains in typed persistence
- adaptive memory supports retrieval and learning
- global patterns are curated and abstracted only

## Why This Was Chosen

Trigger-first fits the current spec directly:
- it matches event-triggered, serverless execution well
- it supports retries and orchestration without requiring long-lived actor identity
- it keeps the runtime boring and inspectable
- it aligns with v1's stateless, single-shot constraint

## Alternatives Considered

### Rivet-first actor runtime

Rejected for v1 because:
- it pushes the architecture toward long-lived actor identity
- that conflicts with the current stateless single-shot design
- it would force a larger rewrite of task, retry, and memory assumptions

### Hybrid Trigger + Rivet core

Rejected for v1 because:
- it adds architectural complexity before the core runtime exists
- it is unclear which system owns orchestration truth
- the current product need is deterministic workflow first, not actor-native state

## Consequences

Positive:
- simple execution model
- clear retry and lineage semantics
- good fit for serverless deployment
- strong alignment with scoped memory assembly

Negative:
- no actor-native realtime control plane in v1
- long waits must be represented by persisted state and future events
- richer collaborative or continuous processes are deferred

## Deferred

These remain possible future evolutions:
- actor-native runtime for realtime or long-lived coordination
- separate graph-backed memory relationship engine
- interactive human approval UX
- polyglot runtime support
