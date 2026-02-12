import fs from "node:fs/promises";
import path from "node:path";
import { loadWorkerEnv } from "../../env.js";
import {
  createManusClient,
  manusCreateTask,
  manusGetTask,
  type ManusTaskDetail,
} from "../../manus.js";
import {
  buildResearchPrompt,
  parseResearchExecutorOutput,
  type ResearchExecutorRequest,
} from "../../capabilities/research/researchExecutor.js";
import type { ResearchBrief } from "../../capabilities/research/briefBuilder.js";

export type ResearchRunInput = {
  issueId: string;
  issueIdentifier: string;
  topic: string;
  objective: string;
  cwd: string;
  audience?: string;
  constraints?: string[];
  questions?: string[];
  sourceHints?: string[];
  maxSources?: number;
};

export type ResearchStartInput = ResearchRunInput & {
  workflowId?: string;
  projectKey?: string;
  webhookWorkflowType?: string;
};

export type ResearchStartResult = {
  provider: "manus";
  taskId: string;
  taskUrl: string;
  taskStatus: string;
  shareUrl?: string;
  webhookUrl?: string;
};

export type ResearchFinalizeTaskInput = {
  issueId: string;
  issueIdentifier: string;
  topic: string;
  taskId: string;
  sourceHints?: string[];
  maxSources?: number;
};

export type ResearchRunResult = {
  brief: ResearchBrief;
  parseMode: "json" | "text";
  warnings: string[];
  outputPath: string;
  logPath: string;
  provider: "manus";
  taskId: string;
  taskUrl: string;
  taskStatus: string;
};

type TerminalStatus = "completed" | "failed" | "cancelled" | "canceled" | "ask";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function asTerminalStatus(status: string): TerminalStatus | null {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "canceled") return "canceled";
  if (status === "ask") return "ask";
  return null;
}

function collectManusFileUrls(detail: ManusTaskDetail): string[] {
  return detail.result.files
    .map((file) => file.url.trim())
    .filter((url) => url.length > 0);
}

function renderManusOutput(detail: ManusTaskDetail): string {
  const lines: string[] = [];
  const body = detail.result.text?.trim();
  if (body) {
    lines.push(body);
  } else {
    lines.push("No narrative output was returned by Manus.");
  }

  if (detail.result.files.length > 0) {
    lines.push("");
    lines.push("## Manus Files");
    for (const file of detail.result.files) {
      lines.push(`- ${file.name}: ${file.url}`);
    }
  }

  return lines.join("\n").trim();
}

function buildTaskUrl(taskId: string): string {
  return `https://manus.im/app/${taskId}`;
}

function buildResearchRequest(opts: {
  topic: string;
  objective: string;
  audience?: string;
  constraints?: string[];
  questions?: string[];
  sourceHints?: string[];
  maxSources?: number;
}): ResearchExecutorRequest {
  return {
    topic: opts.topic,
    objective: opts.objective,
    audience: opts.audience,
    constraints: opts.constraints,
    questions: opts.questions,
    sourceHints: opts.sourceHints,
    maxSources: opts.maxSources,
  };
}

function buildRunPaths(opts: { issueId: string; issueIdentifier: string }): {
  outputPath: string;
  logPath: string;
} {
  const outputPath = path.resolve(
    process.cwd(),
    "runs",
    `xena:${opts.issueId}`,
    `research-${opts.issueIdentifier.toLowerCase()}.md`,
  );
  const logPath = path.resolve(
    process.cwd(),
    "runs",
    `xena:${opts.issueId}`,
    `research-${opts.issueIdentifier.toLowerCase()}.manus.json`,
  );
  return {
    outputPath,
    logPath,
  };
}

function buildManusWebhookUrl(opts: {
  baseUrl: string;
  workflowType: string;
  workflowId: string;
  projectKey: string;
  issueId: string;
  issueIdentifier: string;
  token?: string;
}): string {
  const webhookUrl = new URL("/webhooks/manus", opts.baseUrl);
  webhookUrl.searchParams.set("workflowType", opts.workflowType);
  webhookUrl.searchParams.set("workflowId", opts.workflowId);
  webhookUrl.searchParams.set("projectKey", opts.projectKey);
  webhookUrl.searchParams.set("issueId", opts.issueId);
  webhookUrl.searchParams.set("issueIdentifier", opts.issueIdentifier);
  if (opts.token && opts.token.trim()) {
    webhookUrl.searchParams.set("token", opts.token.trim());
  }
  return webhookUrl.toString();
}

