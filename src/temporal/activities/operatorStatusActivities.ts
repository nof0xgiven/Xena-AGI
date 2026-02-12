import { createLinearClient } from "../../linear.js";
import { createMem0Client, mem0ListEntries, type Mem0SearchEntry } from "../../mem0.js";
import { MEMORY_NAMESPACES } from "../../memory/policy.js";
import { loadRegistryBundle } from "../../registry/loader.js";
import type { ToolDefinition } from "../../registry/schema.js";
import { loadWorkerEnv } from "../../env.js";
import { createTemporalClient } from "../client.js";

export type OperatorTemporalTask = {
  workflowId: string;
  runId?: string;
  status?: string;
  workflowType?: string;
  startedAt?: string;
};

export type OperatorLinearTask = {
  id: string;
  identifier?: string;
  title: string;
  teamKey?: string;
  stateName?: string;
  stateType?: string;
  updatedAt?: string;
  url?: string;
};

export type OperatorEmailFollowupTask = {
  id: string;
  title: string;
  fromEmail?: string;
  subject?: string;
  intent?: string;
  outcome?: string;
  updatedAt?: string;
};

export type OperatorMemoryFollowupTask = {
  id: string;
  title: string;
  source?: string;
  intent?: string;
  outcome?: string;
  updatedAt?: string;
};

export type OperatorTaskProbe = {
  toolId: string;
  status: "ok" | "error" | "unsupported";
  observed: number;
  error?: string;
};

export type OperatorTaskSnapshot = {
  capturedAt: string;
  probes: OperatorTaskProbe[];
  temporalTasks: OperatorTemporalTask[];
  linearTasks: OperatorLinearTask[];
  emailFollowupTasks: OperatorEmailFollowupTask[];
  memoryFollowupTasks: OperatorMemoryFollowupTask[];
  summary: string;
};

type ProbeContext = {
  projectKey?: string;
  maxTemporalTasks: number;
  maxLinearTasks: number;
  maxEmailTasks: number;
  maxMemoryTasks: number;
  getWorkflowStateEntries: () => Promise<Mem0SearchEntry[]>;
};

type ProbeResult = {
  temporalTasks?: OperatorTemporalTask[];
  linearTasks?: OperatorLinearTask[];
  emailFollowupTasks?: OperatorEmailFollowupTask[];
  memoryFollowupTasks?: OperatorMemoryFollowupTask[];
};

type ProbeAdapter = (ctx: ProbeContext) => Promise<ProbeResult>;

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseField(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "im");
  const match = content.match(pattern);
  if (!match?.[1]) return undefined;
  return match[1].trim();
}

function normalizeEventIntentLabel(intent: string | undefined): string {
  if (!intent) return "workflow follow-up";
  return intent.replace(/_/g, " ").trim();
}

async function probeTemporalRunningTasks(ctx: ProbeContext): Promise<ProbeResult> {
  const env = loadWorkerEnv();
  const temporalTasks: OperatorTemporalTask[] = [];
  const temporal = await createTemporalClient({
    TEMPORAL_ADDRESS: env.TEMPORAL_ADDRESS,
    TEMPORAL_NAMESPACE: env.TEMPORAL_NAMESPACE,
    TEMPORAL_TASK_QUEUE: env.TEMPORAL_TASK_QUEUE,
  });

  let scanned = 0;
  for await (const wf of temporal.workflow.list()) {
    scanned += 1;
    if (scanned > 250) break;
    const workflowId = asString((wf as any).workflowId);
    if (!workflowId || !workflowId.startsWith("xena:")) continue;
    const status = asString((wf as any).status?.name) ?? asString((wf as any).status);
    if (status && status.toUpperCase() !== "RUNNING") continue;
    temporalTasks.push({
      workflowId,
      runId: asString((wf as any).runId),
      status,
      workflowType: asString((wf as any).type),
      startedAt: toIso((wf as any).startTime),
    });
    if (temporalTasks.length >= ctx.maxTemporalTasks) break;
  }

  return { temporalTasks };
}

