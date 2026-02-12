import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  TRUST_EVENTS_FILENAME,
  isTrustActor,
  isTrustEventType,
  type TrustActor,
  type TrustEvent,
  type TrustEventInput,
  type TrustEventMetadata,
  type TrustEventMetadataValue,
} from "./events.js";

const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

export type TrustEventSinkOptions = {
  workflowId: string;
  rootDir?: string;
};

export type TrustEventReadDiagnostics = {
  events: TrustEvent[];
  malformedLineNumbers: number[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMetadataValue(value: unknown): value is TrustEventMetadataValue {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

function assertWorkflowId(workflowId: string): string {
  const candidate = workflowId.trim();
  if (!candidate || !WORKFLOW_ID_PATTERN.test(candidate)) {
    throw new Error(`Invalid workflowId "${workflowId}". Expected ${WORKFLOW_ID_PATTERN}`);
  }
  return candidate;
}

function normalizeMetadata(value: unknown): TrustEventMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, TrustEventMetadataValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim()) continue;
    if (!isMetadataValue(raw)) continue;
    out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function normalizeActor(value: unknown): TrustActor | undefined {
  if (typeof value !== "string") return undefined;
  if (!isTrustActor(value)) return undefined;
  return value;
}

function normalizeNumber(value: unknown, bounds?: { min?: number; max?: number }): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (bounds?.min != null && value < bounds.min) return undefined;
  if (bounds?.max != null && value > bounds.max) return undefined;
  return value;
}

function normalizeNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEvent(workflowId: string, input: TrustEventInput): TrustEvent {
  const occurredAt = normalizeIsoTimestamp(input.occurredAt) ?? new Date().toISOString();
  const actor = input.actor ?? "system";
  const value = normalizeNumber(input.value, { min: 0, max: 10 });
  const weightOverride = normalizeNumber(input.weightOverride);
  const note = normalizeNote(input.note);
  const metadata = normalizeMetadata(input.metadata);

  return {
    id: randomUUID(),
    workflowId,
    type: input.type,
    actor,
    occurredAt,
    ...(value !== undefined ? { value } : {}),
    ...(weightOverride !== undefined ? { weightOverride } : {}),
    ...(note ? { note } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parsePersistedEvent(value: unknown, expectedWorkflowId: string): TrustEvent | null {
  if (!isRecord(value)) return null;

  const id = typeof value.id === "string" && value.id.trim() ? value.id : null;
  const workflowId =
    typeof value.workflowId === "string" && value.workflowId.trim() ? value.workflowId.trim() : null;
  const type = typeof value.type === "string" && isTrustEventType(value.type) ? value.type : null;
  const actor = normalizeActor(value.actor);
  const occurredAt = normalizeIsoTimestamp(value.occurredAt);

  if (!id || !workflowId || !type || !actor || !occurredAt) return null;
  if (workflowId !== expectedWorkflowId) return null;

  const parsed: TrustEvent = {
    id,
    workflowId,
    type,
    actor,
    occurredAt,
  };

  const numericValue = normalizeNumber(value.value, { min: 0, max: 10 });
  if (numericValue !== undefined) parsed.value = numericValue;

  const weightOverride = normalizeNumber(value.weightOverride);
  if (weightOverride !== undefined) parsed.weightOverride = weightOverride;

  const note = normalizeNote(value.note);
  if (note) parsed.note = note;

  const metadata = normalizeMetadata(value.metadata);
  if (metadata) parsed.metadata = metadata;

  return parsed;
}

export function resolveTrustEventsPath(opts: TrustEventSinkOptions): string {
  const workflowId = assertWorkflowId(opts.workflowId);
  const rootDir = path.resolve(opts.rootDir ?? process.cwd());
  return path.join(rootDir, "runs", workflowId, TRUST_EVENTS_FILENAME);
}

export async function appendTrustEvent(opts: {
  workflowId: string;
  event: TrustEventInput;
  rootDir?: string;
}): Promise<TrustEvent> {
  const workflowId = assertWorkflowId(opts.workflowId);
  const event = normalizeEvent(workflowId, opts.event);
  const filePath = resolveTrustEventsPath({ workflowId, rootDir: opts.rootDir });

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");

  return event;
}

export async function readTrustEventsWithDiagnostics(
  opts: TrustEventSinkOptions,
): Promise<TrustEventReadDiagnostics> {
  const workflowId = assertWorkflowId(opts.workflowId);
  const filePath = resolveTrustEventsPath({ workflowId, rootDir: opts.rootDir });

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], malformedLineNumbers: [] };
    }
    throw err;
  }

  const events: TrustEvent[] = [];
  const malformedLineNumbers: number[] = [];
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      malformedLineNumbers.push(index + 1);
      continue;
    }

    const parsedEvent = parsePersistedEvent(parsedJson, workflowId);
    if (!parsedEvent) {
      malformedLineNumbers.push(index + 1);
      continue;
    }
    events.push(parsedEvent);
  }

  events.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
  );

  return { events, malformedLineNumbers };
}

export async function readTrustEvents(opts: TrustEventSinkOptions): Promise<TrustEvent[]> {
  const result = await readTrustEventsWithDiagnostics(opts);
  return result.events;
}