async function persistFinalizedResearch(opts: {
  issueId: string;
  issueIdentifier: string;
  topic: string;
  taskId: string;
  taskUrl?: string;
  shareUrl?: string;
  createdStatus?: string;
  detail: ManusTaskDetail;
  statusHistory: Array<{ at: string; status: string }>;
  sourceHints?: string[];
  maxSources?: number;
}): Promise<ResearchRunResult> {
  const rawOutput = renderManusOutput(opts.detail);
  const parsed = parseResearchExecutorOutput(rawOutput, {
    topic: opts.topic,
    sourceHints: [...(opts.sourceHints ?? []), ...collectManusFileUrls(opts.detail)],
    maxSources: opts.maxSources,
  });
  const runPaths = buildRunPaths({
    issueId: opts.issueId,
    issueIdentifier: opts.issueIdentifier,
  });

  await fs.mkdir(path.dirname(runPaths.outputPath), { recursive: true });
  await fs.writeFile(runPaths.outputPath, `${rawOutput}\n`, "utf8");
  await fs.writeFile(
    runPaths.logPath,
    `${JSON.stringify(
      {
        provider: "manus",
        taskId: opts.taskId,
        taskUrl: opts.taskUrl ?? buildTaskUrl(opts.taskId),
        shareUrl: opts.shareUrl,
        createdStatus: opts.createdStatus,
        terminalStatus: opts.detail.status,
        statusHistory: opts.statusHistory,
        fileCount: opts.detail.result.files.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    brief: parsed.brief,
    parseMode: parsed.parseMode,
    warnings: parsed.warnings,
    outputPath: runPaths.outputPath,
    logPath: runPaths.logPath,
    provider: "manus",
    taskId: opts.taskId,
    taskUrl: opts.taskUrl ?? buildTaskUrl(opts.taskId),
    taskStatus: opts.detail.status,
  };
}

async function getTaskWithRetry(opts: {
  taskId: string;
  maxAttempts: number;
  pollIntervalMs: number;
  manus: ReturnType<typeof createManusClient>;
  statusHistory: Array<{ at: string; status: string }>;
}): Promise<ManusTaskDetail> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      const detail = await manusGetTask({
        client: opts.manus,
        taskId: opts.taskId,
      });
      opts.statusHistory.push({
        at: new Date().toISOString(),
        status: normalizeStatus(detail.status) || "unknown",
      });
      return detail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error;
      if (!message.includes("(404)") || attempt >= opts.maxAttempts) {
        throw error;
      }
      opts.statusHistory.push({
        at: new Date().toISOString(),
        status: "pending_not_found",
      });
      await sleep(opts.pollIntervalMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function researchStart(opts: ResearchStartInput): Promise<ResearchStartResult> {
  const env = loadWorkerEnv();
  if (!env.MANUS_API_KEY) {
    throw new Error("MANUS_API_KEY is required: research activities use Manus as the web research engine.");
  }

  const request = buildResearchRequest(opts);
  const prompt = buildResearchPrompt(request);
  const manus = createManusClient({
    apiKey: env.MANUS_API_KEY,
    baseUrl: env.MANUS_BASE_URL,
  });

  let webhookUrl: string | undefined;
  if (opts.workflowId) {
    if (!opts.projectKey) {
      throw new Error("researchStart requires projectKey when workflowId is provided.");
    }
    if (!opts.webhookWorkflowType || !opts.webhookWorkflowType.trim()) {
      throw new Error("researchStart requires webhookWorkflowType when workflowId is provided.");
    }
    const callbackBaseUrl = env.XENA_PUBLIC_BASE_URL ?? env.XENA_INTERNAL_BASE_URL;
    if (!callbackBaseUrl) {
      throw new Error(
        "XENA_PUBLIC_BASE_URL (preferred) or XENA_INTERNAL_BASE_URL is required for Manus webhook-enabled research starts.",
      );
    }
    webhookUrl = buildManusWebhookUrl({
      baseUrl: callbackBaseUrl,
      workflowType: opts.webhookWorkflowType.trim(),
      workflowId: opts.workflowId,
      projectKey: opts.projectKey,
      issueId: opts.issueId,
      issueIdentifier: opts.issueIdentifier,
      token: env.MANUS_WEBHOOK_TOKEN,
    });
  }

  const created = await manusCreateTask({
    client: manus,
    prompt,
    webhookUrl,
  });

  return {
    provider: "manus",
    taskId: created.id,
    taskUrl: created.taskUrl ?? buildTaskUrl(created.id),
    taskStatus: created.status,
    shareUrl: created.shareUrl,
    webhookUrl,
  };
}

export async function researchFinalizeTask(opts: ResearchFinalizeTaskInput): Promise<ResearchRunResult> {
  const env = loadWorkerEnv();
  if (!env.MANUS_API_KEY) {
    throw new Error("MANUS_API_KEY is required: research activities use Manus as the web research engine.");
  }

  const pollIntervalMs = clamp(parsePositiveInt(env.MANUS_POLL_INTERVAL_MS, 5000), 1000, 30000);
  const statusHistory: Array<{ at: string; status: string }> = [];
  const manus = createManusClient({
    apiKey: env.MANUS_API_KEY,
    baseUrl: env.MANUS_BASE_URL,
  });
  const detail = await getTaskWithRetry({
    manus,
    taskId: opts.taskId,
    maxAttempts: 5,
    pollIntervalMs,
    statusHistory,
  });

  const terminal = asTerminalStatus(normalizeStatus(detail.status));
  if (terminal !== "completed") {
    const taskError = detail.error?.trim() || "Manus task ended without a completed result.";
    throw new Error(`Manus task ${opts.taskId} ended with status ${terminal ?? "unknown"}: ${taskError}`);
  }

  return persistFinalizedResearch({
    issueId: opts.issueId,
    issueIdentifier: opts.issueIdentifier,
    topic: opts.topic,
    taskId: opts.taskId,
    detail,
    statusHistory,
    sourceHints: opts.sourceHints,
    maxSources: opts.maxSources,
  });
}

export async function researchRun(opts: ResearchRunInput): Promise<ResearchRunResult> {
  const env = loadWorkerEnv();
  if (!env.MANUS_API_KEY) {
    throw new Error("MANUS_API_KEY is required: researchRun uses Manus as the web research engine.");
  }

  const pollIntervalMs = clamp(parsePositiveInt(env.MANUS_POLL_INTERVAL_MS, 5000), 1000, 30000);
  const timeoutSeconds = clamp(parsePositiveInt(env.MANUS_TIMEOUT_SECONDS, 1200), 30, 7200);
  const deadlineMs = Date.now() + timeoutSeconds * 1000;
  const started = await researchStart(opts);

  const manus = createManusClient({
    apiKey: env.MANUS_API_KEY,
    baseUrl: env.MANUS_BASE_URL,
  });
  const statusHistory: Array<{ at: string; status: string }> = [
    { at: new Date().toISOString(), status: normalizeStatus(started.taskStatus) || "pending" },
  ];

  let latest: ManusTaskDetail | null = null;
  while (true) {
    if (Date.now() >= deadlineMs) {
      throw new Error(
        `Manus task ${started.taskId} timed out after ${timeoutSeconds}s (last status: ${normalizeStatus(latest?.status) || "unknown"}).`,
      );
    }

    latest = await getTaskWithRetry({
      manus,
      taskId: started.taskId,
      maxAttempts: 2,
      pollIntervalMs,
      statusHistory,
    });

    if (asTerminalStatus(normalizeStatus(latest.status))) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  if (!latest) {
    throw new Error(`Manus task ${started.taskId} produced no retrievable task detail before timeout.`);
  }

  const terminal = asTerminalStatus(normalizeStatus(latest.status));
  if (terminal !== "completed") {
    const taskError = latest.error?.trim() || "Manus task ended without a completed result.";
    throw new Error(`Manus task ${started.taskId} ended with status ${terminal}: ${taskError}`);
  }

  return persistFinalizedResearch({
    issueId: opts.issueId,
    issueIdentifier: opts.issueIdentifier,
    topic: opts.topic,
    taskId: started.taskId,
    taskUrl: started.taskUrl,
    shareUrl: started.shareUrl,
    createdStatus: started.taskStatus,
    detail: latest,
    statusHistory,
    sourceHints: opts.sourceHints,
    maxSources: opts.maxSources,
  });
}