async function probeLinearAssignedTasks(ctx: ProbeContext): Promise<ProbeResult> {
  const env = loadWorkerEnv();
  const linearTasks: OperatorLinearTask[] = [];
  const linear = createLinearClient(env.LINEAR_API_KEY);
  const viewer = await linear.viewer;
  const issuesConn = await (linear as any).issues({
    first: Math.max(ctx.maxLinearTasks * 3, 20),
    filter: {
      assignee: { id: { eq: viewer.id } },
    },
  });
  const nodes = Array.isArray(issuesConn?.nodes) ? issuesConn.nodes : [];
  for (const issue of nodes) {
    if (!issue?.id || !issue?.title) continue;
    const state = await issue.state;
    const stateType = asString(state?.type)?.toLowerCase();
    if (stateType === "completed" || stateType === "canceled") continue;
    const team = await issue.team;
    linearTasks.push({
      id: issue.id,
      identifier: asString(issue.identifier),
      title: asString(issue.title) ?? issue.title,
      teamKey: asString(team?.key),
      stateName: asString(state?.name),
      stateType,
      updatedAt: toIso(issue.updatedAt),
      url: asString(issue.url),
    });
    if (linearTasks.length >= ctx.maxLinearTasks) break;
  }
  return { linearTasks };
}

async function loadWorkflowStateEntries(projectKey: string, limit: number): Promise<Mem0SearchEntry[]> {
  const env = loadWorkerEnv();
  const mem0 = createMem0Client({
    apiKey: env.MEM0_API_KEY,
    baseUrl: env.MEM0_BASE_URL,
  });
  const listed = await mem0ListEntries({
    mem0,
    userId: `project:${projectKey}`,
    namespace: MEMORY_NAMESPACES.WORKFLOW_STATE,
    page: 1,
    pageSize: Math.max(50, limit * 8),
  });
  return listed.entries;
}

async function probeEmailFollowupTasks(ctx: ProbeContext): Promise<ProbeResult> {
  const entries = await ctx.getWorkflowStateEntries();
  const items = entries
    .filter((entry) => {
      const source = asString(entry.metadata.source);
      if (source !== "workflow.agentmail") return false;
      const intent = asString(entry.metadata.intent);
      const outcome = asString(entry.metadata.outcome);
      if (intent === "agentmail_clarification_sent") return true;
      if (outcome === "blocked" || outcome === "failed") return true;
      return false;
    })
    .sort((left, right) => {
      const leftTs = Date.parse(left.updatedAt ?? left.createdAt ?? "") || 0;
      const rightTs = Date.parse(right.updatedAt ?? right.createdAt ?? "") || 0;
      return rightTs - leftTs;
    })
    .slice(0, ctx.maxEmailTasks)
    .map((entry, index) => {
      const fromEmail = parseField(entry.memory, "from") ?? parseField(entry.memory, "from_email");
      const subject = parseField(entry.memory, "subject");
      const intent = asString(entry.metadata.intent);
      const outcome = asString(entry.metadata.outcome);
      const title =
        intent === "agentmail_clarification_sent"
          ? `Pending email clarification${fromEmail ? ` (${fromEmail})` : ""}`
          : outcome === "blocked" || outcome === "failed"
            ? `Investigate blocked email action${fromEmail ? ` (${fromEmail})` : ""}`
            : "Review email follow-up";
      return {
        id: entry.id ?? `email-followup-${index + 1}`,
        title,
        fromEmail,
        subject,
        intent,
        outcome,
        updatedAt: toIso(entry.updatedAt ?? entry.createdAt),
      } satisfies OperatorEmailFollowupTask;
    });

  return { emailFollowupTasks: items };
}

