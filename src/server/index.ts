import Fastify from "fastify";
import { loadServerEnv } from "../env.js";
import { logger, loggerConfig } from "../logger.js";
import { verifyLinearWebhookSignature } from "../linearWebhookVerify.js";
import { createLinearClient, postComment } from "../linear.js";
import { verifyManusWebhookSignature } from "../manusWebhookVerify.js";
import { loadProjectsConfig, resolveCloneEnvScriptPath, resolveProjectForTeamKey } from "../projectConfig.js";
import { loadRegistryBundle } from "../registry/loader.js";
import { resolveSafeSenderEmails } from "../identity/safeSenders.js";
import { createTemporalClient } from "../temporal/client.js";
import { SIGNAL_AGENTMAIL_EVENT, SIGNAL_GITHUB_PR, SIGNAL_LINEAR_COMMENT } from "../temporal/signals.js";
import type { AgentmailEventSignal, ManusEventSignal } from "../temporal/shared.js";
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/common";
import crypto from "node:crypto";
import { Webhook } from "svix";

type LinearIssueUpdatePayload = {
  type: "Issue";
  action: "update";
  data: {
    id: string;
    assigneeId?: string | null;
  };
  updatedFrom?: {
    assigneeId?: string | null;
  };
  webhookTimestamp?: number;
};

type LinearCommentCreatePayload = {
  type: "Comment";
  action: "create";
  data: {
    id: string;
    body?: string | null;
    issueId: string;
    userId?: string | null;
  };
  actor?: {
    id?: string;
  };
  webhookTimestamp?: number;
};

type GithubPullRequestSignalPayload = {
  deliveryId?: string;
  issueId: string;
  action: string;
  repositoryFullName: string;
  prNumber: number;
  prUrl: string;
  branchName: string;
  prTitle: string;
  prBody?: string | null;
  merged?: boolean;
};

type AgentmailWebhookPayload = {
  type?: string;
  event_type?: string;
  event_id?: string;
  message?: unknown;
  thread?: unknown;
  data?: Record<string, unknown>;
};

type ManusWebhookPayload = {
  type?: string;
  event_type?: string;
  event_id?: string;
  task_detail?: unknown;
  progress_detail?: unknown;
  data?: Record<string, unknown>;
};

type ManusWebhookDispatchMode = "signalWithStart" | "signalOnly";
type ManusWebhookBootstrapMode = "agentmail" | "none";

type ManusWebhookRouteConfig = {
  workflowType: string;
  workflowName: string;
  signalName: string;
  dispatchMode: ManusWebhookDispatchMode;
  bootstrap: ManusWebhookBootstrapMode;
};

function isIssueUpdateAssignedToXena(
  p: unknown,
  viewerId: string,
): p is LinearIssueUpdatePayload {
  const v = p as Partial<LinearIssueUpdatePayload>;
  if (v?.type !== "Issue" || v?.action !== "update") return false;
  if (!v.data?.id) return false;
  const newAssignee = v.data.assigneeId;
  const oldAssignee = v.updatedFrom?.assigneeId;
  return oldAssignee !== undefined && newAssignee === viewerId && oldAssignee !== viewerId;
}

function isCommentCreate(p: unknown): p is LinearCommentCreatePayload {
  const v = p as Partial<LinearCommentCreatePayload>;
  if (v?.type !== "Comment" || v?.action !== "create") return false;
  if (!v.data?.id || !v.data?.issueId) return false;
  return true;
}

function verifyGithubWebhookSignature(opts: {
  secret?: string;
  rawBody: Buffer;
  signatureHeader?: string;
}): boolean {
  if (!opts.secret) return true; // signature verification is optional
  const sig = opts.signatureHeader ?? "";
  const m = sig.match(/^sha256=(.+)$/i);
  if (!m) return false;
  const expected = crypto.createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex");
  const actual = m[1].toLowerCase();
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function extractTicketIdentifier(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = t.match(/\bK\d+-\d+\b/i) ?? t.match(/\b[A-Z]+-\d+\b/);
  return m ? m[0].toUpperCase() : null;
}

function parseLinearIdentifier(id: string): { teamKey: string; number: number } | null {
  const m = id.toUpperCase().match(/^([A-Z0-9]+)-(\d+)$/);
  if (!m) return null;
  const num = Number.parseInt(m[2], 10);
  if (!Number.isFinite(num)) return null;
  return { teamKey: m[1], number: num };
}

function asStringHeader(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

function parseFounderLinearUserIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (id) out.add(id);
  }
  return out;
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAddressEmail(value: unknown): string | undefined {
  const asDirect = asString(value);
  if (!asDirect) return undefined;
  const bracketed = asDirect.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (bracketed?.[1]) return bracketed[1].toLowerCase();
  if (asDirect.includes("@")) return asDirect.toLowerCase();
  return undefined;
}

function extractEmails(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = parseAddressEmail(value);
    return single ? [single] : [];
  }
  const emails: string[] = [];
  for (const item of value) {
    const row = asObject(item);
    const email = parseAddressEmail(row.email) ?? parseAddressEmail(item);
    if (email) emails.push(email);
  }
  return [...new Set(emails)];
}

