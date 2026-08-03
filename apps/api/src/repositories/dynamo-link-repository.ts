/**
 * DynamoDB implementation of `LinkRepository` over the single-table design in
 * `infra/dynamodb-table.json`.
 *
 * Slug allocation is the interesting part: rather than reserving slugs through a
 * counter or a lock, a random slug is written with `attribute_not_exists(pk)`.
 * DynamoDB evaluates that condition atomically, so two concurrent writers racing
 * on the same slug cannot both succeed — the loser gets
 * `ConditionalCheckFailedException` and simply draws again. No coordination, no
 * read-before-write, and the check costs nothing extra because it rides along with
 * the write that was happening anyway.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  generateSlug,
  linkRecordSchema,
  linkSummarySchema,
  type LinkRecord,
  type LinkSummary,
} from "@urlgen/shared";

import {
  LinkNotFoundError,
  SlugAllocationError,
  SlugUnavailableError,
  type CreateLinkInput,
  type LinkPage,
  type LinkRepository,
  type ListLinksOptions,
  type UpdateLinkPatch,
} from "./link-repository.js";

const SORT_KEY = "META";
const URL_HASH_INDEX = "urlHash-index";
const OWNER_INDEX = "owner-index";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export interface DynamoLinkRepositoryOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** Attempts before giving up on random slug allocation. */
  slugAttempts?: number;
  /** Injectable for tests; defaults to the CSPRNG-backed generator. */
  generateSlugFn?: () => string;
  /** Injectable for deterministic timestamps in tests. */
  now?: () => Date;
}

export class DynamoLinkRepository implements LinkRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #slugAttempts: number;
  readonly #generateSlug: () => string;
  readonly #now: () => Date;

  public constructor(options: DynamoLinkRepositoryOptions) {
    this.#client = options.client;
    this.#tableName = options.tableName;
    this.#slugAttempts = options.slugAttempts ?? 5;
    this.#generateSlug = options.generateSlugFn ?? (() => generateSlug());
    this.#now = options.now ?? (() => new Date());
  }

  public async create(input: CreateLinkInput): Promise<LinkRecord> {
    if (input.customSlug !== undefined) {
      const record = this.#buildRecord(input, input.customSlug);
      try {
        await this.#putIfSlugFree(record);
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          throw new SlugUnavailableError(input.customSlug);
        }
        throw error;
      }
      return record;
    }

    for (let attempt = 0; attempt < this.#slugAttempts; attempt += 1) {
      const record = this.#buildRecord(input, this.#generateSlug());
      try {
        await this.#putIfSlugFree(record);
        return record;
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          continue; // collision — draw another slug
        }
        throw error;
      }
    }

    throw new SlugAllocationError(this.#slugAttempts);
  }

  public async findBySlug(slug: string): Promise<LinkRecord | undefined> {
    const result = await this.#client.send(
      new GetCommand({ TableName: this.#tableName, Key: keyFor(slug) }),
    );
    return result.Item === undefined ? undefined : toLinkRecord(result.Item);
  }

  public async findSlugByUrlHash(urlHash: string): Promise<string | undefined> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        IndexName: URL_HASH_INDEX,
        KeyConditionExpression: "gsi1pk = :hash",
        ExpressionAttributeValues: { ":hash": urlHashKey(urlHash) },
        Limit: 1,
      }),
    );

    const item = result.Items?.[0];
    if (item === undefined) {
      return undefined;
    }

    /* GSI1 is KEYS_ONLY, so the slug comes back inside the partition key. */
    const pk: unknown = item.pk;
    return typeof pk === "string" ? pk.replace(/^LINK#/, "") : undefined;
  }

  public async update(slug: string, patch: UpdateLinkPatch): Promise<LinkRecord> {
    const sets: string[] = ["#updatedAt = :updatedAt"];
    const removes: string[] = [];
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = { ":updatedAt": this.#now().toISOString() };

    if (patch.targetUrl !== undefined) {
      sets.push("#targetUrl = :targetUrl");
      names["#targetUrl"] = "targetUrl";
      values[":targetUrl"] = patch.targetUrl;
    }
    if (patch.urlHash !== undefined) {
      sets.push("#urlHash = :urlHash", "#gsi1pk = :gsi1pk");
      names["#urlHash"] = "urlHash";
      names["#gsi1pk"] = "gsi1pk";
      values[":urlHash"] = patch.urlHash;
      values[":gsi1pk"] = urlHashKey(patch.urlHash);
    }
    if (patch.status !== undefined) {
      sets.push("#status = :status");
      names["#status"] = "status"; // reserved word in DynamoDB
      values[":status"] = patch.status;
    }
    if (patch.expiresAt === null) {
      removes.push("#expiresAt", "#ttl");
      names["#expiresAt"] = "expiresAt";
      names["#ttl"] = "ttl";
    } else if (patch.expiresAt !== undefined) {
      sets.push("#expiresAt = :expiresAt", "#ttl = :ttl");
      names["#expiresAt"] = "expiresAt";
      names["#ttl"] = "ttl";
      values[":expiresAt"] = patch.expiresAt;
      values[":ttl"] = toTtlSeconds(patch.expiresAt);
    }

    const expression = [
      `SET ${sets.join(", ")}`,
      removes.length > 0 ? `REMOVE ${removes.join(", ")}` : "",
    ]
      .filter((part) => part !== "")
      .join(" ");

    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.#tableName,
          Key: keyFor(slug),
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: "attribute_exists(pk)",
          ReturnValues: "ALL_NEW",
        }),
      );
      return toLinkRecord(result.Attributes ?? {});
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw new LinkNotFoundError(slug);
      }
      throw error;
    }
  }

  public async softDelete(slug: string): Promise<void> {
    await this.update(slug, { status: "deleted" });
  }

  /**
   * Hard delete. Not part of the interface and not reachable from the API — it
   * exists so integration tests can clean up after themselves.
   */
  public async hardDelete(slug: string): Promise<void> {
    await this.#client.send(new DeleteCommand({ TableName: this.#tableName, Key: keyFor(slug) }));
  }

  public async listByOwner(ownerId: string, options: ListLinksOptions = {}): Promise<LinkPage> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        IndexName: OWNER_INDEX,
        KeyConditionExpression: "gsi2pk = :owner",
        ExpressionAttributeValues: { ":owner": ownerKey(ownerId) },
        /* Newest first — gsi2sk is the ISO createdAt, which sorts lexicographically. */
        ScanIndexForward: false,
        Limit: limit,
        ...(options.cursor !== undefined
          ? { ExclusiveStartKey: decodeCursor(options.cursor) }
          : {}),
      }),
    );

    return {
      items: (result.Items ?? []).map((item) => toLinkSummary(item)),
      ...(result.LastEvaluatedKey !== undefined
        ? { cursor: encodeCursor(result.LastEvaluatedKey) }
        : {}),
    };
  }

  #buildRecord(input: CreateLinkInput, slug: string): LinkRecord {
    const timestamp = this.#now().toISOString();
    return {
      slug,
      targetUrl: input.targetUrl,
      ownerId: input.ownerId,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      urlHash: input.urlHash,
      clickCount: 0,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.punycode === true ? { punycode: true } : {}),
    };
  }

  async #putIfSlugFree(record: LinkRecord): Promise<void> {
    await this.#client.send(
      new PutCommand({
        TableName: this.#tableName,
        Item: toItem(record),
        /* The whole concurrency story in one line. */
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }
}

