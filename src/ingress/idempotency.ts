import { createHash } from "node:crypto";

import {
  type WebhookEnvelope,
  WebhookEnvelopeSchema
} from "../contracts/index.js";

export type IngressDecision =
  | { kind: "new"; scopeKey: string; fingerprint: string }
  | { kind: "duplicate"; scopeKey: string; fingerprint: string }
  | {
      kind: "conflict";
      scopeKey: string;
      fingerprint: string;
      reason: string;
    };

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableStringify(nestedValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function createIngressScopeKey(envelope: WebhookEnvelope): string {
  const parsed = WebhookEnvelopeSchema.parse(envelope);
  const businessScope = parsed.business_id ?? "__global__";

  return `${businessScope}::${parsed.idempotency_key}`;
}

export function createIngressFingerprint(envelope: WebhookEnvelope): string {
  const parsed = WebhookEnvelopeSchema.parse(envelope);
  const fingerprintPayload = {
    event_type: parsed.event_type,
    idempotency_key: parsed.idempotency_key,
    business_id: parsed.business_id,
    project_id: parsed.project_id,
    task_id: parsed.task_id,
    agent_id: parsed.agent_id,
    payload: parsed.payload,
    emitted_by: parsed.emitted_by,
    external_event_id: parsed.external_event_id
  };

  return createHash("sha256")
    .update(stableStringify(fingerprintPayload))
    .digest("hex");
}

export function classifyIngressAttempt(
  existing: WebhookEnvelope | undefined,
  incoming: WebhookEnvelope
): IngressDecision {
  const parsedIncoming = WebhookEnvelopeSchema.parse(incoming);
  const scopeKey = createIngressScopeKey(parsedIncoming);
  const fingerprint = createIngressFingerprint(parsedIncoming);

  if (!existing) {
    return { kind: "new", scopeKey, fingerprint };
  }

  const parsedExisting = WebhookEnvelopeSchema.parse(existing);
  const existingScopeKey = createIngressScopeKey(parsedExisting);

  if (existingScopeKey !== scopeKey) {
    return { kind: "new", scopeKey, fingerprint };
  }

  const existingFingerprint = createIngressFingerprint(parsedExisting);

  if (existingFingerprint === fingerprint) {
    return { kind: "duplicate", scopeKey, fingerprint };
  }

  return {
    kind: "conflict",
    scopeKey,
    fingerprint,
    reason: "Conflicting duplicate ingress for the same business scope"
  };
}
