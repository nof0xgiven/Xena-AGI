import { z } from "zod";

import {
  AgentIdSchema,
  ArtifactIdSchema,
  ContextBundleIdSchema,
  DateTimeSchema,
  DelegationIdSchema,
  EventIdSchema,
  IngressIdSchema,
  JsonObjectSchema,
  LooseObjectSchema,
  MemoryIdSchema,
  MemoryQueryIdSchema,
  NonEmptyStringSchema,
  PromotionRequestIdSchema,
  RunIdSchema,
  SchemaVersionSchema,
  TaskIdSchema,
  nullablePrefixedId
} from "./common.js";
import {
  AgentOutcomeEnum,
  AgentRoleTypeEnum,
  ArtifactTypeEnum,
  DelegationStateEnum,
  ExecutionModeEnum,
  MemoryClassEnum,
  MemoryScopeEnum,
  RunStateEnum,
  SCHEMA_VERSION,
  TaskStateEnum
} from "./enums.js";

const NullableStringSchema = NonEmptyStringSchema.nullable();

const ChildTaskRefSchema = z.looseObject({
  task_id: TaskIdSchema
});

export const WebhookEnvelopeSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  ingress_id: IngressIdSchema,
  event_type: NonEmptyStringSchema,
  idempotency_key: NonEmptyStringSchema,
  business_id: NullableStringSchema,
  project_id: NullableStringSchema,
  task_id: nullablePrefixedId("task_"),
  agent_id: nullablePrefixedId("agent_"),
  payload: JsonObjectSchema,
  emitted_by: NonEmptyStringSchema,
  external_event_id: NullableStringSchema,
  received_at: DateTimeSchema
});

export const AgentDefinitionSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  agent_id: AgentIdSchema,
  version: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  domain: NonEmptyStringSchema,
  role_type: AgentRoleTypeEnum,
  reports_to: nullablePrefixedId("agent_"),
  allowed_delegate_to: z.array(AgentIdSchema),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  reasoning_effort: NonEmptyStringSchema,
  system_prompt_ref: NonEmptyStringSchema,
  tools: z.array(NonEmptyStringSchema),
  skills: z.array(NonEmptyStringSchema),
  execution_mode: ExecutionModeEnum,
  supervisor_mode: z.boolean(),
  output_schema_ref: NullableStringSchema,
  timeout_ms: z.number().int().positive(),
  max_tool_calls: z.number().int().nonnegative(),
  enabled: z.boolean(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema
});

export const TaskSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  task_id: TaskIdSchema,
  root_task_id: TaskIdSchema,
  parent_task_id: nullablePrefixedId("task_"),
  business_id: NonEmptyStringSchema,
  project_id: NonEmptyStringSchema,
  requested_agent_id: AgentIdSchema,
  title: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  state_id: TaskStateEnum,
  priority: NonEmptyStringSchema,
  source: NonEmptyStringSchema,
  source_ref: NullableStringSchema,
  created_by: NonEmptyStringSchema,
  assigned_at: DateTimeSchema.nullable(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  completed_at: DateTimeSchema.nullable()
});

export const RunSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  parent_run_id: nullablePrefixedId("run_"),
  agent_id: AgentIdSchema,
  trigger_event_id: EventIdSchema,
  status: RunStateEnum,
  attempt: z.number().int().positive(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  reasoning_effort: NonEmptyStringSchema,
  started_at: DateTimeSchema,
  completed_at: DateTimeSchema.nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  token_usage: LooseObjectSchema.nullable(),
  cost_estimate: z.number().nullable()
});

export const EventSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  event_id: EventIdSchema,
  event_type: NonEmptyStringSchema,
  task_id: nullablePrefixedId("task_"),
  run_id: nullablePrefixedId("run_"),
  agent_id: nullablePrefixedId("agent_"),
  business_id: NullableStringSchema,
  project_id: NullableStringSchema,
  payload: JsonObjectSchema,
  emitted_by: NonEmptyStringSchema,
  correlation_id: NullableStringSchema,
  causation_id: NullableStringSchema,
  dedupe_key: NullableStringSchema,
  created_at: DateTimeSchema
});

export const ArtifactSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    artifact_id: ArtifactIdSchema,
    task_id: TaskIdSchema,
    run_id: RunIdSchema,
    type: ArtifactTypeEnum,
    name: NonEmptyStringSchema,
    path: NullableStringSchema,
    uri: z.url().nullable(),
    mime_type: NullableStringSchema,
    inline_payload: z.union([LooseObjectSchema, NonEmptyStringSchema]).nullable(),
    metadata: LooseObjectSchema,
    created_at: DateTimeSchema
  })
  .superRefine((value, context) => {
    const references = [value.path, value.uri, value.inline_payload].filter(
      (candidate) => candidate !== null
    );

    if (references.length !== 1) {
      context.addIssue({
        code: "custom",
        message:
          "Artifact must provide exactly one of path, uri, or inline_payload"
      });
    }
  });

export const MemoryRecordSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    memory_id: MemoryIdSchema,
    memory_class: MemoryClassEnum,
    scope: MemoryScopeEnum,
    business_id: NullableStringSchema,
    project_id: NullableStringSchema,
    agent_id: nullablePrefixedId("agent_"),
    title: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    content: z.union([LooseObjectSchema, NonEmptyStringSchema]),
    keywords: z.array(NonEmptyStringSchema),
    source_type: NonEmptyStringSchema,
    source_ref: NonEmptyStringSchema,
    provenance: z.array(LooseObjectSchema),
    confidence: z.number().min(0).max(1),
    version: z.number().int().positive(),
    supersedes_memory_id: nullablePrefixedId("memory_"),
    status: NonEmptyStringSchema,
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema
  })
  .superRefine((value, context) => {
    if (value.memory_class === "working") {
      context.addIssue({
        code: "custom",
        message: "working memory cannot be persisted as a durable MemoryRecord"
      });
    }
  });