async function probeMemoryFollowupTasks(ctx: ProbeContext): Promise<ProbeResult> {
  const entries = await ctx.getWorkflowStateEntries();
  const items = entries
    .filter((entry) => {
      const source = asString(entry.metadata.source);
      if (source === "workflow.agentmail") return false;
      const outcome = asString(entry.metadata.outcome);
      return outcome === "blocked" || outcome === "failed";
    })
    .sort((left, right) => {
      const leftTs = Date.parse(left.updatedAt ?? left.createdAt ?? "") || 0;
      const rightTs = Date.parse(right.updatedAt ?? right.createdAt ?? "") || 0;
      return rightTs - leftTs;
    })
    .slice(0, ctx.maxMemoryTasks)
    .map((entry, index) => {
      const source = asString(entry.metadata.source);
      const intent = asString(entry.metadata.intent);
      const outcome = asString(entry.metadata.outcome);
      return {
        id: entry.id ?? `memory-followup-${index + 1}`,
        title: `Follow up: ${normalizeEventIntentLabel(intent)}`,
        source,
        intent,
        outcome,
        updatedAt: toIso(entry.updatedAt ?? entry.createdAt),
      } satisfies OperatorMemoryFollowupTask;
    });

  return { memoryFollowupTasks: items };
}

const TASK_PROBE_ADAPTERS: Record<string, ProbeAdapter> = {
  "tool.tasks.temporal.running": probeTemporalRunningTasks,
  "tool.tasks.linear.assigned": probeLinearAssignedTasks,
  "tool.tasks.email.followups": probeEmailFollowupTasks,
  "tool.tasks.memory.followups": probeMemoryFollowupTasks,
};

function summarizeTemporalTasks(tasks: OperatorTemporalTask[]): string[] {
  if (tasks.length === 0) return ["- none"];
  return tasks.map((task) => {
    const parts = [
      task.workflowId,
      task.status ? `status=${task.status}` : null,
      task.startedAt ? `started=${task.startedAt}` : null,
    ].filter((part): part is string => Boolean(part));
    return `- ${parts.join("; ")}`;
  });
}

function summarizeLinearTasks(tasks: OperatorLinearTask[]): string[] {
  if (tasks.length === 0) return ["- none"];
  return tasks.map((task) => {
    const prefix = task.identifier ? `${task.identifier}: ` : "";
    const parts = [
      `${prefix}${task.title}`,
      task.stateName ? `state=${task.stateName}` : null,
      task.url ? `url=${task.url}` : null,
    ].filter((part): part is string => Boolean(part));
    return `- ${parts.join("; ")}`;
  });
}

function summarizeEmailFollowups(tasks: OperatorEmailFollowupTask[]): string[] {
  if (tasks.length === 0) return ["- none"];
  return tasks.map((task) => {
    const parts = [
      task.title,
      task.subject ? `subject=${task.subject}` : null,
      task.intent ? `intent=${task.intent}` : null,
      task.updatedAt ? `updated=${task.updatedAt}` : null,
    ].filter((part): part is string => Boolean(part));
    return `- ${parts.join("; ")}`;
  });
}

function summarizeMemoryFollowups(tasks: OperatorMemoryFollowupTask[]): string[] {
  if (tasks.length === 0) return ["- none"];
  return tasks.map((task) => {
    const parts = [
      task.title,
      task.source ? `source=${task.source}` : null,
      task.intent ? `intent=${task.intent}` : null,
      task.updatedAt ? `updated=${task.updatedAt}` : null,
    ].filter((part): part is string => Boolean(part));
    return `- ${parts.join("; ")}`;
  });
}

function isTaskProbeTool(tool: ToolDefinition): boolean {
  return (
    tool.enabled &&
    tool.capabilities.includes("tasks.probe") &&
    tool.surface.taskRoles.includes("source")
  );
}

