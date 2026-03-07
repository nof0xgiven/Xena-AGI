import { type Sql } from "postgres";

import { RUNTIME_SCHEMA } from "../db.js";

export type JsonValue =
  | { [key: string]: JsonValue }
  | JsonValue[]
  | string
  | number
  | boolean
  | null;

export type TaskRecord = {
  taskId: string;
  rootTaskId: string;
  parentTaskId: string | null;
  businessId: string;
  projectId: string;
  requestedAgentId: string;
  title: string;
  message: string;
  stateId: string;
  priority: string;
  source: string;
  sourceRef: string | null;
  createdBy: string;
  assignedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type RunRecord = {
  runId: string;
  taskId: string;
  parentRunId: string | null;
  agentId: string;
  triggerEventId: string;
  status: string;
  attempt: number;
  provider: string;
  model: string;
  reasoningEffort: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  tokenUsage: JsonValue;
  costEstimate: number | null;
  retryMetadata: JsonValue;
  resultPayload: JsonValue;
};

export type EventRecord = {
  eventId: string;
  eventType: string;
  taskId: string | null;
  runId: string | null;
  agentId: string | null;
  businessId: string | null;
  projectId: string | null;
  payload: JsonValue;
  emittedBy: string;
  correlationId: string | null;
  causationId: string | null;
  dedupeKey: string | null;
  createdAt: string;
};

export type DeadLetterRecord = {
  deadLetterId: string;
  eventId: string | null;
  taskId: string | null;
  runId: string | null;
  classification: string;
  payload: JsonValue;
  errorMessage: string;
  createdAt: string;
};

export type ArtifactRecord = {
  artifactId: string;
  taskId: string;
  runId: string;
  type: string;
  name: string;
  storageKey: string | null;
  path: string | null;
  uri: string | null;
  mimeType: string | null;
  inlinePayload: JsonValue;
  metadata: JsonValue;
  createdAt: string;
};

export type MemoryRecordEntry = {
  memoryId: string;
  memoryClass: string;
  scope: string;
  businessId: string | null;
  projectId: string | null;
  agentId: string | null;
  title: string;
  summary: string;
  content: JsonValue;
  keywords: string[];
  sourceType: string;
  sourceRef: string;
  provenance: JsonValue;
  confidence: number;
  version: number;
  supersedesMemoryId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type DelegationContractRecord = {
  delegationId: string;
  parentTaskId: string;
  parentRunId: string;
  reentryAgentId: string;
  mode: string;
  requiredChildren: { task_id: string }[];
  optionalChildren: { task_id: string }[];
  childTaskIds: string[];
  reentryObjective: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PromotionRequestRecord = {
  promotionRequestId: string;
  sourceMemoryIds: string[];
  requestedByAgentId: string;
  targetScope: string;
  abstractedTitle: string;
  abstractedContent: JsonValue;
  redactionNotes: string | null;
  provenanceRefs: string[];
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

type TaskRow = {
  task_id: string;
  root_task_id: string;
  parent_task_id: string | null;
  business_id: string;
  project_id: string;
  requested_agent_id: string;
  title: string;
  message: string;
  state_id: string;
  priority: string;
  source: string;
  source_ref: string | null;
  created_by: string;
  assigned_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type RunRow = {
  run_id: string;
  task_id: string;
  parent_run_id: string | null;
  agent_id: string;
  trigger_event_id: string;
  status: string;
  attempt: number;
  provider: string;
  model: string;
  reasoning_effort: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  token_usage: JsonValue;
  cost_estimate: number | null;
  retry_metadata: JsonValue;
  result_payload: JsonValue;
};

type EventRow = {
  event_id: string;
  event_type: string;
  task_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  business_id: string | null;
  project_id: string | null;
  payload: JsonValue;
  emitted_by: string;
  correlation_id: string | null;
  causation_id: string | null;
  dedupe_key: string | null;
  created_at: string;
};

type DeadLetterRow = {
  dead_letter_id: string;
  event_id: string | null;
  task_id: string | null;
  run_id: string | null;
  classification: string;
  payload: JsonValue;
  error_message: string;
  created_at: string;
};

type ArtifactRow = {
  artifact_id: string;
  task_id: string;
  run_id: string;
  type: string;
  name: string;
  storage_key: string | null;
  path: string | null;
  uri: string | null;
  mime_type: string | null;
  inline_payload: JsonValue;
  metadata: JsonValue;
  created_at: string;
};

type MemoryRecordRow = {
  memory_id: string;
  memory_class: string;
  scope: string;
  business_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  title: string;
  summary: string;
  content: JsonValue;
  keywords: string[];
  source_type: string;
  source_ref: string;
  provenance: JsonValue;
  confidence: number;
  version: number;
  supersedes_memory_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type DelegationContractRow = {
  delegation_id: string;
  parent_task_id: string;
  parent_run_id: string;
  reentry_agent_id: string;
  mode: string;
  required_children: JsonValue;
  optional_children: JsonValue;
  child_task_ids: string[];
  reentry_objective: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type PromotionRequestRow = {
  promotion_request_id: string;
  source_memory_ids: string[];
  requested_by_agent_id: string;
  target_scope: string;
  abstracted_title: string;
  abstracted_content: JsonValue;
  redaction_notes: string | null;
  provenance_refs: string[];
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};

function schemaName(): string {
  return `"${RUNTIME_SCHEMA}"`;
}

function toTaskRecord(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    rootTaskId: row.root_task_id,
    parentTaskId: row.parent_task_id,
    businessId: row.business_id,
    projectId: row.project_id,
    requestedAgentId: row.requested_agent_id,
    title: row.title,
    message: row.message,
    stateId: row.state_id,
    priority: row.priority,
    source: row.source,
    sourceRef: row.source_ref,
    createdBy: row.created_by,
    assignedAt: row.assigned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    parentRunId: row.parent_run_id,
    agentId: row.agent_id,
    triggerEventId: row.trigger_event_id,
    status: row.status,
    attempt: row.attempt,
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    tokenUsage: parseJsonValue(row.token_usage),
    costEstimate: row.cost_estimate,
    retryMetadata: parseJsonValue(row.retry_metadata),
    resultPayload: parseJsonValue(row.result_payload)
  };
}

function toDeadLetterRecord(row: DeadLetterRow): DeadLetterRecord {
  return {
    deadLetterId: row.dead_letter_id,
    eventId: row.event_id,
    taskId: row.task_id,
    runId: row.run_id,
    classification: row.classification,
    payload: row.payload,
    errorMessage: row.error_message,
    createdAt: row.created_at
  };
}

function toArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    taskId: row.task_id,
    runId: row.run_id,
    type: row.type,
    name: row.name,
    storageKey: row.storage_key,
    path: row.path,
    uri: row.uri,
    mimeType: row.mime_type,
    inlinePayload: parseJsonValue(row.inline_payload),
    metadata: parseJsonValue(row.metadata),
    createdAt: row.created_at
  };
}

function toMemoryRecordEntry(row: MemoryRecordRow): MemoryRecordEntry {
  return {
    memoryId: row.memory_id,
    memoryClass: row.memory_class,
    scope: row.scope,
    businessId: row.business_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    title: row.title,
    summary: row.summary,
    content: parseJsonValue(row.content),
    keywords: row.keywords,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    provenance: parseJsonValue(row.provenance),
    confidence: row.confidence,
    version: row.version,
    supersedesMemoryId: row.supersedes_memory_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toDelegationContractRecord(
  row: DelegationContractRow
): DelegationContractRecord {
  return {
    childTaskIds: row.child_task_ids,
    createdAt: row.created_at,
    delegationId: row.delegation_id,
    expiresAt: row.expires_at,
    mode: row.mode,
    optionalChildren: parseJsonValue(row.optional_children) as {
      task_id: string;
    }[],
    parentRunId: row.parent_run_id,
    parentTaskId: row.parent_task_id,
    reentryAgentId: row.reentry_agent_id,
    reentryObjective: row.reentry_objective,
    requiredChildren: parseJsonValue(row.required_children) as {
      task_id: string;
    }[],
    status: row.status,
    updatedAt: row.updated_at
  };
}

function toPromotionRequestRecord(
  row: PromotionRequestRow
): PromotionRequestRecord {
  return {
    abstractedContent: parseJsonValue(row.abstracted_content),
    abstractedTitle: row.abstracted_title,
    createdAt: row.created_at,
    promotionRequestId: row.promotion_request_id,
    provenanceRefs: row.provenance_refs,
    redactionNotes: row.redaction_notes,
    requestedByAgentId: row.requested_by_agent_id,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    sourceMemoryIds: row.source_memory_ids,
    status: row.status,
    targetScope: row.target_scope
  };
}

function parseJsonValue(value: JsonValue): JsonValue {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

export function createDurableStore(sql: Sql) {
  const schema = schemaName();

  return {
    async insertTask(task: TaskRecord): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.tasks (
            task_id,
            root_task_id,
            parent_task_id,
            business_id,
            project_id,
            requested_agent_id,
            title,
            message,
            state_id,
            priority,
            source,
            source_ref,
            created_by,
            assigned_at,
            created_at,
            updated_at,
            completed_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
          )
        `,
        [
          task.taskId,
          task.rootTaskId,
          task.parentTaskId,
          task.businessId,
          task.projectId,
          task.requestedAgentId,
          task.title,
          task.message,
          task.stateId,
          task.priority,
          task.source,
          task.sourceRef,
          task.createdBy,
          task.assignedAt,
          task.createdAt,
          task.updatedAt,
          task.completedAt
        ]
      );
    },

    async insertRun(run: RunRecord): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.runs (
            run_id,
            task_id,
            parent_run_id,
            agent_id,
            trigger_event_id,
            status,
            attempt,
            provider,
            model,
            reasoning_effort,
            started_at,
            completed_at,
            duration_ms,
            token_usage,
            cost_estimate,
            retry_metadata,
            result_payload
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17::jsonb
          )
        `,
        [
          run.runId,
          run.taskId,
          run.parentRunId,
          run.agentId,
          run.triggerEventId,
          run.status,
          run.attempt,
          run.provider,
          run.model,
          run.reasoningEffort,
          run.startedAt,
          run.completedAt,
          run.durationMs,
          run.tokenUsage === null ? null : JSON.stringify(run.tokenUsage),
          run.costEstimate,
          run.retryMetadata === null ? null : JSON.stringify(run.retryMetadata),
          run.resultPayload === null ? null : JSON.stringify(run.resultPayload)
        ]
      );
    },

    async insertEvent(event: EventRecord): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.events (
            event_id,
            event_type,
            task_id,
            run_id,
            agent_id,
            business_id,
            project_id,
            payload,
            emitted_by,
            correlation_id,
            causation_id,
            dedupe_key,
            created_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13
          )
        `,
        [
          event.eventId,
          event.eventType,
          event.taskId,
          event.runId,
          event.agentId,
          event.businessId,
          event.projectId,
          JSON.stringify(event.payload),
          event.emittedBy,
          event.correlationId,
          event.causationId,
          event.dedupeKey,
          event.createdAt
        ]
      );
    },

    async getTask(taskId: string): Promise<TaskRecord | null> {
      const rows = await sql.unsafe<TaskRow[]>(
        `
          select *
          from ${schema}.tasks
          where task_id = $1
          limit 1
        `,
        [taskId]
      );

      return rows[0] ? toTaskRecord(rows[0]) : null;
    },

    async updateTaskState(input: {
      taskId: string;
      stateId: string;
      updatedAt: string;
      completedAt: string | null;
    }): Promise<void> {
      await sql.unsafe(
        `
          update ${schema}.tasks
          set state_id = $2,
              updated_at = $3,
              completed_at = $4
          where task_id = $1
        `,
        [input.taskId, input.stateId, input.updatedAt, input.completedAt]
      );
    },

    async getRun(runId: string): Promise<RunRecord | null> {
      const rows = await sql.unsafe<RunRow[]>(
        `
          select *
          from ${schema}.runs
          where run_id = $1
          limit 1
        `,
        [runId]
      );

      return rows[0] ? toRunRecord(rows[0]) : null;
    },

    async updateRunLifecycle(input: {
      runId: string;
      status: string;
      completedAt: string | null;
      durationMs: number | null;
      tokenUsage: JsonValue;
      costEstimate: number | null;
      retryMetadata: JsonValue;
      resultPayload: JsonValue;
    }): Promise<void> {
      await sql.unsafe(
        `
          update ${schema}.runs
          set status = $2,
              completed_at = $3,
              duration_ms = $4,
              token_usage = $5::jsonb,
              cost_estimate = $6,
              retry_metadata = $7::jsonb,
              result_payload = $8::jsonb
          where run_id = $1
        `,
        [
          input.runId,
          input.status,
          input.completedAt,
          input.durationMs,
          input.tokenUsage === null ? null : JSON.stringify(input.tokenUsage),
          input.costEstimate,
          input.retryMetadata === null
            ? null
            : JSON.stringify(input.retryMetadata),
          input.resultPayload === null ? null : JSON.stringify(input.resultPayload)
        ]
      );
    },

    async insertArtifact(artifact: ArtifactRecord): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.artifacts (
            artifact_id,
            task_id,
            run_id,
            type,
            name,
            storage_key,
            path,
            uri,
            mime_type,
            inline_payload,
            metadata,
            created_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12
          )
        `,
        [
          artifact.artifactId,
          artifact.taskId,
          artifact.runId,
          artifact.type,
          artifact.name,
          artifact.storageKey,
          artifact.path,
          artifact.uri,
          artifact.mimeType,
          artifact.inlinePayload === null
            ? null
            : JSON.stringify(artifact.inlinePayload),
          JSON.stringify(artifact.metadata),
          artifact.createdAt
        ]
      );
    },

    async listArtifactsForRun(runId: string): Promise<ArtifactRecord[]> {
      const rows = await sql.unsafe<ArtifactRow[]>(
        `
          select *
          from ${schema}.artifacts
          where run_id = $1
          order by created_at asc, artifact_id asc
        `,
        [runId]
      );

      return rows.map(toArtifactRecord);
    },

    async listEvents(filter: {
      eventType?: string;
      taskId?: string;
    } = {}): Promise<EventRecord[]> {
      const conditions: string[] = [];
      const values: string[] = [];

      if (filter.eventType) {
        conditions.push(`event_type = $${String(values.length + 1)}`);
        values.push(filter.eventType);
      }

      if (filter.taskId) {
        conditions.push(`task_id = $${String(values.length + 1)}`);
        values.push(filter.taskId);
      }

      const whereClause =
        conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
      const rows = await sql.unsafe<EventRow[]>(
        `
          select *
          from ${schema}.events
          ${whereClause}
          order by created_at asc, event_id asc
        `,
        values
      );

      return rows.map((row) => ({
        agentId: row.agent_id,
        businessId: row.business_id,
        causationId: row.causation_id,
        correlationId: row.correlation_id,
        createdAt: row.created_at,
        dedupeKey: row.dedupe_key,
        emittedBy: row.emitted_by,
        eventId: row.event_id,
        eventType: row.event_type,
        payload: parseJsonValue(row.payload),
        projectId: row.project_id,
        runId: row.run_id,
        taskId: row.task_id
      }));
    },

    async insertMemoryRecord(memoryRecord: MemoryRecordEntry): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.memory_records (
            memory_id,
            memory_class,
            scope,
            business_id,
            project_id,
            agent_id,
            title,
            summary,
            content,
            keywords,
            source_type,
            source_ref,
            provenance,
            confidence,
            version,
            supersedes_memory_id,
            status,
            created_at,
            updated_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19
          )
        `,
        [
          memoryRecord.memoryId,
          memoryRecord.memoryClass,
          memoryRecord.scope,
          memoryRecord.businessId,
          memoryRecord.projectId,
          memoryRecord.agentId,
          memoryRecord.title,
          memoryRecord.summary,
          JSON.stringify(memoryRecord.content),
          memoryRecord.keywords,
          memoryRecord.sourceType,
          memoryRecord.sourceRef,
          JSON.stringify(memoryRecord.provenance),
          memoryRecord.confidence,
          memoryRecord.version,
          memoryRecord.supersedesMemoryId,
          memoryRecord.status,
          memoryRecord.createdAt,
          memoryRecord.updatedAt
        ]
      );
    },

    async listMemoryRecordsBySourceRef(
      sourceRef: string
    ): Promise<MemoryRecordEntry[]> {
      const rows = await sql.unsafe<MemoryRecordRow[]>(
        `
          select *
          from ${schema}.memory_records
          where source_ref = $1
          order by created_at asc, memory_id asc
        `,
        [sourceRef]
      );

      return rows.map(toMemoryRecordEntry);
    },

    async listMemoryRecordsByIds(
      memoryIds: string[]
    ): Promise<MemoryRecordEntry[]> {
      if (memoryIds.length === 0) {
        return [];
      }

      const rows = await sql.unsafe<MemoryRecordRow[]>(
        `
          select *
          from ${schema}.memory_records
          where memory_id = any($1::text[])
          order by created_at asc, memory_id asc
        `,
        [memoryIds]
      );

      return rows.map(toMemoryRecordEntry);
    },

    async insertDelegationContract(
      delegationContract: DelegationContractRecord
    ): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.delegation_contracts (
            delegation_id,
            parent_task_id,
            parent_run_id,
            reentry_agent_id,
            mode,
            required_children,
            optional_children,
            child_task_ids,
            reentry_objective,
            status,
            expires_at,
            created_at,
            updated_at
          ) values (
            $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[], $9, $10, $11, $12, $13
          )
        `,
        [
          delegationContract.delegationId,
          delegationContract.parentTaskId,
          delegationContract.parentRunId,
          delegationContract.reentryAgentId,
          delegationContract.mode,
          JSON.stringify(delegationContract.requiredChildren),
          JSON.stringify(delegationContract.optionalChildren),
          delegationContract.childTaskIds,
          delegationContract.reentryObjective,
          delegationContract.status,
          delegationContract.expiresAt,
          delegationContract.createdAt,
          delegationContract.updatedAt
        ]
      );
    },

    async getDelegationContract(
      delegationId: string
    ): Promise<DelegationContractRecord | null> {
      const rows = await sql.unsafe<DelegationContractRow[]>(
        `
          select *
          from ${schema}.delegation_contracts
          where delegation_id = $1
          limit 1
        `,
        [delegationId]
      );

      return rows[0] ? toDelegationContractRecord(rows[0]) : null;
    },

    async findPendingDelegationByChildTaskId(
      childTaskId: string
    ): Promise<DelegationContractRecord | null> {
      const rows = await sql.unsafe<DelegationContractRow[]>(
        `
          select *
          from ${schema}.delegation_contracts
          where status = 'pending'
            and $1 = any(child_task_ids)
          order by created_at asc
          limit 1
        `,
        [childTaskId]
      );

      return rows[0] ? toDelegationContractRecord(rows[0]) : null;
    },

    async listDelegationContractsByStatus(
      status: string
    ): Promise<DelegationContractRecord[]> {
      const rows = await sql.unsafe<DelegationContractRow[]>(
        `
          select *
          from ${schema}.delegation_contracts
          where status = $1
          order by created_at asc, delegation_id asc
        `,
        [status]
      );

      return rows.map(toDelegationContractRecord);
    },

    async updateDelegationStatus(input: {
      delegationId: string;
      status: string;
      updatedAt: string;
    }): Promise<void> {
      await sql.unsafe(
        `
          update ${schema}.delegation_contracts
          set status = $2,
              updated_at = $3
          where delegation_id = $1
        `,
        [input.delegationId, input.status, input.updatedAt]
      );
    },

    async insertPromotionRequest(
      promotionRequest: PromotionRequestRecord
    ): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.promotion_requests (
            promotion_request_id,
            source_memory_ids,
            requested_by_agent_id,
            target_scope,
            abstracted_title,
            abstracted_content,
            redaction_notes,
            provenance_refs,
            status,
            reviewed_by,
            reviewed_at,
            created_at
          ) values (
            $1, $2::text[], $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10, $11, $12
          )
        `,
        [
          promotionRequest.promotionRequestId,
          promotionRequest.sourceMemoryIds,
          promotionRequest.requestedByAgentId,
          promotionRequest.targetScope,
          promotionRequest.abstractedTitle,
          JSON.stringify(promotionRequest.abstractedContent),
          promotionRequest.redactionNotes,
          promotionRequest.provenanceRefs,
          promotionRequest.status,
          promotionRequest.reviewedBy,
          promotionRequest.reviewedAt,
          promotionRequest.createdAt
        ]
      );
    },

    async getPromotionRequest(
      promotionRequestId: string
    ): Promise<PromotionRequestRecord | null> {
      const rows = await sql.unsafe<PromotionRequestRow[]>(
        `
          select *
          from ${schema}.promotion_requests
          where promotion_request_id = $1
          limit 1
        `,
        [promotionRequestId]
      );

      return rows[0] ? toPromotionRequestRecord(rows[0]) : null;
    },

    async updatePromotionRequest(input: {
      promotionRequestId: string;
      reviewedAt: string | null;
      reviewedBy: string | null;
      status: string;
    }): Promise<void> {
      await sql.unsafe(
        `
          update ${schema}.promotion_requests
          set status = $2,
              reviewed_by = $3,
              reviewed_at = $4
          where promotion_request_id = $1
        `,
        [
          input.promotionRequestId,
          input.status,
          input.reviewedBy,
          input.reviewedAt
        ]
      );
    },

    async listTaskLineage(rootTaskId: string): Promise<{
      tasks: TaskRecord[];
      runs: RunRecord[];
    }> {
      const tasks = await sql.unsafe<TaskRow[]>(
        `
          select *
          from ${schema}.tasks
          where root_task_id = $1
             or task_id = $1
          order by created_at asc
        `,
        [rootTaskId]
      );
      const runs = await sql.unsafe<RunRow[]>(
        `
          select runs.*
          from ${schema}.runs as runs
          inner join ${schema}.tasks as tasks
            on tasks.task_id = runs.task_id
          where tasks.root_task_id = $1
             or tasks.task_id = $1
          order by runs.started_at asc
        `,
        [rootTaskId]
      );

      return {
        tasks: tasks.map(toTaskRecord),
        runs: runs.map(toRunRecord)
      };
    },

    async insertDeadLetter(deadLetter: DeadLetterRecord): Promise<void> {
      await sql.unsafe(
        `
          insert into ${schema}.dead_letters (
            dead_letter_id,
            event_id,
            task_id,
            run_id,
            classification,
            payload,
            error_message,
            created_at
          ) values (
            $1, $2, $3, $4, $5, $6::jsonb, $7, $8
          )
        `,
        [
          deadLetter.deadLetterId,
          deadLetter.eventId,
          deadLetter.taskId,
          deadLetter.runId,
          deadLetter.classification,
          JSON.stringify(deadLetter.payload),
          deadLetter.errorMessage,
          deadLetter.createdAt
        ]
      );
    },

    async getDeadLetter(deadLetterId: string): Promise<DeadLetterRecord | null> {
      const rows = await sql.unsafe<DeadLetterRow[]>(
        `
          select *
          from ${schema}.dead_letters
          where dead_letter_id = $1
          limit 1
        `,
        [deadLetterId]
      );

      return rows[0] ? toDeadLetterRecord(rows[0]) : null;
    }
  };
}

export type DurableStore = ReturnType<typeof createDurableStore>;
