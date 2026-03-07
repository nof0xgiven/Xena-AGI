import { describe, expect, it } from "vitest";

import {
  AgentDefinitionSchema,
  AgentResultSchema,
  AgentInvocationPayloadSchema,
  AgentOutcomeEnum,
  ArtifactSchema,
  ArtifactTypeEnum,
  ContextBundleSchema,
  DelegationContractSchema,
  DelegationStateEnum,
  EventSchema,
  MemoryClassEnum,
  MemoryPromotionRequestSchema,
  MemoryQuerySchema,
  MemoryRecordSchema,
  MemoryScopeEnum,
  RunSchema,
  RunStateEnum,
  SCHEMA_VERSION,
  SpawnRequestSchema,
  TaskSchema,
  TaskStateEnum,
  WebhookEnvelopeSchema,
  validateLineageChain
} from "../../../src/contracts/index.js";

const webhookEnvelope = {
  schema_version: SCHEMA_VERSION,
  ingress_id: "ingress_123",
  event_type: "task.created",
  idempotency_key: "idem_123",
  business_id: "biz_123",
  project_id: "proj_123",
  task_id: null,
  agent_id: "agent_supervisor",
  payload: {
    body: "hello"
  },
  emitted_by: "external.crm",
  external_event_id: "ext_123",
  received_at: "2026-03-07T09:00:00.000Z"
} as const;

const agentDefinition = {
  schema_version: SCHEMA_VERSION,
  agent_id: "agent_supervisor",
  version: "1.0.0",
  name: "Supervisor",
  description: "Coordinates work",
  domain: "ops",
  role_type: "supervisor",
  reports_to: null,
  allowed_delegate_to: ["agent_worker"],
  provider: "openai",
  model: "gpt-5",
  reasoning_effort: "medium",
  system_prompt_ref: "prompts/supervisor.md",
  tools: ["spawn_task"],
  skills: ["analysis"],
  execution_mode: "single_shot",
  supervisor_mode: true,
  output_schema_ref: "contracts/agent-result.json",
  timeout_ms: 120000,
  max_tool_calls: 8,
  enabled: true,
  created_at: "2026-03-07T09:00:00.000Z",
  updated_at: "2026-03-07T09:00:00.000Z"
} as const;

const rootTask = {
  schema_version: SCHEMA_VERSION,
  task_id: "task_root",
  root_task_id: "task_root",
  parent_task_id: null,
  business_id: "biz_123",
  project_id: "proj_123",
  requested_agent_id: "agent_supervisor",
  title: "Root task",
  message: "Handle the request",
  state_id: "created",
  priority: "high",
  source: "webhook",
  source_ref: null,
  created_by: "system",
  assigned_at: null,
  created_at: "2026-03-07T09:00:00.000Z",
  updated_at: "2026-03-07T09:00:00.000Z",
  completed_at: null
} as const;

const childTask = {
  ...rootTask,
  task_id: "task_child",
  root_task_id: "task_root",
  parent_task_id: "task_root",
  title: "Child task"
} as const;

const run = {
  schema_version: SCHEMA_VERSION,
  run_id: "run_123",
  task_id: rootTask.task_id,
  parent_run_id: null,
  agent_id: "agent_supervisor",
  trigger_event_id: "evt_123",
  status: "queued",
  attempt: 1,
  provider: "openai",
  model: "gpt-5",
  reasoning_effort: "medium",
  started_at: "2026-03-07T09:00:00.000Z",
  completed_at: null,
  duration_ms: null,
  token_usage: null,
  cost_estimate: null
} as const;

const event = {
  schema_version: SCHEMA_VERSION,
  event_id: "evt_123",
  event_type: "task.created",
  task_id: rootTask.task_id,
  run_id: run.run_id,
  agent_id: "agent_supervisor",
  business_id: "biz_123",
  project_id: "proj_123",
  payload: {
    task_id: rootTask.task_id
  },
  emitted_by: "xena.ingress",
  correlation_id: "evt_group_123",
  causation_id: null,
  dedupe_key: "idem_123",
  created_at: "2026-03-07T09:00:00.000Z"
} as const;

const artifact = {
  schema_version: SCHEMA_VERSION,
  artifact_id: "artifact_123",
  task_id: rootTask.task_id,
  run_id: run.run_id,
  type: "report",
  name: "summary.md",
  path: "artifacts/summary.md",
  uri: null,
  mime_type: "text/markdown",
  inline_payload: null,
  metadata: {},
  created_at: "2026-03-07T09:00:00.000Z"
} as const;

