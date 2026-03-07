export const KNOWN_AGENT_TOOLS = [
  "Edit",
  "Read",
  "WebFetch",
  "WebSearch",
  "Write"
] as const;

export type KnownAgentTool = (typeof KNOWN_AGENT_TOOLS)[number];
export type AgentRoleType = "leaf" | "supervisor";
export type ResolveAgentContext = {
  businessId?: string;
  environment?: string;
  projectId?: string;
};

export type RegisteredAgentDefinition = {
  schema_version: "1.0";
  agent_id: string;
  version: string;
  name: string;
  description: string;
  domain: string;
  role_type: AgentRoleType;
  reports_to: string | null;
  allowed_delegate_to: string[];
  provider: string;
  model: string;
  reasoning_effort: string;
  system_prompt_ref: string;
  tools: string[];
  skills: string[];
  execution_mode: "single_shot";
  supervisor_mode: boolean;
  output_schema_ref: string | null;
  timeout_ms: number;
  max_tool_calls: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type RegisteredAgentOverride = {
  schema_version: "1.0";
  override_id: string;
  match: {
    agent_id: string;
    version?: string | null;
    environment?: string | null;
    business_id?: string | null;
    project_id?: string | null;
  };
  patch: Partial<
    Pick<
      RegisteredAgentDefinition,
      | "allowed_delegate_to"
      | "enabled"
      | "max_tool_calls"
      | "model"
      | "output_schema_ref"
      | "provider"
      | "reasoning_effort"
      | "skills"
      | "system_prompt_ref"
      | "timeout_ms"
      | "tools"
    >
  >;
};