export async function operatorGetTaskSnapshot(opts?: {
  projectKey?: string;
  maxTemporalTasks?: number;
  maxLinearTasks?: number;
  maxEmailTasks?: number;
  maxMemoryTasks?: number;
}): Promise<OperatorTaskSnapshot> {
  const maxTemporalTasks = Math.max(1, Math.min(50, opts?.maxTemporalTasks ?? 12));
  const maxLinearTasks = Math.max(1, Math.min(50, opts?.maxLinearTasks ?? 12));
  const maxEmailTasks = Math.max(1, Math.min(30, opts?.maxEmailTasks ?? 8));
  const maxMemoryTasks = Math.max(1, Math.min(30, opts?.maxMemoryTasks ?? 8));
  const capturedAt = new Date().toISOString();

  const registry = await loadRegistryBundle();
  const taskProbeTools = registry.tools
    .filter(isTaskProbeTool)
    .sort((left, right) => {
      if (right.surface.authority !== left.surface.authority) {
        return right.surface.authority - left.surface.authority;
      }
      return left.id.localeCompare(right.id);
    });

  const probes: OperatorTaskProbe[] = [];
  const temporalTasks: OperatorTemporalTask[] = [];
  const linearTasks: OperatorLinearTask[] = [];
  const emailFollowupTasks: OperatorEmailFollowupTask[] = [];
  const memoryFollowupTasks: OperatorMemoryFollowupTask[] = [];

  let workflowStateEntryCache: Mem0SearchEntry[] | null = null;
  const getWorkflowStateEntries = async (): Promise<Mem0SearchEntry[]> => {
    if (workflowStateEntryCache !== null) return workflowStateEntryCache;
    if (!opts?.projectKey) {
      workflowStateEntryCache = [];
      return workflowStateEntryCache;
    }
    workflowStateEntryCache = await loadWorkflowStateEntries(
      opts.projectKey,
      Math.max(maxEmailTasks, maxMemoryTasks),
    );
    return workflowStateEntryCache;
  };

  for (const tool of taskProbeTools) {
    const adapter = TASK_PROBE_ADAPTERS[tool.id];
    if (!adapter) {
      probes.push({
        toolId: tool.id,
        status: "unsupported",
        observed: 0,
        error: "No probe adapter registered for tool.",
      });
      continue;
    }

    if ((tool.id === "tool.tasks.email.followups" || tool.id === "tool.tasks.memory.followups") && !opts?.projectKey) {
      probes.push({
        toolId: tool.id,
        status: "unsupported",
        observed: 0,
        error: "projectKey is required for memory-backed follow-up probes.",
      });
      continue;
    }

    try {
      const result = await adapter({
        projectKey: opts?.projectKey,
        maxTemporalTasks,
        maxLinearTasks,
        maxEmailTasks,
        maxMemoryTasks,
        getWorkflowStateEntries,
      });
      temporalTasks.push(...(result.temporalTasks ?? []));
      linearTasks.push(...(result.linearTasks ?? []));
      emailFollowupTasks.push(...(result.emailFollowupTasks ?? []));
      memoryFollowupTasks.push(...(result.memoryFollowupTasks ?? []));
      probes.push({
        toolId: tool.id,
        status: "ok",
        observed:
          (result.temporalTasks?.length ?? 0) +
          (result.linearTasks?.length ?? 0) +
          (result.emailFollowupTasks?.length ?? 0) +
          (result.memoryFollowupTasks?.length ?? 0),
      });
    } catch (error) {
      probes.push({
        toolId: tool.id,
        status: "error",
        observed: 0,
        error: (error as Error).message,
      });
    }
  }

  const probeLines =
    probes.length === 0
      ? ["- none (no enabled task probe tools found in registry)"]
      : probes.map((probe) => {
          const parts = [
            probe.toolId,
            `status=${probe.status}`,
            `observed=${probe.observed}`,
            probe.error ? `error=${probe.error}` : null,
          ].filter((part): part is string => Boolean(part));
          return `- ${parts.join("; ")}`;
        });

  return {
    capturedAt,
    probes,
    temporalTasks,
    linearTasks,
    emailFollowupTasks,
    memoryFollowupTasks,
    summary: [
      "Live task snapshot",
      `captured_at: ${capturedAt}`,
      "",
      "Task probes:",
      ...probeLines,
      "",
      "Temporal workflows:",
      ...summarizeTemporalTasks(temporalTasks),
      "",
      "Linear assigned tasks:",
      ...summarizeLinearTasks(linearTasks),
      "",
      "Email follow-ups:",
      ...summarizeEmailFollowups(emailFollowupTasks),
      "",
      "Memory follow-ups:",
      ...summarizeMemoryFollowups(memoryFollowupTasks),
    ].join("\n"),
  };
}
