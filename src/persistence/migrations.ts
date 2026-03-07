import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Sql } from "postgres";

import { RUNTIME_SCHEMA } from "./db.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const QUOTED_RUNTIME_SCHEMA = `"${RUNTIME_SCHEMA}"`;

export async function runMigrations(sql: Sql): Promise<void> {
  const filenames = (await readdir(MIGRATIONS_DIR))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  await sql.unsafe(`create schema if not exists ${QUOTED_RUNTIME_SCHEMA}`);
  await sql.unsafe(`
    create table if not exists ${QUOTED_RUNTIME_SCHEMA}.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  for (const filename of filenames) {
    const existing = await sql.unsafe<{ filename: string }[]>(
      `select filename from ${QUOTED_RUNTIME_SCHEMA}.schema_migrations where filename = $1`,
      [filename]
    );

    if (existing.length > 0) {
      continue;
    }

    const migration = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");

    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction.unsafe(
        `insert into ${QUOTED_RUNTIME_SCHEMA}.schema_migrations (filename) values ($1)`,
        [filename]
      );
    });
  }
}

export async function resetRuntimeSchema(sql: Sql): Promise<void> {
  await sql.unsafe(`drop schema if exists ${QUOTED_RUNTIME_SCHEMA} cascade`);
}

export async function listRuntimeTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = ${RUNTIME_SCHEMA}
    order by table_name
  `;

  return rows.map((row) => row.table_name);
}

export async function listAppliedMigrations(sql: Sql): Promise<string[]> {
  const tableExists = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = ${RUNTIME_SCHEMA}
        and table_name = 'schema_migrations'
    ) as exists
  `;

  if (!tableExists[0]?.exists) {
    return [];
  }

  const rows = await sql.unsafe<{ filename: string }[]>(
    `select filename from ${QUOTED_RUNTIME_SCHEMA}.schema_migrations order by filename`
  );

  return rows.map((row) => row.filename);
}
