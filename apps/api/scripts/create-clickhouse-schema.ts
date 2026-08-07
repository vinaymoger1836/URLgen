/**
 * Applies `infra/clickhouse/schema.sql`.
 *
 * Idempotent: every statement in the file is `IF NOT EXISTS`, so re-running it is
 * the supported way to apply a change rather than something to be careful about.
 * Exists so the schema can be created without a `clickhouse-client` binary on the
 * machine — the HTTP interface is all that is needed.
 *
 *   pnpm clickhouse:create
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@clickhouse/client";

import { ConfigError, loadConfig } from "../src/config.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, "../../../infra/clickhouse/schema.sql");
  const schema = readFileSync(schemaPath, "utf8").replaceAll("{db}", config.CLICKHOUSE_DATABASE);

  /* No `database` on the client: the first statement is the CREATE DATABASE, and
     connecting to a database that does not exist yet fails before it can run. */
  const client = createClient({
    url: config.CLICKHOUSE_URL,
    username: config.CLICKHOUSE_USER,
    password: config.CLICKHOUSE_PASSWORD,
  });

  try {
    const statements = splitStatements(schema);
    console.log(`Applying ${String(statements.length)} statements to ${config.CLICKHOUSE_URL}`);

    for (const statement of statements) {
      await client.command({ query: statement });
      console.log(`  ok: ${summarize(statement)}`);
    }

    console.log(`Schema applied to database "${config.CLICKHOUSE_DATABASE}".`);
  } finally {
    await client.close();
  }
}

/**
 * Splits the file into statements.
 *
 * Comment lines are stripped first, because a trailing `--` comment containing a
 * semicolon would otherwise split a statement in half — and the failure would be a
 * syntax error pointing at the wrong line.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The first line of a statement, for a legible progress log. */
function summarize(statement: string): string {
  return statement.split("\n")[0]?.trim() ?? statement.slice(0, 60);
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
