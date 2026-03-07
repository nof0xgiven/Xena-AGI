import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createObjectStore } from "../../../src/artifacts/object-store.js";

describe.sequential("object store", () => {
  it("writes and reads object payloads from local MinIO", async () => {
    const store = createObjectStore();
    const key = `artifacts/${randomUUID()}.txt`;

    await store.ensureBucket();
    await store.putText({
      key,
      text: "durable artifact payload",
      contentType: "text/plain",
      metadata: {
        purpose: "integration-test"
      }
    });

    const object = await store.getText(key);

    expect(object.text).toBe("durable artifact payload");
    expect(object.metadata.purpose).toBe("integration-test");
  });
});
