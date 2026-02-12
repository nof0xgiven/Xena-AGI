import { Context } from "@temporalio/activity";
import { appendTrustEvent, readTrustEventsWithDiagnostics } from "../../telemetry/sinks.js";
import { computeTrustScore } from "../../telemetry/trustScore.js";
import type {
  TrustEvent,
  TrustEventInput,
  TrustScoreSnapshot,
} from "../../telemetry/events.js";

function resolveWorkflowId(explicitWorkflowId?: string): string {
  if (explicitWorkflowId && explicitWorkflowId.trim()) return explicitWorkflowId;
  return Context.current().info.workflowExecution.workflowId;
}

export async function telemetryAppendTrustEvent(opts: {
  workflowId?: string;
  event: TrustEventInput;
}): Promise<TrustEvent> {
  const workflowId = resolveWorkflowId(opts.workflowId);
  return appendTrustEvent({
    workflowId,
    event: opts.event,
  });
}

export async function telemetryComputeTrustSnapshot(opts: {
  workflowId?: string;
}): Promise<TrustScoreSnapshot> {
  const workflowId = resolveWorkflowId(opts.workflowId);
  const read = await readTrustEventsWithDiagnostics({ workflowId });
  return computeTrustScore(workflowId, read.events);
}

export async function telemetryReadTrustDiagnostics(opts: {
  workflowId?: string;
}): Promise<{ malformedLineNumbers: number[]; eventCount: number }> {
  const workflowId = resolveWorkflowId(opts.workflowId);
  const read = await readTrustEventsWithDiagnostics({ workflowId });
  return {
    malformedLineNumbers: read.malformedLineNumbers,
    eventCount: read.events.length,
  };
}
