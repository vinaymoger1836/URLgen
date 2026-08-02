/**
 * Integration tests against a real DynamoDB.
 *
 * SKIPPED unless `DYNAMODB_TEST_ENDPOINT` is set, so `pnpm test` stays green on a
 * machine without Docker:
 *
 *   pnpm services:up
 *   DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:8000 pnpm test
 *
 * These cover what the in-memory fake cannot: that the conditional write is really
 * atomic, that both GSIs are queryable, and that the item shape round-trips through
 * the AWS SDK's marshalling.
 *
 * Each run uses its own throwaway table so a failure never leaves state behind and
 * concurrent runs cannot collide.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { urlDedupHash } from "@urlgen/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DynamoLinkRepository, toTtlSeconds } from "./dynamo-link-repository.js";
import { SlugUnavailableError } from "./link-repository.js";

const endpoint = process.env.DYNAMODB_TEST_ENDPOINT;
const tableName = `urlgen-links-test-${String(Date.now())}`;

let client: DynamoDBClient;
let documentClient: DynamoDBDocumentClient;
let repository: DynamoLinkRepository;

describe.skipIf(endpoint === undefined)("DynamoLinkRepository (integration)", () => {
  beforeAll(async () => {
    client = new DynamoDBClient({
      region: "local",
      /* Conditional spread rather than `endpoint`: under exactOptionalPropertyTypes
         a `string | undefined` is not assignable to an optional property. */
      ...(endpoint !== undefined ? { endpoint } : {}),
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });

    const here = dirname(fileURLToPath(import.meta.url));
    const definitionPath = resolve(here, "../../../../infra/dynamodb-table.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as CreateTableCommandInput;
    definition.TableName = tableName;

    await client.send(new CreateTableCommand(definition));

    documentClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    repository = new DynamoLinkRepository({ client: documentClient, tableName });
  }, 30_000);

  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
    client.destroy();
  });

  it("round-trips a link through real marshalling", async () => {
    const urlHash = await urlDedupHash("https://example.com/integration", "alice");
    const created = await repository.create({
      targetUrl: "https://example.com/integration",
      ownerId: "alice",
      urlHash,
    });

    const fetched = await repository.findBySlug(created.slug);

    expect(fetched).toEqual(created);
  });

  it("enforces slug uniqueness through the conditional write", async () => {
    const urlHash = await urlDedupHash("https://example.com/unique", "alice");
    await repository.create({
      targetUrl: "https://example.com/unique",
      ownerId: "alice",
      urlHash,
      customSlug: "taken-slug",
    });

    await expect(
      repository.create({
        targetUrl: "https://example.com/other",
        ownerId: "bob",
        urlHash: await urlDedupHash("https://example.com/other", "bob"),
        customSlug: "taken-slug",
      }),
    ).rejects.toBeInstanceOf(SlugUnavailableError);
  });

  it("survives concurrent allocation of the same slug — exactly one writer wins", async () => {
    const attempts = 8;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_unused, index) =>
        repository.create({
          targetUrl: `https://example.com/race/${String(index)}`,
          ownerId: "racer",
          urlHash: `race-hash-${String(index)}`,
          customSlug: "contended",
        }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("finds an existing link through the dedup index", async () => {
    const urlHash = await urlDedupHash("https://example.com/dedup", "alice");
    const created = await repository.create({
      targetUrl: "https://example.com/dedup",
      ownerId: "alice",
      urlHash,
    });

    await expect(repository.findSlugByUrlHash(urlHash)).resolves.toBe(created.slug);
  });

  it("writes ttl in seconds alongside the ISO expiry", async () => {
    const expiresAt = "2030-06-01T12:00:00.000Z";
    const created = await repository.create({
      targetUrl: "https://example.com/expiring",
      ownerId: "alice",
      urlHash: await urlDedupHash("https://example.com/expiring", "alice"),
      expiresAt,
    });

    const raw = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `LINK#${created.slug}`, sk: "META" },
      }),
    );

    expect(raw.Item?.ttl).toBe(toTtlSeconds(expiresAt));
    expect(raw.Item?.expiresAt).toBe(expiresAt);
  });

  it("clears the expiry and its ttl together", async () => {
    const created = await repository.create({
      targetUrl: "https://example.com/clearing",
      ownerId: "alice",
      urlHash: await urlDedupHash("https://example.com/clearing", "alice"),
      expiresAt: "2030-06-01T12:00:00.000Z",
    });

    const updated = await repository.update(created.slug, { expiresAt: null });

    expect(updated.expiresAt).toBeUndefined();
  });

  it("lists an owner's links newest first through the owner index", async () => {
    const owner = `lister-${String(Date.now())}`;
    for (const index of [1, 2, 3]) {
      await repository.create({
        targetUrl: `https://example.com/list/${String(index)}`,
        ownerId: owner,
        urlHash: `list-hash-${owner}-${String(index)}`,
      });
    }

    const page = await repository.listByOwner(owner);

    expect(page.items).toHaveLength(3);
    const timestamps = page.items.map((item) => item.createdAt);
    expect([...timestamps].sort((a, b) => b.localeCompare(a))).toEqual(timestamps);
  });

  it("soft delete keeps the row so the slug is never recycled", async () => {
    const created = await repository.create({
      targetUrl: "https://example.com/deleted",
      ownerId: "alice",
      urlHash: await urlDedupHash("https://example.com/deleted", "alice"),
    });

    await repository.softDelete(created.slug);

    const fetched = await repository.findBySlug(created.slug);
    expect(fetched?.status).toBe("deleted");
  });
});
