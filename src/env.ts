import { z } from "zod";

const TemporalEnvSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1),
  TEMPORAL_NAMESPACE: z.string().min(1).optional(),
  TEMPORAL_TASK_QUEUE: z.string().min(1).optional(),
});

// Server only ingests webhooks and schedules Temporal workflows.
// Keep required env vars minimal so the webhook plane stays healthy even if e.g. OpenAI/GitHub keys are missing.
const ServerEnvSchema = TemporalEnvSchema.extend({
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  MANUS_API_KEY: z.string().min(1).optional(),
  MANUS_BASE_URL: z.string().min(1).optional(),
  MANUS_WEBHOOK_PUBLIC_KEY: z.string().min(1).optional(),
  MANUS_WEBHOOK_REQUIRE_SIGNATURE: z.string().min(1).optional(),
  // Optional: if set, GitHub webhook signature is verified (X-Hub-Signature-256).
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  XENA_INGRESS_PORT: z.string().regex(/^\d+$/).optional(),
  XENA_INTERNAL_BASE_URL: z.string().min(1).optional(),
  XENA_PUBLIC_BASE_URL: z.string().min(1).optional(),
  XENA_FOUNDER_LINEAR_USER_IDS: z.string().min(1).optional(),
  XENA_LEGACY_CLEANUP_INTERVAL_MINUTES: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  XENA_MEMORY_MAINTENANCE_INTERVAL_MINUTES: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  XENA_MEMORY_RETENTION_DRY_RUN: z.string().min(1).optional(),
  AGENTMAIL_WEBHOOK_SECRET: z.string().min(1).optional(),
  AGENT_MAIL_WEBHOOK_SECRET: z.string().min(1).optional(),
  XENA_AGENTMAIL_INTERVAL_MINUTES: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  XENA_AGENTMAIL_DRY_RUN: z.string().min(1).optional(),
  XENA_OWNER_EMAIL: z.string().min(1).optional(),
  XENA_OWNER_NAME: z.string().min(1).optional(),
  XENA_SAFE_SENDER_EMAILS: z.string().min(1).optional(),
  MANUS_WEBHOOK_TOKEN: z.string().min(1).optional(),
  XENA_HTTP_PORT: z
    .string()
    .regex(/^\d+$/)
    .optional(),
});

const WorkerEnvSchema = TemporalEnvSchema.extend({
  LINEAR_API_KEY: z.string().min(1),
  MEM0_API_KEY: z.string().min(1),
  MEM0_BASE_URL: z.string().min(1).optional(),
  MEM0_ENABLE_GRAPH: z.string().min(1).optional(),
  MANUS_API_KEY: z.string().min(1).optional(),
  MANUS_BASE_URL: z.string().min(1).optional(),
  MANUS_POLL_INTERVAL_MS: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  MANUS_TIMEOUT_SECONDS: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  MANUS_WEBHOOK_TOKEN: z.string().min(1).optional(),
  XENA_PUBLIC_BASE_URL: z.string().min(1).optional(),
  AGENTMAIL_API_KEY: z.string().min(1).optional(),
  AGENT_MAIL_API_KEY: z.string().min(1).optional(),
  AGENTMAIL_BASE_URL: z.string().min(1).optional(),
  AGENT_MAIL_BASE_URL: z.string().min(1).optional(),
  XENA_INTERNAL_BASE_URL: z.string().min(1).optional(),
  XENA_AGENTMAIL_INBOX_ID: z.string().min(1).optional(),
  XENA_AGENTMAIL_USERNAME: z.string().min(1).optional(),
  XENA_AGENTMAIL_DOMAIN: z.string().min(1).optional(),
  XENA_AGENTMAIL_DISPLAY_NAME: z.string().min(1).optional(),
  XENA_OWNER_EMAIL: z.string().min(1).optional(),
  XENA_OWNER_NAME: z.string().min(1).optional(),
  XENA_OWNER_PROFILE_URL: z.string().min(1).optional(),
  XENA_ROOT: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1),
  XENA_OPENAI_MODEL: z.string().min(1),
  // GitHub / PR creation
  GH_TOKEN: z.string().min(1).optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
  GH_REPO: z.string().min(1).optional(),
  GH_BASE_BRANCH: z.string().min(1).optional(),
  // Smoke / sandbox (optional; workflow can also proceed via operator commands/comments)
  HYPERBROWSER_API_KEY: z.string().min(1).optional(),
  XENA_HYPERBROWSER_MODEL: z.string().min(1).optional(),
  VERCEL_ACCESS_TOKEN: z.string().min(1).optional(),
  VERCEL_PROJECT_ID: z.string().min(1).optional(),
  VERCEL_TEAM_ID: z.string().min(1).optional(),
});