const memoryRecord = {
  schema_version: SCHEMA_VERSION,
  memory_id: "memory_123",
  memory_class: "semantic",
  scope: "project",
  business_id: "biz_123",
  project_id: "proj_123",
  agent_id: null,
  title: "Useful fact",
  summary: "Important project fact",
  content: {
    value: "fact"
  },
  keywords: ["project", "fact"],
  source_type: "run_result",
  source_ref: "run_123",
  provenance: [
    {
      task_id: rootTask.task_id
    }
  ],
  confidence: 0.9,
  version: 1,
  supersedes_memory_id: null,
  status: "active",
  created_at: "2026-03-07T09:00:00.000Z",
  updated_at: "2026-03-07T09:00:00.000Z"
} as const;

const contextBundle = {
  schema_version: SCHEMA_VERSION,
  context_bundle_id: "ctx_123",
  task: rootTask,
  run,
  business: {
    business_id: "biz_123"
  },
  project: {
    project_id: "proj_123"
  },
  related_memory: [memoryRecord],
  related_artifacts: [artifact],
  related_people: [],
  constraints: ["single_shot"],
  objective: "Complete the task",
  memory_scope_order: ["project", "business", "agent", "global_patterns"],
  generated_at: "2026-03-07T09:00:00.000Z"
} as const;

const spawnRequest = {
  tool_name: "spawn_task",
  target_agent_id: "agent_writer",
  title: "Write copy",
  message: "Draft the copy",
  required: true,
  priority: "high",
  context_overrides: null,
  expected_output: {
    format: "markdown"
  },
  tags: ["marketing"]
} as const;

const delegationContract = {
  schema_version: SCHEMA_VERSION,
  delegation_id: "delegation_123",
  parent_task_id: rootTask.task_id,
  parent_run_id: run.run_id,
  reentry_agent_id: "agent_supervisor",
  mode: "barrier",
  required_children: [{ task_id: childTask.task_id }],
  optional_children: [],
  child_task_ids: [childTask.task_id],
  reentry_objective: "Synthesize the child result",
  status: "pending",
  expires_at: null,
  created_at: "2026-03-07T09:00:00.000Z",
  updated_at: "2026-03-07T09:00:00.000Z"
} as const;

const agentResult = {
  schema_version: SCHEMA_VERSION,
  run_id: run.run_id,
  task_id: rootTask.task_id,
  agent_id: "agent_supervisor",
  summary: "Completed successfully",
  state_id: "completed",
  outcome: "success",
  result: {
    ok: true
  },
  artifacts: [artifact],
  spawn: [spawnRequest],
  reentry_mode: null,
  reentry_objective: null,
  errors: [],
  memory_writes: [memoryRecord],
  completed_at: "2026-03-07T09:00:00.000Z"
} as const;

const agentInvocationPayload = {
  schema_version: SCHEMA_VERSION,
  run_id: run.run_id,
  task_id: rootTask.task_id,
  agent: agentDefinition,
  context_bundle: contextBundle,
  tool_registry: [
    {
      name: "spawn_task"
    }
  ],
  constraints: {
    max_tool_calls: 8
  },
  prompt: {
    system: "You are a supervisor",
    user: "Complete the task"
  }
} as const;

const memoryQuery = {
  schema_version: SCHEMA_VERSION,
  query_id: "memqry_123",
  requester_agent_id: "agent_supervisor",
  task_id: rootTask.task_id,
  business_id: "biz_123",
  project_id: "proj_123",
  query_text: "project fact",
  scope_order: ["project", "business", "agent", "global_patterns"],
  allowed_classes: ["semantic", "episodic"],
  max_results: 5,
  include_global_patterns: true,
  include_provenance: true,
  created_at: "2026-03-07T09:00:00.000Z"
} as const;

const memoryPromotionRequest = {
  schema_version: SCHEMA_VERSION,
  promotion_request_id: "promote_123",
  source_memory_ids: [memoryRecord.memory_id],
  requested_by_agent_id: "agent_supervisor",
  target_scope: "global_patterns",
  abstracted_title: "How to summarize project facts",
  abstracted_content: {
    summary_pattern: "abstracted"
  },
  redaction_notes: null,
  provenance_refs: [memoryRecord.memory_id],
  status: "pending_review",
  reviewed_by: null,
  reviewed_at: null,
  created_at: "2026-03-07T09:00:00.000Z"
} as const;

