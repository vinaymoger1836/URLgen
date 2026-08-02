/**
 * Creates the DynamoDB table from `infra/dynamodb-table.json` and enables TTL.
 *
 * Idempotent: safe to re-run. Works against DynamoDB Local (set DYNAMODB_ENDPOINT)
 * and against real AWS. Exists so the table can be created without the AWS CLI.
 *
 *   pnpm table:create
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";

import { ConfigError, loadConfig } from "../src/config.js";

const TTL_ATTRIBUTE = "ttl";

async function main(): Promise<void> {
  const config = loadConfig();

  const here = dirname(fileURLToPath(import.meta.url));
  const definitionPath = resolve(here, "../../../infra/dynamodb-table.json");
  const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as CreateTableCommandInput;

  /* The table name in .env wins, so a developer can point at their own table. */
  definition.TableName = config.DYNAMODB_TABLE;

  const client = new DynamoDBClient({
    region: config.AWS_REGION,
    ...(config.DYNAMODB_ENDPOINT !== undefined ? { endpoint: config.DYNAMODB_ENDPOINT } : {}),
    ...(config.DYNAMODB_ENDPOINT !== undefined
      ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
  });

  const target = config.DYNAMODB_ENDPOINT ?? `AWS ${config.AWS_REGION}`;
  console.warn(`Creating table "${config.DYNAMODB_TABLE}" on ${target} ...`);

  try {
    await client.send(new CreateTableCommand(definition));
    console.warn("  table created");
  } catch (error) {
    if (errorName(error) === "ResourceInUseException") {
      console.warn("  table already exists — nothing to do");
    } else {
      throw error;
    }
  }

  await client.send(new DescribeTableCommand({ TableName: config.DYNAMODB_TABLE }));

  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: config.DYNAMODB_TABLE,
        TimeToLiveSpecification: { Enabled: true, AttributeName: TTL_ATTRIBUTE },
      }),
    );
    console.warn(`  TTL enabled on "${TTL_ATTRIBUTE}"`);
  } catch (error) {
    /* Already enabled, or DynamoDB Local without TTL support — neither is fatal. */
    console.warn(`  TTL not enabled (${errorName(error) ?? "unknown error"}) — continuing`);
  }

  console.warn("Done.");
}

function errorName(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "name" in error) {
    const { name } = error as { name?: unknown };
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
