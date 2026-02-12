import { proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

type MemoryMaintenanceArgs = {
  projectKey: string;
  issueIdentifier?: string;
  intervalMinutes?: number;
  retentionDryRun?: boolean;
};

type MetaActivities = Pick<
  typeof activities,
  "mem0DistillMemorySnapshot" | "mem0ApplyRetentionPolicy" | "mem0Add"
>;

const meta = proxyActivities<MetaActivities>({
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
  },
});

const DEFAULT_INTERVAL_MINUTES = 360;
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 1440;

function normalizeIntervalMinutes(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_INTERVAL_MINUTES;
  const normalized = Math.floor(value);
  if (normalized < MIN_INTERVAL_MINUTES) return MIN_INTERVAL_MINUTES;
  if (normalized > MAX_INTERVAL_MINUTES) return MAX_INTERVAL_MINUTES;
  return normalized;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    return (err as any).message;
  }
  return String(err);
}

export async function memoryMaintenanceWorkflow(args: MemoryMaintenanceArgs): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  const issueIdentifier = args.issueIdentifier?.trim() || `MEMORY-${args.projectKey.toUpperCase()}`;
  const intervalMinutes = normalizeIntervalMinutes(args.intervalMinutes);
  const retentionDryRun = args.retentionDryRun === true;

  while (true) {
    const tickIso = new Date(Date.now()).toISOString();
    const runId = `${workflowId}:${tickIso}`;

    try {
      await meta.mem0DistillMemorySnapshot({
        projectKey: args.projectKey,
        issueIdentifier,
        query: `${args.projectKey} memory maintenance tick ${tickIso}`,
        stage: "maintenance",
        intent: "periodic_memory_maintenance",
        runId,
      });

      const retention = await meta.mem0ApplyRetentionPolicy({
        projectKey: args.projectKey,
        issueIdentifier,
        runId,
        dryRun: retentionDryRun,
        agentId: "workflow.memory.maintenance",
      });

      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[memory_maintenance_tick_v1]",
          `workflow_id: ${workflowId}`,
          `project: ${args.projectKey}`,
          `interval_minutes: ${intervalMinutes}`,
          `retention_dry_run: ${retentionDryRun}`,
          `retention_summary: scanned=${retention.scanned}; archived=${retention.archived}; deleted=${retention.deleted}; errors=${retention.errors}`,
          `tick_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "memory_maintenance_tick",
        stage: "maintenance",
        outcome: retention.errors > 0 ? "blocked" : "success",
        source: "workflow.memory.maintenance",
        runId,
        appId: "xena",
        agentId: "workflow.memory.maintenance",
        infer: false,
        enableGraph: false,
        tags: ["memory", "maintenance", retentionDryRun ? "dry-run" : "applied"],
      });
    } catch (err) {
      const message = errorMessage(err);
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[memory_maintenance_tick_v1]",
          `workflow_id: ${workflowId}`,
          `project: ${args.projectKey}`,
          `interval_minutes: ${intervalMinutes}`,
          `retention_dry_run: ${retentionDryRun}`,
          `error: ${message}`,
          `tick_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "memory_maintenance_tick_failed",
        stage: "maintenance",
        outcome: "failed",
        source: "workflow.memory.maintenance",
        runId,
        appId: "xena",
        agentId: "workflow.memory.maintenance",
        infer: false,
        enableGraph: false,
        tags: ["memory", "maintenance", "failed"],
      });
    }

    await sleep(`${intervalMinutes} minutes`);
  }
}