const allContractCases = [
  ["WebhookEnvelope", WebhookEnvelopeSchema, webhookEnvelope],
  ["AgentDefinition", AgentDefinitionSchema, agentDefinition],
  ["Task", TaskSchema, rootTask],
  ["Run", RunSchema, run],
  ["Event", EventSchema, event],
  ["ContextBundle", ContextBundleSchema, contextBundle],
  ["Artifact", ArtifactSchema, artifact],
  ["DelegationContract", DelegationContractSchema, delegationContract],
  ["AgentResult", AgentResultSchema, agentResult],
  ["AgentInvocationPayload", AgentInvocationPayloadSchema, agentInvocationPayload],
  ["SpawnRequest", SpawnRequestSchema, spawnRequest],
  ["MemoryRecord", MemoryRecordSchema, memoryRecord],
  ["MemoryQuery", MemoryQuerySchema, memoryQuery],
  ["MemoryPromotionRequest", MemoryPromotionRequestSchema, memoryPromotionRequest]
] as const;

const versionedContractCases = allContractCases.filter(
  ([name]) => name !== "SpawnRequest"
);

describe("contract schemas", () => {
  it("exposes the documented enum values", () => {
    expect(TaskStateEnum.options).toEqual([
      "created",
      "backlog",
      "in_progress",
      "awaiting_subtasks",
      "awaiting_review",
      "qa_validation",
      "completed",
      "failed",
      "blocked"
    ]);
    expect(RunStateEnum.options).toEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "retrying",
      "timed_out",
      "cancelled"
    ]);
    expect(DelegationStateEnum.options).toEqual([
      "pending",
      "satisfied",
      "failed",
      "expired"
    ]);
    expect(AgentOutcomeEnum.options).toEqual([
      "success",
      "delegated",
      "blocked",
      "failed",
      "needs_review"
    ]);
    expect(ArtifactTypeEnum.options).toEqual([
      "file",
      "json",
      "report",
      "log",
      "url",
      "image",
      "diff",
      "transcript"
    ]);
    expect(MemoryClassEnum.options).toEqual([
      "episodic",
      "semantic",
      "procedural",
      "working"
    ]);
    expect(MemoryScopeEnum.options).toEqual([
      "business",
      "project",
      "agent",
      "global_patterns"
    ]);
  });

  it.each(allContractCases)("accepts a valid %s payload", (_name, schema, payload) => {
    expect(schema.parse(payload)).toEqual(payload);
  });

  it.each(allContractCases)(
    "rejects unknown fields for %s payloads",
    (_name, schema, payload) => {
      const parsed = schema.safeParse({ ...payload, unexpected: true });

      expect(parsed.success).toBe(false);
    }
  );

  it.each(versionedContractCases)(
    "rejects unsupported schema versions for %s payloads",
    (_name, schema, payload) => {
      const parsed = schema.safeParse({ ...payload, schema_version: "2.0" });

      expect(parsed.success).toBe(false);
    }
  );

  it("rejects invalid artifact reference shapes", () => {
    expect(
      ArtifactSchema.safeParse({
        ...artifact,
        path: null,
        uri: null,
        inline_payload: null
      }).success
    ).toBe(false);

    expect(
      ArtifactSchema.safeParse({
        ...artifact,
        uri: "https://example.com/file.txt"
      }).success
    ).toBe(false);
  });

  it("rejects persisted working memory", () => {
    expect(
      MemoryRecordSchema.safeParse({
        ...memoryRecord,
        memory_class: "working"
      }).success
    ).toBe(false);
  });

  it("rejects non-global promotion targets", () => {
    expect(
      MemoryPromotionRequestSchema.safeParse({
        ...memoryPromotionRequest,
        target_scope: "project"
      }).success
    ).toBe(false);
  });

  it("validates task lineage chains", () => {
    expect(() => {
      validateLineageChain([rootTask, childTask]);
    }).not.toThrow();

    expect(() => {
      validateLineageChain([
        rootTask,
        {
          ...childTask,
          root_task_id: "task_missing_root"
        }
      ]);
    }).toThrowError(/root_task_id/i);

    expect(() => {
      validateLineageChain([
        rootTask,
        {
          ...childTask,
          parent_task_id: "task_missing_parent"
        }
      ]);
    }).toThrowError(/parent_task_id/i);
  });
});
