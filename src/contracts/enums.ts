import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;

export const TaskStateEnum = z.enum([
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

export const RunStateEnum = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "retrying",
  "timed_out",
  "cancelled"
]);

export const DelegationStateEnum = z.enum([
  "pending",
  "satisfied",
  "failed",
  "expired"
]);

export const AgentOutcomeEnum = z.enum([
  "success",
  "delegated",
  "blocked",
  "failed",
  "needs_review"
]);

export const AgentRoleTypeEnum = z.enum(["leaf", "supervisor"]);

export const ArtifactTypeEnum = z.enum([
  "file",
  "json",
  "report",
  "log",
  "url",
  "image",
  "diff",
  "transcript"
]);

export const MemoryClassEnum = z.enum([
  "episodic",
  "semantic",
  "procedural",
  "working"
]);

export const MemoryScopeEnum = z.enum([
  "business",
  "project",
  "agent",
  "global_patterns"
]);

export const ExecutionModeEnum = z.literal("single_shot");
