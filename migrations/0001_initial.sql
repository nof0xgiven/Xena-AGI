create schema if not exists xena_runtime;

create table if not exists xena_runtime.tasks (
  task_id text primary key,
  root_task_id text not null,
  parent_task_id text null,
  business_id text not null,
  project_id text not null,
  requested_agent_id text not null,
  title text not null,
  message text not null,
  state_id text not null,
  priority text not null,
  source text not null,
  source_ref text null,
  created_by text not null,
  assigned_at timestamptz null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz null
);

create index if not exists tasks_root_task_id_idx
  on xena_runtime.tasks (root_task_id);

create index if not exists tasks_parent_task_id_idx
  on xena_runtime.tasks (parent_task_id);

create index if not exists tasks_business_project_idx
  on xena_runtime.tasks (business_id, project_id);

create table if not exists xena_runtime.runs (
  run_id text primary key,
  task_id text not null references xena_runtime.tasks (task_id) on delete cascade,
  parent_run_id text null references xena_runtime.runs (run_id) on delete set null,
  agent_id text not null,
  trigger_event_id text not null,
  status text not null,
  attempt integer not null,
  provider text not null,
  model text not null,
  reasoning_effort text not null,
  started_at timestamptz not null,
  completed_at timestamptz null,
  duration_ms integer null,
  token_usage jsonb null,
  cost_estimate numeric null,
  retry_metadata jsonb null,
  result_payload jsonb null
);

create index if not exists runs_task_id_idx
  on xena_runtime.runs (task_id);

create index if not exists runs_parent_run_id_idx
  on xena_runtime.runs (parent_run_id);

create unique index if not exists runs_trigger_event_attempt_idx
  on xena_runtime.runs (trigger_event_id, attempt);

create table if not exists xena_runtime.events (
  event_id text primary key,
  event_type text not null,
  task_id text null references xena_runtime.tasks (task_id) on delete set null,
  run_id text null references xena_runtime.runs (run_id) on delete set null,
  agent_id text null,
  business_id text null,
  project_id text null,
  payload jsonb not null,
  emitted_by text not null,
  correlation_id text null,
  causation_id text null,
  dedupe_key text null,
  created_at timestamptz not null
);

create unique index if not exists events_dedupe_key_idx
  on xena_runtime.events (dedupe_key)
  where dedupe_key is not null;

create index if not exists events_task_run_idx
  on xena_runtime.events (task_id, run_id);

create table if not exists xena_runtime.artifacts (
  artifact_id text primary key,
  task_id text not null references xena_runtime.tasks (task_id) on delete cascade,
  run_id text not null references xena_runtime.runs (run_id) on delete cascade,
  type text not null,
  name text not null,
  storage_key text null,
  path text null,
  uri text null,
  mime_type text null,
  inline_payload jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create index if not exists artifacts_task_run_idx
  on xena_runtime.artifacts (task_id, run_id);

create table if not exists xena_runtime.delegation_contracts (
  delegation_id text primary key,
  parent_task_id text not null references xena_runtime.tasks (task_id) on delete cascade,
  parent_run_id text not null references xena_runtime.runs (run_id) on delete cascade,
  reentry_agent_id text not null,
  mode text not null,
  required_children jsonb not null default '[]'::jsonb,
  optional_children jsonb not null default '[]'::jsonb,
  child_task_ids text[] not null default '{}',
  reentry_objective text not null,
  status text not null,
  expires_at timestamptz null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists delegation_parent_task_idx
  on xena_runtime.delegation_contracts (parent_task_id, status);

create table if not exists xena_runtime.dead_letters (
  dead_letter_id text primary key,
  event_id text null references xena_runtime.events (event_id) on delete set null,
  task_id text null references xena_runtime.tasks (task_id) on delete set null,
  run_id text null references xena_runtime.runs (run_id) on delete set null,
  classification text not null,
  payload jsonb not null,
  error_message text not null,
  created_at timestamptz not null
);

create index if not exists dead_letters_created_at_idx
  on xena_runtime.dead_letters (created_at desc);

create table if not exists xena_runtime.agent_definitions (
  agent_id text not null,
  version text not null,
  schema_version text not null,
  name text not null,
  description text not null,
  provider text not null,
  model text not null,
  reasoning_effort text not null,
  system_prompt_ref text not null,
  tools jsonb not null default '[]'::jsonb,
  skills jsonb not null default '[]'::jsonb,
  execution_mode text not null,
  supervisor_mode boolean not null,
  output_schema_ref text null,
  timeout_ms integer not null,
  max_tool_calls integer not null,
  enabled boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (agent_id, version)
);

create index if not exists agent_definitions_enabled_idx
  on xena_runtime.agent_definitions (agent_id, enabled);

create table if not exists xena_runtime.memory_records (
  memory_id text primary key,
  memory_class text not null,
  scope text not null,
  business_id text null,
  project_id text null,
  agent_id text null,
  title text not null,
  summary text not null,
  content jsonb not null,
  keywords text[] not null default '{}',
  source_type text not null,
  source_ref text not null,
  provenance jsonb not null default '[]'::jsonb,
  confidence numeric not null,
  version integer not null,
  supersedes_memory_id text null references xena_runtime.memory_records (memory_id) on delete set null,
  status text not null,
  embedding vector(1536) null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists memory_records_scope_idx
  on xena_runtime.memory_records (scope, business_id, project_id, agent_id);

create index if not exists memory_records_source_idx
  on xena_runtime.memory_records (source_type, source_ref);

create table if not exists xena_runtime.promotion_requests (
  promotion_request_id text primary key,
  source_memory_ids text[] not null default '{}',
  requested_by_agent_id text not null,
  target_scope text not null,
  abstracted_title text not null,
  abstracted_content jsonb not null,
  redaction_notes text null,
  provenance_refs text[] not null default '{}',
  status text not null,
  reviewed_by text null,
  reviewed_at timestamptz null,
  created_at timestamptz not null
);

create index if not exists promotion_requests_status_idx
  on xena_runtime.promotion_requests (status, created_at desc);