function parseAgentmailAttachmentSignal(value: unknown): {
  attachmentId: string;
  filename?: string;
  size?: number;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
} | null {
  const row = asObject(value);
  const attachmentId = asString(row.attachment_id) ?? asString(row.attachmentId) ?? asString(row.id);
  if (!attachmentId) return null;
  const sizeRaw = row.size;
  const size =
    typeof sizeRaw === "number" && Number.isFinite(sizeRaw)
      ? sizeRaw
      : typeof sizeRaw === "string" && sizeRaw.trim()
        ? Number(sizeRaw.trim())
        : undefined;
  return {
    attachmentId,
    filename: asString(row.filename),
    size: typeof size === "number" && Number.isFinite(size) ? size : undefined,
    contentType: asString(row.content_type) ?? asString(row.contentType),
    contentDisposition:
      (asString(row.content_disposition) as "inline" | "attachment" | undefined) ??
      (asString(row.contentDisposition) as "inline" | "attachment" | undefined),
    contentId: asString(row.content_id) ?? asString(row.contentId),
  };
}

function parseManusAttachmentSignal(value: unknown): {
  fileName: string;
  url: string;
  sizeBytes?: number;
} | null {
  const row = asObject(value);
  const fileName = asString(row.file_name) ?? asString(row.fileName) ?? asString(row.name);
  const url = asString(row.url) ?? asString(row.file_url) ?? asString(row.fileUrl);
  if (!fileName || !url) return null;
  const sizeRaw = row.size_bytes ?? row.sizeBytes ?? row.size;
  const sizeBytes =
    typeof sizeRaw === "number" && Number.isFinite(sizeRaw)
      ? sizeRaw
      : typeof sizeRaw === "string" && sizeRaw.trim()
        ? Number(sizeRaw.trim())
        : undefined;
  return {
    fileName,
    url,
    sizeBytes: typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : undefined,
  };
}

function normalizeWorkflowTypeKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseManusWebhookRouteConfig(value: unknown, index: number): ManusWebhookRouteConfig {
  const row = asObject(value);
  const workflowType = asString(row.workflowType);
  const workflowName = asString(row.workflowName);
  const signalName = asString(row.signalName);
  const dispatchModeRaw = asString(row.dispatchMode) ?? "signalWithStart";
  const bootstrapRaw = asString(row.bootstrap) ?? "none";

  if (!workflowType) {
    throw new Error(`tool.manus.webhook.signal metadata.workflowRoutes[${index}] missing workflowType`);
  }
  if (!workflowName) {
    throw new Error(`tool.manus.webhook.signal metadata.workflowRoutes[${index}] missing workflowName`);
  }
  if (!signalName) {
    throw new Error(`tool.manus.webhook.signal metadata.workflowRoutes[${index}] missing signalName`);
  }
  if (dispatchModeRaw !== "signalWithStart" && dispatchModeRaw !== "signalOnly") {
    throw new Error(
      `tool.manus.webhook.signal metadata.workflowRoutes[${index}] has invalid dispatchMode: ${dispatchModeRaw}`,
    );
  }
  if (bootstrapRaw !== "agentmail" && bootstrapRaw !== "none") {
    throw new Error(`tool.manus.webhook.signal metadata.workflowRoutes[${index}] has invalid bootstrap: ${bootstrapRaw}`);
  }

  return {
    workflowType,
    workflowName,
    signalName,
    dispatchMode: dispatchModeRaw,
    bootstrap: bootstrapRaw,
  };
}

function resolveManusWebhookRoutesFromRegistry(
  registry: Awaited<ReturnType<typeof loadRegistryBundle>>,
): Map<string, ManusWebhookRouteConfig> {
  const tool = registry.tools.find((entry) => entry.enabled && entry.id === "tool.manus.webhook.signal");
  if (!tool) {
    throw new Error("Registry is missing enabled tool.manus.webhook.signal definition.");
  }

  const metadata = asObject(tool.metadata);
  const workflowRoutesRaw = metadata.workflowRoutes;
  if (!Array.isArray(workflowRoutesRaw) || workflowRoutesRaw.length === 0) {
    throw new Error(
      "tool.manus.webhook.signal metadata.workflowRoutes must contain at least one route definition.",
    );
  }

  const routes = new Map<string, ManusWebhookRouteConfig>();
  for (let index = 0; index < workflowRoutesRaw.length; index += 1) {
    const route = parseManusWebhookRouteConfig(workflowRoutesRaw[index], index);
    const normalizedType = normalizeWorkflowTypeKey(route.workflowType);
    if (routes.has(normalizedType)) {
      throw new Error(
        `Duplicate Manus webhook workflowType route configured: ${route.workflowType}. workflowType values must be unique.`,
      );
    }
    routes.set(normalizedType, route);
  }

  return routes;
}

