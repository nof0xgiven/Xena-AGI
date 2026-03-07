import { describe, expect, it } from "vitest";

import {
  classifyIngressAttempt,
  createIngressScopeKey
} from "../../../src/ingress/idempotency.js";

const existingEnvelope = {
  schema_version: "1.0",
  ingress_id: "ingress_123",
  event_type: "task.created",
  idempotency_key: "idem_123",
  business_id: "biz_123",
  project_id: "proj_123",
  task_id: null,
  agent_id: "agent_supervisor",
  payload: {
    body: "hello",
    meta: {
      attempt: 1
    }
  },
  emitted_by: "external.crm",
  external_event_id: "ext_123",
  received_at: "2026-03-07T09:00:00.000Z"
} as const;

describe("ingress idempotency", () => {
  it("builds a scope key from business context and idempotency key", () => {
    expect(createIngressScopeKey(existingEnvelope)).toBe("biz_123::idem_123");
  });

  it("classifies the first ingress as new", () => {
    expect(classifyIngressAttempt(undefined, existingEnvelope).kind).toBe("new");
  });

  it("classifies logically identical duplicates as duplicates", () => {
    const reorderedPayloadEnvelope = {
      ...existingEnvelope,
      payload: {
        meta: {
          attempt: 1
        },
        body: "hello"
      }
    };

    const decision = classifyIngressAttempt(
      existingEnvelope,
      reorderedPayloadEnvelope
    );

    expect(decision.kind).toBe("duplicate");
  });

  it("rejects conflicting duplicates within the same business context", () => {
    const decision = classifyIngressAttempt(existingEnvelope, {
      ...existingEnvelope,
      payload: {
        body: "different"
      }
    });

    expect(decision.kind).toBe("conflict");
    if (decision.kind !== "conflict") {
      throw new Error("expected conflicting ingress");
    }

    expect(decision.reason).toMatch(/conflicting duplicate/i);
  });

  it("treats another business with the same idempotency key as a new ingress", () => {
    const decision = classifyIngressAttempt(existingEnvelope, {
      ...existingEnvelope,
      business_id: "biz_other"
    });

    expect(decision.kind).toBe("new");
  });
});