export type TemporalEnv = {
  TEMPORAL_ADDRESS: string;
  TEMPORAL_NAMESPACE: string;
  TEMPORAL_TASK_QUEUE: string;
};

export type ServerEnv = TemporalEnv & {
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
  MANUS_API_KEY?: string;
  MANUS_BASE_URL?: string;
  MANUS_WEBHOOK_PUBLIC_KEY?: string;
  MANUS_WEBHOOK_REQUIRE_SIGNATURE?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  XENA_INGRESS_PORT?: string;
  XENA_INTERNAL_BASE_URL?: string;
  XENA_PUBLIC_BASE_URL?: string;
  XENA_FOUNDER_LINEAR_USER_IDS?: string;
  XENA_LEGACY_CLEANUP_INTERVAL_MINUTES?: string;
  XENA_MEMORY_MAINTENANCE_INTERVAL_MINUTES?: string;
  XENA_MEMORY_RETENTION_DRY_RUN?: string;
  AGENTMAIL_WEBHOOK_SECRET?: string;
  XENA_AGENTMAIL_INTERVAL_MINUTES?: string;
  XENA_AGENTMAIL_DRY_RUN?: string;
  XENA_OWNER_EMAIL?: string;
  XENA_OWNER_NAME?: string;
  XENA_SAFE_SENDER_EMAILS?: string;
  MANUS_WEBHOOK_TOKEN?: string;
  XENA_HTTP_PORT: string;
};

export type WorkerEnv = TemporalEnv & {
  LINEAR_API_KEY: string;
  MEM0_API_KEY: string;
  MEM0_BASE_URL?: string;
  MEM0_ENABLE_GRAPH?: string;
  MANUS_API_KEY?: string;
  MANUS_BASE_URL?: string;
  MANUS_POLL_INTERVAL_MS?: string;
  MANUS_TIMEOUT_SECONDS?: string;
  MANUS_WEBHOOK_TOKEN?: string;
  XENA_PUBLIC_BASE_URL?: string;
  AGENTMAIL_API_KEY?: string;
  AGENTMAIL_BASE_URL?: string;
  XENA_INTERNAL_BASE_URL?: string;
  XENA_AGENTMAIL_INBOX_ID?: string;
  XENA_AGENTMAIL_USERNAME?: string;
  XENA_AGENTMAIL_DOMAIN?: string;
  XENA_AGENTMAIL_DISPLAY_NAME?: string;
  XENA_OWNER_EMAIL?: string;
  XENA_OWNER_NAME?: string;
  XENA_OWNER_PROFILE_URL?: string;
  XENA_ROOT?: string;
  OPENAI_API_KEY: string;
  XENA_OPENAI_MODEL: string;
  GH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GH_REPO?: string;
  GH_BASE_BRANCH?: string;
  HYPERBROWSER_API_KEY?: string;
  XENA_HYPERBROWSER_MODEL?: string;
  VERCEL_ACCESS_TOKEN?: string;
  VERCEL_PROJECT_ID?: string;
  VERCEL_TEAM_ID?: string;
};

function loadWithSchema<T>(schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Missing/invalid environment:\n${msg}`);
  }
  return parsed.data;
}

export function loadServerEnv(): ServerEnv {
  const raw = loadWithSchema(ServerEnvSchema);
  return {
    ...raw,
    AGENTMAIL_WEBHOOK_SECRET:
      raw.AGENTMAIL_WEBHOOK_SECRET ?? raw.AGENT_MAIL_WEBHOOK_SECRET,
    TEMPORAL_NAMESPACE: raw.TEMPORAL_NAMESPACE ?? "xena",
    TEMPORAL_TASK_QUEUE: raw.TEMPORAL_TASK_QUEUE ?? "xena-tasks",
    // Internal webhook server should not collide with common dev ports (e.g. 3000).
    XENA_HTTP_PORT: raw.XENA_HTTP_PORT ?? "3001",
  };
}

export function loadWorkerEnv(): WorkerEnv {
  const raw = loadWithSchema(WorkerEnvSchema);
  return {
    ...raw,
    AGENTMAIL_API_KEY: raw.AGENTMAIL_API_KEY ?? raw.AGENT_MAIL_API_KEY,
    AGENTMAIL_BASE_URL: raw.AGENTMAIL_BASE_URL ?? raw.AGENT_MAIL_BASE_URL,
    TEMPORAL_NAMESPACE: raw.TEMPORAL_NAMESPACE ?? "xena",
    TEMPORAL_TASK_QUEUE: raw.TEMPORAL_TASK_QUEUE ?? "xena-tasks",
  };
}
