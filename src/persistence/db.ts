import postgres, { type Sql } from "postgres";

import { loadProcessEnv } from "../config/env.js";

export const RUNTIME_SCHEMA = "xena_runtime";

export function createDatabaseClient(): Sql {
  const env = loadProcessEnv();

  return postgres(env.databaseUrl, {
    max: 1,
    prepare: false
  });
}
