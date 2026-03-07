import { z } from "zod";

import { SCHEMA_VERSION } from "./enums.js";

export const NonEmptyStringSchema = z.string().trim().min(1);
export const DateTimeSchema = z.iso.datetime({ offset: true });
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export const LooseObjectSchema = z.object({}).catchall(z.unknown());
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

function prefixedId(prefix: string): z.ZodString {
  return NonEmptyStringSchema.regex(
    new RegExp(`^${prefix}[A-Za-z0-9._-]+$`),
    `${prefix} identifier must start with ${prefix}`
  );
}

export function nullablePrefixedId(prefix: string): z.ZodNullable<z.ZodString> {
  return prefixedId(prefix).nullable();
}

export const IngressIdSchema = prefixedId("ingress_");
export const AgentIdSchema = prefixedId("agent_");
export const TaskIdSchema = prefixedId("task_");
export const RunIdSchema = prefixedId("run_");
export const EventIdSchema = prefixedId("evt_");
export const ArtifactIdSchema = prefixedId("artifact_");
export const ContextBundleIdSchema = prefixedId("ctx_");
export const DelegationIdSchema = prefixedId("delegation_");
export const MemoryIdSchema = prefixedId("memory_");
export const MemoryQueryIdSchema = prefixedId("memqry_");
export const PromotionRequestIdSchema = prefixedId("promote_");
