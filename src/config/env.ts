import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const DEFAULT_DATABASE_URL = "postgresql://xena:xena@127.0.0.1:55432/xena";
const DEFAULT_MINIO_ENDPOINT = "http://127.0.0.1:19000";
const DEFAULT_MINIO_REGION = "us-east-1";
const DEFAULT_MINIO_ACCESS_KEY = "minioadmin";
const DEFAULT_MINIO_SECRET_KEY = "minioadmin";
const DEFAULT_MINIO_BUCKET = "xena-local";

const NodeEnvSchema = z
  .enum(["development", "test", "production"])
  .default("development");

export type LoadEnvOptions = {
  requireIngressAuth?: boolean;
  requireTrigger?: boolean;
};

export type AppEnv = {
  apiPort: number;
  publicBaseUrl: string;
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  minio: {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  trigger: {
    projectRef?: string;
    secretKey?: string;
    apiUrl?: string;
  };
  security: {
    apiToken?: string;
    webhookToken?: string;
  };
};

const InputSchema = z.looseObject({
  NODE_ENV: z.string().optional(),
  XENA_API_PORT: z.string().optional(),
  XENA_PUBLIC_BASE_URL: z.string().optional(),
  XENA_DATABASE_URL: z.string().optional(),
  XENA_POSTGRES_HOST: z.string().optional(),
  XENA_POSTGRES_PORT: z.string().optional(),
  XENA_POSTGRES_DB: z.string().optional(),
  XENA_POSTGRES_USER: z.string().optional(),
  XENA_POSTGRES_PASSWORD: z.string().optional(),
  XENA_MINIO_ENDPOINT: z.string().optional(),
  XENA_MINIO_REGION: z.string().optional(),
  XENA_MINIO_ACCESS_KEY: z.string().optional(),
  XENA_MINIO_SECRET_KEY: z.string().optional(),
  XENA_MINIO_BUCKET: z.string().optional(),
  XENA_API_TOKEN: z.string().optional(),
  XENA_WEBHOOK_TOKEN: z.string().optional(),
  TRIGGER_PROJ_REF: z.string().optional(),
  TRIGGER_PROJECT_REF: z.string().optional(),
  TRIGGER_SECRET_KEY: z.string().optional(),
  TRIGGER_API_URL: z.string().optional()
});

function requireUrl(name: string, value: string, protocols?: string[]): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (protocols && !protocols.includes(parsed.protocol)) {
    throw new Error(
      `${name} must use one of these protocols: ${protocols.join(", ")}`
    );
  }

  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 55_432;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("Postgres port must be a valid TCP port number");
  }

  return parsed;
}

export function loadEnv(
  source: Record<string, string | undefined>,
  options: LoadEnvOptions = {}
): AppEnv {
  const raw = InputSchema.parse(source);
  const nodeEnv = NodeEnvSchema.parse(raw.NODE_ENV);
  const apiPort = raw.XENA_API_PORT ? parsePort(raw.XENA_API_PORT) : 18_790;
  const databaseUrl = requireUrl(
    "Database URL",
    raw.XENA_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    ["postgres:", "postgresql:"]
  );
  const publicBaseUrl = requireUrl(
    "Public base URL",
    raw.XENA_PUBLIC_BASE_URL ?? "https://xena.ngrok.app",
    ["http:", "https:"]
  );
  const minioEndpoint = requireUrl(
    "MinIO endpoint",
    raw.XENA_MINIO_ENDPOINT ?? DEFAULT_MINIO_ENDPOINT,
    ["http:", "https:"]
  );
  const triggerProjectRef = raw.TRIGGER_PROJ_REF ?? raw.TRIGGER_PROJECT_REF;

  if (options.requireTrigger && !triggerProjectRef) {
    throw new Error(
      "Trigger project ref is required when Trigger integration is enabled"
    );
  }

  if (options.requireTrigger && !raw.TRIGGER_SECRET_KEY) {
    throw new Error(
      "Trigger secret key is required when Trigger integration is enabled"
    );
  }

  if (options.requireIngressAuth && !raw.XENA_API_TOKEN) {
    throw new Error("Xena API token is required when ingress auth is enabled");
  }

  if (options.requireIngressAuth && !raw.XENA_WEBHOOK_TOKEN) {
    throw new Error(
      "Xena webhook token is required when ingress auth is enabled"
    );
  }

  if (raw.TRIGGER_API_URL) {
    requireUrl("Trigger API URL", raw.TRIGGER_API_URL, ["http:", "https:"]);
  }

  const trigger: AppEnv["trigger"] = {};

  if (triggerProjectRef) {
    trigger.projectRef = triggerProjectRef;
  }

  if (raw.TRIGGER_SECRET_KEY) {
    trigger.secretKey = raw.TRIGGER_SECRET_KEY;
  }

  if (raw.TRIGGER_API_URL) {
    trigger.apiUrl = raw.TRIGGER_API_URL;
  }

  const security: AppEnv["security"] = {};

  if (raw.XENA_API_TOKEN) {
    security.apiToken = raw.XENA_API_TOKEN;
  }

  if (raw.XENA_WEBHOOK_TOKEN) {
    security.webhookToken = raw.XENA_WEBHOOK_TOKEN;
  }

  return {
    apiPort,
    publicBaseUrl,
    nodeEnv,
    databaseUrl,
    postgres: {
      host: raw.XENA_POSTGRES_HOST ?? "127.0.0.1",
      port: parsePort(raw.XENA_POSTGRES_PORT),
      database: raw.XENA_POSTGRES_DB ?? "xena",
      user: raw.XENA_POSTGRES_USER ?? "xena",
      password: raw.XENA_POSTGRES_PASSWORD ?? "xena"
    },
    minio: {
      endpoint: minioEndpoint,
      region: raw.XENA_MINIO_REGION ?? DEFAULT_MINIO_REGION,
      accessKey: raw.XENA_MINIO_ACCESS_KEY ?? DEFAULT_MINIO_ACCESS_KEY,
      secretKey: raw.XENA_MINIO_SECRET_KEY ?? DEFAULT_MINIO_SECRET_KEY,
      bucket: raw.XENA_MINIO_BUCKET ?? DEFAULT_MINIO_BUCKET
    },
    trigger,
    security
  };
}

export function loadProcessEnv(options: LoadEnvOptions = {}): AppEnv {
  loadDotEnv({ quiet: true });

  return loadEnv(process.env, options);
}