function verifyAgentmailWebhookSignature(opts: {
  secret?: string;
  rawBody: Buffer;
  headers: Record<string, unknown>;
}): { ok: boolean; payload?: unknown } {
  const raw = opts.rawBody.toString("utf8");
  if (!opts.secret) {
    try {
      return { ok: true, payload: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }

  const id =
    asStringHeader(opts.headers["webhook-id"]) ??
    asStringHeader(opts.headers["svix-id"]);
  const timestamp =
    asStringHeader(opts.headers["webhook-timestamp"]) ??
    asStringHeader(opts.headers["svix-timestamp"]);
  const signature =
    asStringHeader(opts.headers["webhook-signature"]) ??
    asStringHeader(opts.headers["svix-signature"]);

  if (!id || !timestamp || !signature) return { ok: false };

  try {
    const webhook = new Webhook(opts.secret);
    const payload = webhook.verify(raw, {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
    return { ok: true, payload };
  } catch {
    return { ok: false };
  }
}

function parseXenaCommand(text: string | null | undefined): { cmd: string; args: string } | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  let rest: string | null = null;
  if (lower.startsWith("/xena")) rest = t.slice("/xena".length).trim();
  else if (lower.startsWith("@xena")) rest = t.slice("@xena".length).trim();
  else if (lower.startsWith("xena")) rest = t.slice("xena".length).trim();
  if (rest == null) return null;
  const m = rest.match(/^(\S+)(?:\s+(.*))?$/);
  return {
    cmd: (m?.[1] ?? "help").toLowerCase(),
    args: (m?.[2] ?? "").trim(),
  };
}

function looksLikeXenaRestart(text: string | null | undefined): boolean {
  return parseXenaCommand(text)?.cmd === "restart";
}

function looksLikeXenaEvaluate(text: string | null | undefined): boolean {
  return parseXenaCommand(text)?.cmd === "evaluate";
}

const WEBHOOK_ROUTE_CACHE_TTL_MS = 30_000; // 30 seconds
let _cachedManusRoutes: { routes: Map<string, ManusWebhookRouteConfig>; expiry: number } | null = null;
let _routeRefreshPromise: Promise<Map<string, ManusWebhookRouteConfig>> | null = null;

async function getManusWebhookRoutes(): Promise<Map<string, ManusWebhookRouteConfig>> {
  const now = Date.now();
  if (_cachedManusRoutes && now < _cachedManusRoutes.expiry) {
    return _cachedManusRoutes.routes;
  }
  if (_routeRefreshPromise) return _routeRefreshPromise;
  _routeRefreshPromise = (async () => {
    try {
      const registry = await loadRegistryBundle();
      const routes = resolveManusWebhookRoutesFromRegistry(registry);
      _cachedManusRoutes = { routes, expiry: Date.now() + WEBHOOK_ROUTE_CACHE_TTL_MS };
      return routes;
    } catch (err) {
      // On failure, preserve the stale cache so the server stays operational
      if (_cachedManusRoutes) {
        logger.warn({ err }, "Failed to refresh Manus webhook routes; serving stale cache");
        return _cachedManusRoutes.routes;
      }
      throw err;
    } finally {
      _routeRefreshPromise = null;
    }
  })();
  return _routeRefreshPromise;
}

async function main() {
  const env = loadServerEnv();
  const projects = await loadProjectsConfig();
  const manusWebhookRoutes = await getManusWebhookRoutes();

  const linear = createLinearClient(env.LINEAR_API_KEY);
  const viewer = await linear.viewer;
  const viewerId = viewer.id;
  const founderUserIds = parseFounderLinearUserIds(env.XENA_FOUNDER_LINEAR_USER_IDS);
  const isFounder = (linearUserId: string | null | undefined): boolean =>
    Boolean(linearUserId && founderUserIds.has(linearUserId));

  const temporal = await createTemporalClient(env);
  const safeSenderEmails = resolveSafeSenderEmails(env.XENA_SAFE_SENDER_EMAILS);

  const workflowIdForIssue = (issueId: string) => `xena:${issueId}`;

  const resolveProjectRefForIssue = async (issueId: string) => {
    const issue = await linear.issue(issueId);
    if (!issue) return null;
    const team = await issue.team;
    if (!team) return null;
    const proj = resolveProjectForTeamKey(projects, team.key);
    if (!proj) return null;
    const cloneEnvScriptPath = resolveCloneEnvScriptPath(proj);
    return {
      issue,
      projectRef: {
        projectKey: proj.projectKey,
        linearTeamKey: proj.linearTeamKey,
        repoPath: proj.repoPath,
        worktreesRoot: proj.worktreesRoot,
        cloneEnvScriptPath,
      },
    };
  };

  const forceRestartWorkflow = async (
    issueId: string,
    projectRef: any,
    startMode: "normal" | "evaluate_only" = "normal",
  ) => {
    const workflowId = workflowIdForIssue(issueId);
    try {
      const h = temporal.workflow.getHandle(workflowId);
      await h.terminate("Restart requested");
    } catch {
      // ignore
    }
    await temporal.workflow.start("operatorWorkflow", {
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.TERMINATE_EXISTING,
      args: [{ issueId, project: projectRef, startMode }],
    });
  };

  const cleanupLegacyTicketWorkflowExecutions = async () => {
    let scanned = 0;
    let terminated = 0;
    try {
      for await (const wf of temporal.workflow.list({
        query: `WorkflowType = "ticketWorkflow"`,
        pageSize: 200,
      })) {
        scanned += 1;
        if (wf.status.name !== "RUNNING") continue;
        try {
          const h = temporal.workflow.getHandle(wf.workflowId, wf.runId);
          await h.terminate("Legacy ticketWorkflow retired; use operatorWorkflow");
          terminated += 1;
        } catch (err) {
          logger.warn(
            {
              err,
              workflowId: wf.workflowId,
              runId: wf.runId,
            },
            "Failed to terminate legacy workflow execution",
          );
        }
      }
      if (scanned > 0 || terminated > 0) {
        logger.info(
          {
            scanned,
            terminated,
          },
          "Legacy workflow cleanup pass complete",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Legacy workflow cleanup pass failed");
    }
  };

  const cleanupEveryMinutes = Number(env.XENA_LEGACY_CLEANUP_INTERVAL_MINUTES ?? "30");
  if (Number.isFinite(cleanupEveryMinutes) && cleanupEveryMinutes > 0) {
    await cleanupLegacyTicketWorkflowExecutions();
    const timer = setInterval(() => {
      void cleanupLegacyTicketWorkflowExecutions();
    }, cleanupEveryMinutes * 60_000);
    timer.unref();
  }

  const maintenanceEveryMinutes = Number(env.XENA_MEMORY_MAINTENANCE_INTERVAL_MINUTES ?? "360");
  if (Number.isFinite(maintenanceEveryMinutes) && maintenanceEveryMinutes > 0) {
    const retentionDryRun = parseBooleanEnv(env.XENA_MEMORY_RETENTION_DRY_RUN);
    for (const project of projects) {
      const workflowId = `xena:memory-maintenance:${project.projectKey}`;
      try {
        await temporal.workflow.start("memoryMaintenanceWorkflow", {
          taskQueue: env.TEMPORAL_TASK_QUEUE,
          workflowId,
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          args: [
            {
              projectKey: project.projectKey,
              issueIdentifier: `MEMORY-${project.projectKey.toUpperCase()}`,
              intervalMinutes: maintenanceEveryMinutes,
              retentionDryRun,
            },
          ],
        });
        logger.info(
          {
            workflowId,
            projectKey: project.projectKey,
            intervalMinutes: maintenanceEveryMinutes,
            retentionDryRun,
          },
          "Memory maintenance workflow ensured",
        );
      } catch (err) {
        logger.warn(
          {
            err,
            workflowId,
            projectKey: project.projectKey,
          },
          "Failed to ensure memory maintenance workflow",
        );
      }
    }
  }

  const agentmailEveryMinutes = Number(env.XENA_AGENTMAIL_INTERVAL_MINUTES ?? "0");
  if (Number.isFinite(agentmailEveryMinutes) && agentmailEveryMinutes > 0) {
    const agentmailDryRun = parseBooleanEnv(env.XENA_AGENTMAIL_DRY_RUN);
    for (const project of projects) {
      const workflowId = `xena:agentmail:${project.projectKey}`;
      try {
        await temporal.workflow.start("agentmailWorkflow", {
          taskQueue: env.TEMPORAL_TASK_QUEUE,
          workflowId,
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          args: [
            {
              projectKey: project.projectKey,
              repoPath: project.repoPath,
              intervalMinutes: agentmailEveryMinutes,
              recipientEmail: env.XENA_OWNER_EMAIL,
              dryRun: agentmailDryRun,
              safeSenderEmails,
              ownerName: env.XENA_OWNER_NAME,
            },
          ],
        });
        logger.info(
          {
            workflowId,
            projectKey: project.projectKey,
            intervalMinutes: agentmailEveryMinutes,
            dryRun: agentmailDryRun,
            safeSenderCount: safeSenderEmails.length,
          },
          "AgentMail workflow ensured",
        );
      } catch (err) {
        logger.warn(
          {
            err,
            workflowId,
            projectKey: project.projectKey,
          },
          "Failed to ensure AgentMail workflow",
        );
      }
    }
  }

  // Best-effort dedupe for webhook retries within a single server process.
  const seenDeliveries = new Map<string, number>();
  const rememberDelivery = (id: string) => {
    const now = Date.now();
    seenDeliveries.set(id, now);
    if (seenDeliveries.size > 5000) {
      for (const [k, v] of seenDeliveries) {
        if (now - v > 6 * 60 * 60_000) seenDeliveries.delete(k); // 6h
        if (seenDeliveries.size <= 4000) break;
      }
    }
  };

  const fastify = Fastify({
    logger: loggerConfig,
    bodyLimit: 5 * 1024 * 1024,
  });

  logger.info(
    {
      workflowTypes: [...manusWebhookRoutes.keys()],
    },
    "Loaded Manus webhook route registry",
  );

  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  fastify.get("/healthz", async () => {
    return { ok: true };
  });
  // Back-compat for earlier probes.
  fastify.get("/health", async () => {
    return { ok: true };
  });

  const handleLinearWebhook = async (req: any, reply: any) => {
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: "expected raw body buffer" });
    }

    const signature = req.headers["linear-signature"];
    const sig =
      typeof signature === "string" ? signature : Array.isArray(signature) ? signature[0] : undefined;

    if (
      !verifyLinearWebhookSignature({
        webhookSecret: env.LINEAR_WEBHOOK_SECRET,
        rawBody,
        signatureHeader: sig,
      })
    ) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }

    // Optional replay protection if Linear provides timestamp.
    const ts = (payload as { webhookTimestamp?: number }).webhookTimestamp;
    if (typeof ts === "number") {
      const skewMs = Math.abs(Date.now() - ts);
      if (skewMs > 60_000) {
        return reply.code(400).send({ error: "stale webhook" });
      }
    }

    const delivery = req.headers["linear-delivery"];
    const deliveryId =
      typeof delivery === "string" ? delivery : Array.isArray(delivery) ? delivery[0] : undefined;
    if (deliveryId && seenDeliveries.has(deliveryId)) {
      return reply.code(200).send({ ok: true });
    }
    if (deliveryId) rememberDelivery(deliveryId);

    // Comment create: signal the ticket workflow (for operator commands / questions).
    if (isCommentCreate(payload)) {
      const issueId = payload.data.issueId;
      const authorId = payload.data.userId ?? payload.actor?.id ?? null;
      // Ignore Xena's own comments to reduce event storms.
      if (authorId && authorId === viewerId) {
        return reply.code(200).send({ ok: true });
      }

      const body = payload.data.body ?? "";
      const workflowId = workflowIdForIssue(issueId);

      // Best-effort: if the workflow is already running, signal it fast without extra Linear reads.
      try {
        const h = temporal.workflow.getHandle(workflowId);
        await h.signal(SIGNAL_LINEAR_COMMENT as any, {
          deliveryId,
          issueId,
          commentId: payload.data.id,
          body,
          authorId,
          createdAt: undefined,
        });
        return reply.code(200).send({ ok: true });
      } catch {
        // fall through - may not be running
      }

      // If the issue is assigned to Xena, (re)start the workflow on-demand so teammate interactions work
      // even if the previous execution failed (e.g. nondeterminism).
      const resolved = await resolveProjectRefForIssue(issueId);
      if (!resolved) return reply.code(200).send({ ok: true });
      const assignee = await (resolved.issue as any).assignee;
      const assigneeId = (assignee as any)?.id as string | undefined;
      const assignedToXena = assigneeId === viewerId;
      const command = parseXenaCommand(body);
      const founderEvaluateOnly = looksLikeXenaEvaluate(body) && isFounder(authorId);
      if (!assignedToXena && !founderEvaluateOnly) return reply.code(200).send({ ok: true });

      // Do not revive dormant workflows from generic synced comments.
      // Startup from comments requires an explicit Xena command.
      if (!command && !founderEvaluateOnly) {
        return reply.code(200).send({ ok: true });
      }

      const startMode: "normal" | "evaluate_only" = assignedToXena ? "normal" : "evaluate_only";

      if (command?.cmd === "restart") {
        await forceRestartWorkflow(issueId, resolved.projectRef, startMode);
      }

      // Signal-with-start: if already running, use it; if closed, start a new execution.
      await temporal.workflow.signalWithStart("operatorWorkflow", {
        signal: SIGNAL_LINEAR_COMMENT as any,
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        args: [{ issueId, project: resolved.projectRef, startMode }],
        signalArgs: [
          {
            deliveryId,
            issueId,
            commentId: payload.data.id,
            body,
            authorId,
            createdAt: undefined,
          },
        ] as any,
      });

      return reply.code(200).send({ ok: true });
    }

    // Issue assigned to Xena: start (or wake) the durable ticket orchestrator.
    if (!isIssueUpdateAssignedToXena(payload, viewerId)) {
      return reply.code(200).send({ ok: true });
    }

    const issueId = (payload as LinearIssueUpdatePayload).data.id;

    const resolved = await resolveProjectRefForIssue(issueId);
    if (!resolved) return reply.code(200).send({ ok: true });
    const { issue } = resolved;
    const team = await issue.team;
    if (!team) {
      await postComment({
        linear,
        issueId,
        body: `Issue is missing team information; can’t resolve project mapping.`,
      });
      return reply.code(200).send({ ok: true });
    }
    const proj = resolveProjectForTeamKey(projects, team.key);
    if (!proj) {
      await postComment({
        linear,
        issueId,
        body: `No project mapping for team key \`${team.key}\`. Add it to \`config/projects.json\`.`,
      });
      return reply.code(200).send({ ok: true });
    }

    const projectRef = resolved.projectRef;

    const workflowId = workflowIdForIssue(issueId);
    try {
      await forceRestartWorkflow(issueId, projectRef, "normal");
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : String(err);
      await postComment({
        linear,
        issueId,
        body: `Couldn’t start/wake the workflow.\n- Workflow: \`${workflowId}\`\n- Error: ${msg}`,
      });
    }

    return reply.code(200).send({ ok: true });
  };

  fastify.post("/webhooks/linear", handleLinearWebhook);

  // Back-compat with common Linear webhook path.
  fastify.post("/webhook", handleLinearWebhook);

  // GitHub webhook: currently used for wake/teardown signals (and future sandbox + Hyperbrowser automation).
  fastify.post("/github/webhook", async (req: any, reply) => {
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: "expected raw body buffer" });
    }

    const sigHeader = (() => {
      const v = req.headers["x-hub-signature-256"];
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return v[0];
      return undefined;
    })();

    if (
      !verifyGithubWebhookSignature({
        secret: env.GITHUB_WEBHOOK_SECRET,
        rawBody,
        signatureHeader: sigHeader,
      })
    ) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = (() => {
      const v = req.headers["x-github-event"];
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return v[0];
      return "";
    })();

    if (event === "ping") return reply.code(200).send({ ok: true });
    if (event !== "pull_request") return reply.code(200).send({ ok: true });

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }

    const pr = payload?.pull_request;
    const action = String(payload?.action ?? "");
    const repoFullName = String(payload?.repository?.full_name ?? pr?.base?.repo?.full_name ?? "");
    const prNumber = Number.parseInt(String(pr?.number ?? payload?.number ?? ""), 10);
    const prUrl = String(pr?.html_url ?? "");
    const headRef = String(pr?.head?.ref ?? "");
    const title = String(pr?.title ?? "");
    const body = typeof pr?.body === "string" ? pr.body : "";
    const merged = Boolean(pr?.merged);

    if (!repoFullName || !Number.isFinite(prNumber) || !prUrl || !headRef) {
      return reply.code(200).send({ ok: true });
    }

    const ticket =
      extractTicketIdentifier(headRef) ?? extractTicketIdentifier(title) ?? extractTicketIdentifier(body);
    if (!ticket) return reply.code(200).send({ ok: true });

    const parsed = parseLinearIdentifier(ticket);
    if (!parsed) return reply.code(200).send({ ok: true });

    const issuesConn = await (linear as any).issues({
      first: 1,
      filter: { team: { key: { eq: parsed.teamKey } }, number: { eq: parsed.number } },
    });
    const issue = (issuesConn?.nodes?.[0] as any) ?? null;
    if (!issue?.id) return reply.code(200).send({ ok: true });

    const assignee = await issue.assignee;
    const assigneeId = (assignee as any)?.id as string | undefined;
    // For close events, still route the event so Xena can tear down sandbox even if assignee changed.
    if (action !== "closed" && assigneeId !== viewerId) return reply.code(200).send({ ok: true });

    const resolved = await resolveProjectRefForIssue(issue.id);
    if (!resolved) return reply.code(200).send({ ok: true });

    const githubDeliveryId = asStringHeader(req.headers["x-github-delivery"]) ?? undefined;
    const signalPayload: GithubPullRequestSignalPayload = {
      deliveryId: githubDeliveryId,
      issueId: issue.id,
      action,
      repositoryFullName: repoFullName,
      prNumber,
      prUrl,
      branchName: headRef,
      prTitle: title,
      prBody: body,
      merged,
    };

    const workflowId = workflowIdForIssue(issue.id);

    // Important: PR close events should never revive a completed ticket workflow.
    // They are teardown/wake signals for an already-running execution only.
    if (action === "closed") {
      try {
        const handle = temporal.workflow.getHandle(workflowId);
        await handle.signal(SIGNAL_GITHUB_PR as any, signalPayload as any);
      } catch {
        // No running workflow to notify; ignore close events without starting new work.
      }
      return reply.code(200).send({ ok: true });
    }

    await temporal.workflow.signalWithStart("operatorWorkflow", {
      signal: SIGNAL_GITHUB_PR as any,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: [{ issueId: issue.id, project: resolved.projectRef }],
      signalArgs: [signalPayload] as any,
    });

    return reply.code(200).send({ ok: true });
  });

  fastify.post("/webhooks/agentmail", async (req: any, reply) => {
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: "expected raw body buffer" });
    }

    const verified = verifyAgentmailWebhookSignature({
      secret: env.AGENTMAIL_WEBHOOK_SECRET,
      rawBody,
      headers: req.headers as Record<string, unknown>,
    });
    if (!verified.ok) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const payload = asObject(verified.payload) as AgentmailWebhookPayload;
    const deliveryId =
      asStringHeader(req.headers["webhook-id"]) ??
      asStringHeader(req.headers["svix-id"]) ??
      asString(payload.event_id) ??
      asString(payload.data?.id);
    if (deliveryId && seenDeliveries.has(deliveryId)) {
      return reply.code(200).send({ ok: true });
    }
    if (deliveryId) rememberDelivery(deliveryId);

    const projectsList = projects;
    const defaultProject = projectsList[0];
    if (!defaultProject) {
      return reply.code(200).send({ ok: true });
    }

    const eventType = asString(payload.event_type) ?? asString(payload.type) ?? "unknown";
    const data = asObject(payload.data);
    const message = asObject(payload.message ?? data.message ?? data);
    const from = asObject(message.from);
    const attachmentsRaw = Array.isArray(message.attachments) ? message.attachments : [];
    const attachments = attachmentsRaw
      .map(parseAgentmailAttachmentSignal)
      .filter((attachment): attachment is NonNullable<AgentmailEventSignal["attachments"]>[number] => attachment !== null);
    const signalPayload: AgentmailEventSignal = {
      deliveryId,
      eventType,
      eventId: asString(payload.event_id) ?? asString(data.event_id),
      inboxId: asString(message.inbox_id) ?? asString(message.inboxId) ?? asString(data.inbox_id) ?? asString(data.inboxId),
      messageId:
        asString(message.message_id) ??
        asString(message.email_id) ??
        asString(message.messageId) ??
        asString(message.id) ??
        asString(data.email_id) ??
        asString(data.message_id) ??
        asString(data.id),
      threadId: asString(message.thread_id) ?? asString(message.threadId) ?? asString(data.thread_id) ?? asString(data.threadId),
      fromEmail:
        parseAddressEmail(message.from) ??
        parseAddressEmail(from.email) ??
        parseAddressEmail(data.from_email) ??
        parseAddressEmail(data.sender_email),
      fromName: asString(from.name) ?? asString(data.from_name),
      fromRaw: asString(message.from),
      subject: asString(message.subject) ?? asString(data.subject),
      text:
        asString(message.extracted_text) ??
        asString(message.extractedText) ??
        asString(message.text) ??
        asString(data.text) ??
        asString(data.text_body) ??
        asString(data.body_text) ??
        asString(data.body) ??
        "",
      html: asString(message.html) ?? asString(data.html),
      extractedText: asString(message.extracted_text) ?? asString(message.extractedText),
      extractedHtml: asString(message.extracted_html) ?? asString(message.extractedHtml),
      attachments,
      replyToEmails: extractEmails(message.reply_to),
      toEmails: extractEmails(message.to ?? data.to),
      ccEmails: extractEmails(message.cc ?? data.cc),
      receivedAt:
        asString(message.timestamp) ??
        asString(message.created_at) ??
        asString(data.received_at) ??
        asString(data.created_at),
    };

    const agentmailEveryMinutes = Number(env.XENA_AGENTMAIL_INTERVAL_MINUTES ?? "0");
    const normalizedAgentmailInterval =
      Number.isFinite(agentmailEveryMinutes) && agentmailEveryMinutes >= 0
        ? Math.floor(agentmailEveryMinutes)
        : 0;
    const agentmailDryRun = parseBooleanEnv(env.XENA_AGENTMAIL_DRY_RUN);
    const workflowId = `xena:agentmail:${defaultProject.projectKey}`;

    await temporal.workflow.signalWithStart("agentmailWorkflow", {
      signal: SIGNAL_AGENTMAIL_EVENT as any,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: [
        {
          projectKey: defaultProject.projectKey,
          repoPath: defaultProject.repoPath,
          intervalMinutes: normalizedAgentmailInterval,
          recipientEmail: env.XENA_OWNER_EMAIL,
          dryRun: agentmailDryRun,
          safeSenderEmails,
          ownerName: env.XENA_OWNER_NAME,
        },
      ],
      signalArgs: [signalPayload] as any,
    });

    return reply.code(200).send({ ok: true });
  });

  fastify.get("/webhooks/manus", async () => ({ ok: true }));

  fastify.post("/webhooks/manus", async (req: any, reply) => {
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: "expected raw body buffer" });
    }

    let payload: ManusWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }

    const forwardedProtoRaw = asStringHeader(req.headers["x-forwarded-proto"]);
    const forwardedHostRaw = asStringHeader(req.headers["x-forwarded-host"]);
    const forwardedProto = forwardedProtoRaw?.split(",")[0]?.trim();
    const forwardedHost = forwardedHostRaw?.split(",")[0]?.trim();
    const inferredProto = forwardedProto || (req.protocol === "https" ? "https" : "http");
    const inferredHost = forwardedHost || asStringHeader(req.headers.host) || "localhost";
    const requestBaseUrl = env.XENA_PUBLIC_BASE_URL ?? `${inferredProto}://${inferredHost}`;
    const requestUrl = new URL(req.raw.url ?? "/webhooks/manus", requestBaseUrl);
    const requireSignature = parseBooleanEnv(env.MANUS_WEBHOOK_REQUIRE_SIGNATURE ?? "true");
    if (requireSignature) {
      const verification = await verifyManusWebhookSignature({
        apiKey: env.MANUS_API_KEY,
        baseUrl: env.MANUS_BASE_URL,
        pinnedPublicKeyPem: env.MANUS_WEBHOOK_PUBLIC_KEY,
        requestUrl: requestUrl.toString(),
        rawBody,
        signatureHeader: asStringHeader(req.headers["x-webhook-signature"]),
        timestampHeader: asStringHeader(req.headers["x-webhook-timestamp"]),
      });
      if (!verification.ok) {
        return reply.code(401).send({ error: `invalid webhook signature: ${verification.reason}` });
      }
    }
    if (env.MANUS_WEBHOOK_TOKEN) {
      const providedToken = requestUrl.searchParams.get("token")?.trim();
      if (!providedToken || providedToken !== env.MANUS_WEBHOOK_TOKEN) {
        return reply.code(401).send({ error: "invalid token" });
      }
    }

    const deliveryId =
      asStringHeader(req.headers["webhook-id"]) ??
      asString(payload.event_id) ??
      asString(payload.data?.event_id) ??
      asString(payload.data?.id);
    if (deliveryId && seenDeliveries.has(deliveryId)) {
      return reply.code(200).send({ ok: true });
    }
    if (deliveryId) rememberDelivery(deliveryId);

    const data = asObject(payload.data);
    const taskDetail = asObject(payload.task_detail ?? data.task_detail ?? data.taskDetail);
    const progressDetail = asObject(payload.progress_detail ?? data.progress_detail ?? data.progressDetail);
    const attachmentsRaw = Array.isArray(taskDetail.attachments) ? taskDetail.attachments : [];
    const attachments = attachmentsRaw
      .map(parseManusAttachmentSignal)
      .filter((attachment): attachment is NonNullable<ManusEventSignal["attachments"]>[number] => attachment !== null);

    const signalPayload: ManusEventSignal = {
      deliveryId,
      eventType: asString(payload.event_type) ?? asString(payload.type) ?? "unknown",
      eventId: asString(payload.event_id) ?? asString(data.event_id),
      taskId:
        asString(taskDetail.task_id) ??
        asString(taskDetail.taskId) ??
        asString(progressDetail.task_id) ??
        asString(progressDetail.taskId) ??
        asString(data.task_id) ??
        asString(data.taskId),
      taskTitle: asString(taskDetail.task_title) ?? asString(taskDetail.taskTitle),
      taskUrl: asString(taskDetail.task_url) ?? asString(taskDetail.taskUrl),
      stopReason: asString(taskDetail.stop_reason) ?? asString(taskDetail.stopReason),
      message: asString(taskDetail.message) ?? asString(progressDetail.message) ?? asString(data.message),
      attachments,
      receivedAt: asString(data.received_at) ?? new Date().toISOString(),
    };

    const defaultProjectForFallback = projects[0];
    if (!defaultProjectForFallback) {
      return reply.code(500).send({ error: "no configured projects available for Manus webhook fallback routing" });
    }
    const fallbackAgentmailWorkflowId = `xena:agentmail:${defaultProjectForFallback.projectKey}`;
    let workflowTypeRaw = requestUrl.searchParams.get("workflowType")?.trim();
    let workflowId = requestUrl.searchParams.get("workflowId")?.trim();
    let requestedProjectKey = requestUrl.searchParams.get("projectKey")?.trim();

    if (!workflowTypeRaw || !workflowId) {
      workflowTypeRaw = "agentmail";
      workflowId = fallbackAgentmailWorkflowId;
      requestedProjectKey = requestedProjectKey || defaultProjectForFallback.projectKey;
      logger.warn(
        {
          eventType: signalPayload.eventType,
          eventId: signalPayload.eventId,
          taskId: signalPayload.taskId,
          routeFallback: {
            workflowType: workflowTypeRaw,
            workflowId,
            projectKey: requestedProjectKey,
          },
        },
        "Manus webhook missing routing query params; applied default agentmail route fallback",
      );
    }

    const workflowType = normalizeWorkflowTypeKey(workflowTypeRaw);
    const currentManusRoutes = await getManusWebhookRoutes();
    const route = currentManusRoutes.get(workflowType);
    if (!route) {
      return reply.code(400).send({
        error: `unsupported workflowType: ${workflowTypeRaw}`,
        supportedWorkflowTypes: [...currentManusRoutes.keys()],
      });
    }

    if (!workflowId) {
      return reply.code(400).send({ error: "missing workflowId query parameter" });
    }

    if (route.dispatchMode === "signalOnly") {
      try {
        const handle = temporal.workflow.getHandle(workflowId);
        await handle.signal(route.signalName as any, signalPayload as any);
      } catch (error) {
        logger.warn(
          {
            err: error,
            workflowType: route.workflowType,
            workflowName: route.workflowName,
            workflowId,
          },
          "Manus webhook signal-only dispatch failed",
        );
        return reply.code(409).send({
          error: `signalOnly dispatch failed for workflowId ${workflowId}`,
        });
      }
      return reply.code(200).send({ ok: true });
    }

    let workflowArgs: unknown[] = [];
    if (route.bootstrap === "agentmail") {
      if (!requestedProjectKey) {
        return reply.code(400).send({ error: "missing projectKey query parameter" });
      }
      const targetProject =
        projects.find((project) => project.projectKey === requestedProjectKey) ??
        projects.find((project) => project.projectKey.toLowerCase() === requestedProjectKey.toLowerCase());
      if (!targetProject) {
        return reply.code(400).send({ error: `unknown projectKey: ${requestedProjectKey}` });
      }
      const agentmailEveryMinutes = Number(env.XENA_AGENTMAIL_INTERVAL_MINUTES ?? "0");
      const normalizedAgentmailInterval =
        Number.isFinite(agentmailEveryMinutes) && agentmailEveryMinutes >= 0
          ? Math.floor(agentmailEveryMinutes)
          : 0;
      const agentmailDryRun = parseBooleanEnv(env.XENA_AGENTMAIL_DRY_RUN);
      workflowArgs = [
        {
          projectKey: targetProject.projectKey,
          repoPath: targetProject.repoPath,
          intervalMinutes: normalizedAgentmailInterval,
          recipientEmail: env.XENA_OWNER_EMAIL,
          dryRun: agentmailDryRun,
          safeSenderEmails,
          ownerName: env.XENA_OWNER_NAME,
        },
      ];
    }

    await temporal.workflow.signalWithStart(route.workflowName, {
      signal: route.signalName as any,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      args: workflowArgs as any,
      signalArgs: [signalPayload] as any,
    });

    return reply.code(200).send({ ok: true });
  });

  const port = Number(env.XENA_HTTP_PORT);
  await fastify.listen({ port, host: "0.0.0.0" });
  logger.info({ port, viewerId }, "Xena webhook server listening");
}

main().catch((err) => {
  logger.error({ err }, "Server failed");
  process.exitCode = 1;
});