export const ContextBundleSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  context_bundle_id: ContextBundleIdSchema,
  task: TaskSchema,
  run: RunSchema,
  business: LooseObjectSchema,
  project: LooseObjectSchema,
  related_memory: z.array(MemoryRecordSchema),
  related_artifacts: z.array(ArtifactSchema),
  related_people: z.array(LooseObjectSchema),
  constraints: z.array(NonEmptyStringSchema),
  objective: NonEmptyStringSchema,
  memory_scope_order: z.array(MemoryScopeEnum),
  generated_at: DateTimeSchema
});

export const SpawnRequestSchema = z.strictObject({
  tool_name: NonEmptyStringSchema,
  target_agent_id: AgentIdSchema,
  title: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  required: z.boolean(),
  priority: NonEmptyStringSchema,
  context_overrides: LooseObjectSchema.nullable(),
  expected_output: LooseObjectSchema.nullable(),
  tags: z.array(NonEmptyStringSchema)
});

export const DelegationContractSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  delegation_id: DelegationIdSchema,
  parent_task_id: TaskIdSchema,
  parent_run_id: RunIdSchema,
  reentry_agent_id: AgentIdSchema,
  mode: NonEmptyStringSchema,
  required_children: z.array(ChildTaskRefSchema),
  optional_children: z.array(ChildTaskRefSchema),
  child_task_ids: z.array(TaskIdSchema),
  reentry_objective: NonEmptyStringSchema,
  status: DelegationStateEnum,
  expires_at: DateTimeSchema.nullable(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema
});

export const AgentResultSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  agent_id: AgentIdSchema,
  summary: NonEmptyStringSchema,
  state_id: TaskStateEnum,
  outcome: AgentOutcomeEnum,
  result: LooseObjectSchema.nullable(),
  artifacts: z.array(ArtifactSchema),
  spawn: z.array(SpawnRequestSchema),
  reentry_mode: NullableStringSchema,
  reentry_objective: NullableStringSchema,
  errors: z.array(LooseObjectSchema),
  memory_writes: z.array(MemoryRecordSchema),
  completed_at: DateTimeSchema
});

export const AgentInvocationPayloadSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  agent: AgentDefinitionSchema,
  context_bundle: ContextBundleSchema,
  tool_registry: z.array(LooseObjectSchema),
  constraints: LooseObjectSchema,
  prompt: LooseObjectSchema
});

export const MemoryQuerySchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  query_id: MemoryQueryIdSchema,
  requester_agent_id: AgentIdSchema,
  task_id: nullablePrefixedId("task_"),
  business_id: NullableStringSchema,
  project_id: NullableStringSchema,
  query_text: NonEmptyStringSchema,
  scope_order: z.array(MemoryScopeEnum),
  allowed_classes: z.array(MemoryClassEnum),
  max_results: z.number().int().positive(),
  include_global_patterns: z.boolean(),
  include_provenance: z.boolean(),
  created_at: DateTimeSchema
});

export const MemoryPromotionRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  promotion_request_id: PromotionRequestIdSchema,
  source_memory_ids: z.array(MemoryIdSchema).min(1),
  requested_by_agent_id: AgentIdSchema,
  target_scope: z.literal("global_patterns"),
  abstracted_title: NonEmptyStringSchema,
  abstracted_content: z.union([LooseObjectSchema, NonEmptyStringSchema]),
  redaction_notes: NullableStringSchema,
  provenance_refs: z.array(NonEmptyStringSchema),
  status: NonEmptyStringSchema,
  reviewed_by: NullableStringSchema,
  reviewed_at: DateTimeSchema.nullable(),
  created_at: DateTimeSchema
});

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;
type Task = z.infer<typeof TaskSchema>;

export function validateLineageChain(candidateTasks: readonly Task[]): void {
  const tasks = TaskSchema.array().parse(candidateTasks);
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));

  for (const task of tasks) {
    if (task.parent_task_id === null) {
      if (task.root_task_id !== task.task_id) {
        throw new Error(
          `root_task_id must equal task_id for root tasks: ${task.task_id}`
        );
      }

      continue;
    }

    if (!taskById.has(task.parent_task_id)) {
      throw new Error(
        `parent_task_id must reference an existing task: ${task.parent_task_id}`
      );
    }

    const rootTask = taskById.get(task.root_task_id);

    if (!rootTask) {
      throw new Error(
        `root_task_id must reference an existing task: ${task.root_task_id}`
      );
    }

    if (rootTask.parent_task_id !== null) {
      throw new Error(`root_task_id must point at a root task: ${task.root_task_id}`);
    }

    const seen = new Set<string>();
    let current: Task | undefined = task;

    while (current.parent_task_id !== null) {
      if (seen.has(current.task_id)) {
        throw new Error(`lineage contains a cycle at task_id ${current.task_id}`);
      }

      seen.add(current.task_id);
      current = taskById.get(current.parent_task_id);

      if (!current) {
        throw new Error(
          `parent_task_id must reference an existing task: ${task.parent_task_id}`
        );
      }
    }

    if (current.task_id !== task.root_task_id) {
      throw new Error(
        `root_task_id must match the root ancestor for task ${task.task_id}`
      );
    }
  }
}

export {
  AgentOutcomeEnum,
  ArtifactTypeEnum,
  DelegationStateEnum,
  MemoryClassEnum,
  MemoryScopeEnum,
  SCHEMA_VERSION,
  RunStateEnum,
  TaskStateEnum
};
