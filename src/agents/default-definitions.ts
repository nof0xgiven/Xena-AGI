import { fileURLToPath } from "node:url";

import type { RegisteredAgentDefinition } from "./types.js";

const CREATED_AT = "2026-03-07T00:00:00.000Z";

function promptRef(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export const defaultAgentDefinitions: RegisteredAgentDefinition[] = [
  {
    schema_version: "1.0",
    agent_id: "agent_marketing_content_creator",
    version: "1.0.0",
    name: "Content Creator",
    description:
      "Expert content strategist and creator for multi-platform campaigns.",
    provider: "openai",
    model: "gpt-5.4",
    reasoning_effort: "medium",
    system_prompt_ref: promptRef("../prompts/assets/content-creator.md"),
    tools: ["WebFetch", "WebSearch", "Read", "Write", "Edit"],
    skills: ["content_strategy", "brand_storytelling", "seo_content"],
    execution_mode: "single_shot",
    supervisor_mode: false,
    output_schema_ref: null,
    timeout_ms: 120_000,
    max_tool_calls: 12,
    enabled: true,
    created_at: CREATED_AT,
    updated_at: CREATED_AT
  },
  {
    schema_version: "1.0",
    agent_id: "agent_marketing_growth_hacker",
    version: "1.0.0",
    name: "Growth Hacker",
    description:
      "Expert growth strategist for rapid experimentation and scalable acquisition.",
    provider: "openai",
    model: "gpt-5.4",
    reasoning_effort: "high",
    system_prompt_ref: promptRef("../prompts/assets/growth-hacker.md"),
    tools: ["WebFetch", "WebSearch", "Read", "Write", "Edit"],
    skills: ["growth_experiments", "funnel_optimization", "analytics"],
    execution_mode: "single_shot",
    supervisor_mode: true,
    output_schema_ref: null,
    timeout_ms: 120_000,
    max_tool_calls: 14,
    enabled: true,
    created_at: CREATED_AT,
    updated_at: CREATED_AT
  },
  {
    schema_version: "1.0",
    agent_id: "agent_marketing_social_media_strategist",
    version: "1.0.0",
    name: "Social Media Strategist",
    description:
      "Expert social media strategist for LinkedIn, Twitter, and professional platforms.",
    provider: "openai",
    model: "gpt-5.4",
    reasoning_effort: "medium",
    system_prompt_ref: promptRef("../prompts/assets/social-media-strategist.md"),
    tools: ["WebFetch", "WebSearch", "Read", "Write", "Edit"],
    skills: ["campaign_planning", "community_building", "thought_leadership"],
    execution_mode: "single_shot",
    supervisor_mode: true,
    output_schema_ref: null,
    timeout_ms: 120_000,
    max_tool_calls: 14,
    enabled: true,
    created_at: CREATED_AT,
    updated_at: CREATED_AT
  }
];