function keyFor(slug: string): { pk: string; sk: string } {
  return { pk: `LINK#${slug}`, sk: SORT_KEY };
}

function urlHashKey(urlHash: string): string {
  return `HASH#${urlHash}`;
}

function ownerKey(ownerId: string): string {
  return `USER#${ownerId}`;
}

/** Maps a domain record onto the stored item, adding the index keys. */
export function toItem(record: LinkRecord): Record<string, unknown> {
  return {
    ...keyFor(record.slug),
    gsi1pk: urlHashKey(record.urlHash),
    gsi2pk: ownerKey(record.ownerId),
    gsi2sk: record.createdAt,
    ...record,
    ...(record.expiresAt !== undefined ? { ttl: toTtlSeconds(record.expiresAt) } : {}),
  };
}

/**
 * Validates on read rather than trusting the table.
 *
 * A stored item that no longer matches the schema is a bug worth surfacing loudly,
 * not something to paper over with a partially-populated object.
 */
export function toLinkRecord(item: Record<string, unknown>): LinkRecord {
  const parsed = linkRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new Error(
      `Stored link item does not match the expected schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Rebuilds a link summary from an owner-index item.
 *
 * A query against `owner-index` returns only the index keys, the table keys, and
 * the INCLUDE list — not the whole item. `slug`, `ownerId` and `createdAt` are
 * absent, but each is already present verbatim inside a key that the index
 * projects for free (`pk`, `gsi2pk`, `gsi2sk`), so they are unwrapped from there
 * rather than duplicated into the projection at the cost of GSI write capacity.
 */
export function toLinkSummary(item: Record<string, unknown>): LinkSummary {
  const candidate = {
    ...item,
    slug: stripPrefix(item["pk"], "LINK#"),
    ownerId: stripPrefix(item["gsi2pk"], "USER#"),
    createdAt: item["gsi2sk"],
  };

  const parsed = linkSummarySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Owner-index item does not match the expected projection: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Unwraps the value carried inside a prefixed key, or undefined if the shape is wrong. */
function stripPrefix(value: unknown, prefix: string): string | undefined {
  return typeof value === "string" && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : undefined;
}

/** DynamoDB TTL is epoch SECONDS, not milliseconds — milliseconds would be year 56000. */
export function toTtlSeconds(isoTimestamp: string): number {
  return Math.floor(Date.parse(isoTimestamp) / 1000);
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) {
      throw new TypeError("cursor is not an object");
    }
    return decoded as Record<string, unknown>;
  } catch {
    throw new TypeError("Invalid pagination cursor");
  }
}

/** True for the error DynamoDB raises when a conditional write loses its race. */
export function isConditionalCheckFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}
