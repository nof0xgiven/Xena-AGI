import { createDatabaseClient } from "../src/persistence/db.js";
import { resetRuntimeSchema, runMigrations } from "../src/persistence/migrations.js";

const sql = createDatabaseClient();

async function main(): Promise<void> {
  await resetRuntimeSchema(sql);
  await runMigrations(sql);
}

main()
  .then(async () => {
    await sql.end({ timeout: 1 });
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await sql.end({ timeout: 1 });
    process.exitCode = 1;
  });
