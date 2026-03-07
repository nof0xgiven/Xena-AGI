import { describe, expect, it } from "vitest";

import { loadEnv } from "../../../src/config/env.js";

describe("loadEnv", () => {
  it("provides local development defaults when optional values are omitted", () => {
    const env = loadEnv({});

    expect(env.databaseUrl).toBe("postgresql://xena:xena@127.0.0.1:55432/xena");
    expect(env.minio.endpoint).toBe("http://127.0.0.1:19000");
    expect(env.trigger.projectRef).toBeUndefined();
  });

  it("requires Trigger credentials when Trigger-aware paths are requested", () => {
    expect(() => loadEnv({}, { requireTrigger: true })).toThrowError(
      /trigger project ref/i
    );
  });

  it("accepts the repo-specific Trigger project env alias", () => {
    const env = loadEnv(
      {
        TRIGGER_PROJ_REF: "proj_repo_alias",
        TRIGGER_SECRET_KEY: "tr_dev_secret"
      },
      { requireTrigger: true }
    );

    expect(env.trigger.projectRef).toBe("proj_repo_alias");
  });

  it("rejects malformed service URLs", () => {
    expect(() =>
      loadEnv({
        XENA_DATABASE_URL: "not-a-url"
      })
    ).toThrowError(/database url/i);
  });
});
