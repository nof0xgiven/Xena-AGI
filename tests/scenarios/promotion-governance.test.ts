import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../../src/contracts/index.js";
import { createMemoryService } from "../../src/memory/service.js";
import { createDatabaseClient } from "../../src/persistence/db.js";
import {
  resetRuntimeSchema,
  runMigrations
} from "../../src/persistence/migrations.js";
import { createDurableStore } from "../../src/persistence/repositories/durable-store.js";
import { createReconciliationJobs } from "../../src/reconciliation/jobs.js";

describe.sequential("promotion governance", () => {
  const sql = createDatabaseClient();
  const store = createDurableStore(sql);
  const memoryService = createMemoryService(sql);
  const jobs = createReconciliationJobs({
    store
  });

  beforeAll(async () => {
    await resetRuntimeSchema(sql);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await resetRuntimeSchema(sql);
    await sql.end({ timeout: 1 });
  });

  it("promotes curated local memories into provenance-preserving global patterns", async () => {
    const memoryId = `memory_${randomUUID()}`;

    await memoryService.upsertMemoryRecord({
      schema_version: SCHEMA_VERSION,
      memory_id: memoryId,
      memory_class: "procedural",
      scope: "project",
      business_id: "biz_memory",
      project_id: "proj_memory",
      agent_id: null,
      title: "Launch checklist",
      summary: "A reusable launch checklist",
      content: {
        checklist: ["announce launch", "publish creative"]
      },
      keywords: ["launch", "checklist"],
      source_type: "task_outcome",
      source_ref: "task_launch",
      provenance: [
        {
          memory_id: memoryId
        }
      ],
      confidence: 0.95,
      version: 1,
      supersedes_memory_id: null,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const request = await jobs.createPromotionRequest({
      abstractedContent: {
        playbook: ["announce launch", "publish creative"]
      },
      abstractedTitle: "Reusable launch checklist",
      provenanceRefs: ["task_launch"],
      redactionNotes: "Removed project-specific references",
      requestedByAgentId: "agent_supervisor",
      sourceMemoryIds: [memoryId]
    });
    const promoted = await jobs.approvePromotionRequest({
      promotionRequestId: request.promotion_request_id,
      reviewedBy: "curator_1"
    });

    expect(promoted.scope).toBe("global_patterns");
    expect(promoted.business_id).toBeNull();
    expect(promoted.project_id).toBeNull();
    expect(promoted.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_memory_ids: [memoryId]
        })
      ])
    );
  });

  it("rejects promotion requests that still expose business-specific fields", async () => {
    const request = await jobs.createPromotionRequest({
      abstractedContent: {
        business_id: "biz_sensitive",
        playbook: ["do not ship raw tenant data"]
      },
      abstractedTitle: "Unsafe content",
      provenanceRefs: ["task_sensitive"],
      redactionNotes: null,
      requestedByAgentId: "agent_supervisor",
      sourceMemoryIds: [`memory_${randomUUID()}`]
    });

    await expect(
      jobs.approvePromotionRequest({
        promotionRequestId: request.promotion_request_id,
        reviewedBy: "curator_1"
      })
    ).rejects.toThrow(/business-specific/i);

    const persistedRequest = await store.getPromotionRequest(
      request.promotion_request_id
    );

    expect(persistedRequest).toMatchObject({
      status: "rejected"
    });
  });
});
