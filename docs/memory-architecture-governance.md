# Xena v1 Memory Architecture and Governance

This document defines how memory works in Xena v1. It complements the runtime behavior in [specification.md](/Users/ava/main/projects/openSource/xena/specification.md) and the canonical contracts in [companion-schema.md](/Users/ava/main/projects/openSource/xena/companion-schema.md).

## 1. Design Principles

- business truth belongs in durable typed storage, not hidden model memory
- memory improves retrieval and learning, but does not replace orchestration state
- local scopes outrank global patterns
- cross-business learning must be abstracted, curated, and provenance-preserving
- memory writes must be explainable and reversible

## 2. Layered Memory Model

### Ground Truth

Stored in Postgres and object storage:
- tasks
- runs
- events
- artifacts
- business and project entities

This is the canonical system of record.

### Retrieval Memory

Used to improve recall during context assembly:
- lexical recall for exact identifiers, transcript fragments, and precise phrasing
- semantic recall for concept-level similarity

### Consolidated Knowledge

Derived after task completion:
- semantic facts and stable relationships
- procedural playbooks and heuristics
- useful episodic summaries

### Working Memory

The per-run `ContextBundle` only:
- assembled fresh for each invocation
- never treated as hidden durable memory

## 3. Memory Classes

- `episodic`: prior run outcomes, summaries, experiments, transcripts
- `semantic`: extracted facts, entities, relationships, durable reference knowledge
- `procedural`: SOPs, playbooks, heuristics, tactics
- `working`: transient per-run assembled context

## 4. Memory Scopes

- `project`: work specific to one project
- `business`: broader company context and reusable company-specific knowledge
- `agent`: role-specific personal heuristics and preferences
- `global_patterns`: cross-business abstract patterns only

Scope rules:
- project and business memory are tenant-local
- agent memory is still tenant-safe when it references local work
- `global_patterns` never stores raw business facts, customers, or project artifacts

## 5. Retrieval Precedence

The context builder queries memory in this order:

1. task-linked artifacts and prior outputs
2. project memory
3. business memory
4. agent memory
5. `global_patterns`

Rationale:
- local truth is more accurate than generalized pattern recall
- agent preferences should not override business truth
- global pattern recall is a late assist, not a first answer

## 6. Storage Strategy

v1 storage model:
- Postgres for durable truth and typed memory records
- object storage for large artifacts and transcripts
- Postgres FTS or BM25-style indexing for exact recall
- `pgvector` or equivalent vector index for semantic search

Deliberately deferred:
- separate graph database
- fully actor-native memory system
- direct adoption of an external memory framework as the canonical store

## 7. Write Paths

### From Agent Runs

Agents may emit:
- artifacts
- local memory candidates
- structured run results

Agents may not write directly to `global_patterns`.

### From Consolidation Jobs

Trigger-driven jobs may:
- summarize runs into episodic memory
- extract facts into semantic memory
- extract reusable procedures into procedural memory
- create promotion candidates for curator review

## 8. Promotion Workflow

Promotion from local memory to `global_patterns` is curated.

Steps:
1. local memory records or task outcomes produce a promotion candidate
2. candidate is abstracted and redacted
3. curator flow reviews the candidate
4. approved candidate becomes a `global_patterns` memory record
5. provenance links back to the local source memory IDs and task lineage

Rejection outcomes:
- remain local only
- mark superseded
- discard as low-signal or unsafe

## 9. Governance Rules

- no raw business facts may cross business boundaries
- no direct global writes from regular agents
- every promoted record must preserve provenance
- every promoted record must be abstracted enough to be business-agnostic
- memory retrieval must log the scopes and classes used
- operators must be able to inspect promotion decisions

## 10. External References and What We Borrowed

Xena v1 borrows ideas from several references without adopting any of them as the system of record:

- [Searchable Agent Memory](https://eric-tramel.github.io/blog/2026-02-07-searchable-agent-memory/): lexical and transcript-oriented retrieval patterns
- [DiffMem](https://github.com/Growth-Kinetics/DiffMem): differential summaries and "what changed" memory style
- [Google always-on memory agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent): background consolidation and memory maintenance workflows
- [Mnemosyne](https://github.com/28naem-del/mnemosyne): adaptive multi-agent memory concepts
- [HawkinsDB](https://github.com/harishsg993010/HawkinsDB): clear separation of episodic, semantic, and procedural memory types

Xena does not adopt any one of these wholesale for v1. The platform keeps its canonical truth in Postgres and object storage, then layers retrieval and consolidation on top.
