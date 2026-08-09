/**
 * Where abuse reports live.
 *
 * ## Two stores, on purpose
 *
 * A report is written to DynamoDB under the link's own partition —
 * `LINK#<slug>` / `REPORT#<createdAt>#<id>` — so "show me everything about this
 * slug" is one Query against a partition that already exists. That is the durable
 * record.
 *
 * The *review queue* ("which slugs need looking at") is a different question, and
 * answering it from DynamoDB would need a third global secondary index. That is
 * not free here: the always-free 25 WCU is account-wide and each GSI is
 * provisioned on top of the table, so the current 11/7/7 split is exactly 25 and a
 * third index would mean re-cutting all three. For a queue that holds a handful of
 * slugs and can be rebuilt by re-reading reports, a Redis sorted set scored by
 * report time is the right size of tool.
 *
 * Losing Redis therefore loses the queue, not the reports. That is the trade, and
 * it is stated rather than discovered: the reports are the record, the queue is an
 * index over them.
 */

import { randomUUID } from "node:crypto";

import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  abuseReportSchema,
  type AbuseQueueEntry,
  type AbuseReason,
  type AbuseReport,
} from "@urlgen/shared";
import type { Redis } from "ioredis";

/** What a caller supplies. Everything else is minted here. */
export interface RecordAbuseReportInput {
  slug: string;
  reason: AbuseReason;
  details?: string | undefined;
}

export interface AbuseRepository {
  record(input: RecordAbuseReportInput): Promise<AbuseReport>;
  listBySlug(slug: string, limit?: number): Promise<AbuseReport[]>;
}

/** The review queue, kept separately from the durable record. */
export interface AbuseQueue {
  add(slug: string, at: Date): Promise<void>;
  list(limit?: number): Promise<AbuseQueueEntry[]>;
  /** Drops a slug once it has been actioned, whichever way it went. */
  clear(slug: string): Promise<void>;
}

const SORT_KEY_PREFIX = "REPORT#";
const DEFAULT_REPORT_LIMIT = 50;

/**
 * How long a report is kept.
 *
 * Long enough to establish a pattern across repeat offenders, bounded so a
 * free-tier table is not storing complaints about links that were deleted years
 * ago. Enforced by DynamoDB TTL, same mechanism as link expiry.
 */
const REPORT_RETENTION_DAYS = 365;

export interface DynamoAbuseRepositoryOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  /** Injectable for deterministic tests. */
  generateId?: () => string;
}

export class DynamoAbuseRepository implements AbuseRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #now: () => Date;
  readonly #generateId: () => string;

  public constructor(options: DynamoAbuseRepositoryOptions) {
    this.#client = options.client;
    this.#tableName = options.tableName;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? (() => randomUUID());
  }

  public async record(input: RecordAbuseReportInput): Promise<AbuseReport> {
    const createdAt = this.#now().toISOString();
    const report: AbuseReport = {
      reportId: this.#generateId(),
      slug: input.slug,
      reason: input.reason,
      createdAt,
      ...(input.details !== undefined && input.details !== "" ? { details: input.details } : {}),
    };

    await this.#client.send(
      new PutCommand({
        TableName: this.#tableName,
        Item: {
          pk: `LINK#${input.slug}`,
          /* The id is part of the sort key, not just an attribute: two reports
             minted in the same millisecond would otherwise be one overwriting the
             other, and a burst of reports is the normal shape of a real one. */
          sk: `${SORT_KEY_PREFIX}${createdAt}#${report.reportId}`,
          ...report,
          ttl: retentionTtlSeconds(this.#now()),
        },
      }),
    );

    return report;
  }

  public async listBySlug(slug: string, limit = DEFAULT_REPORT_LIMIT): Promise<AbuseReport[]> {
    const result = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `LINK#${slug}`, ":prefix": SORT_KEY_PREFIX },
        /* Newest first: the sort key starts with an ISO timestamp, which sorts
           lexicographically in chronological order. */
        ScanIndexForward: false,
        Limit: limit,
      }),
    );

    return (result.Items ?? []).map((item) => abuseReportSchema.parse(item));
  }
}

export const DEFAULT_ABUSE_QUEUE_KEY = "urlgen:abuse:queue";

export interface RedisAbuseQueueOptions {
  redis: Redis;
  key?: string | undefined;
}

/**
 * The review queue as a Redis sorted set: slug → last report time.
 *
 * Score is the timestamp so `ZREVRANGE` gives most-recently-reported first, and a
 * second key holds the per-slug count. Two keys rather than one because a sorted
 * set can carry either an ordering or a count in its score, not both, and losing
 * the ordering would make the queue useless the moment it has more entries than
 * an admin reads in one sitting.
 */
export class RedisAbuseQueue implements AbuseQueue {
  readonly #redis: Redis;
  readonly #key: string;

  public constructor(options: RedisAbuseQueueOptions) {
    this.#redis = options.redis;
    this.#key = options.key ?? DEFAULT_ABUSE_QUEUE_KEY;
  }

  public async add(slug: string, at: Date): Promise<void> {
    await this.#redis
      .multi()
      .zadd(this.#key, at.getTime(), slug)
      .hincrby(`${this.#key}:counts`, slug, 1)
      .exec();
  }

  public async list(limit = 50): Promise<AbuseQueueEntry[]> {
    const entries = await this.#redis.zrevrange(this.#key, 0, limit - 1, "WITHSCORES");
    const counts = await this.#redis.hgetall(`${this.#key}:counts`);

    const result: AbuseQueueEntry[] = [];
    for (let index = 0; index < entries.length; index += 2) {
      const slug = entries[index];
      const score = entries[index + 1];
      if (slug === undefined || score === undefined) {
        continue;
      }
      result.push({
        slug,
        reports: Number.parseInt(counts[slug] ?? "0", 10),
        lastReportedAt: new Date(Number.parseInt(score, 10)).toISOString(),
      });
    }
    return result;
  }

  public async clear(slug: string): Promise<void> {
    await this.#redis.multi().zrem(this.#key, slug).hdel(`${this.#key}:counts`, slug).exec();
  }
}

/** An in-memory queue for tests and for running without Redis. */
export class InMemoryAbuseQueue implements AbuseQueue {
  readonly #entries = new Map<string, { reports: number; lastReportedAt: number }>();

  public add(slug: string, at: Date): Promise<void> {
    const existing = this.#entries.get(slug);
    this.#entries.set(slug, {
      reports: (existing?.reports ?? 0) + 1,
      lastReportedAt: at.getTime(),
    });
    return Promise.resolve();
  }

  public list(limit = 50): Promise<AbuseQueueEntry[]> {
    const sorted = [...this.#entries.entries()]
      .sort((a, b) => b[1].lastReportedAt - a[1].lastReportedAt)
      .slice(0, limit)
      .map(([slug, entry]) => ({
        slug,
        reports: entry.reports,
        lastReportedAt: new Date(entry.lastReportedAt).toISOString(),
      }));
    return Promise.resolve(sorted);
  }

  public clear(slug: string): Promise<void> {
    this.#entries.delete(slug);
    return Promise.resolve();
  }
}

/** An in-memory report store for tests. */
export class InMemoryAbuseRepository implements AbuseRepository {
  readonly #reports: AbuseReport[] = [];
  readonly #now: () => Date;
  #sequence = 0;

  public constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  public record(input: RecordAbuseReportInput): Promise<AbuseReport> {
    this.#sequence += 1;
    const report: AbuseReport = {
      reportId: `report-${String(this.#sequence)}`,
      slug: input.slug,
      reason: input.reason,
      createdAt: this.#now().toISOString(),
      ...(input.details !== undefined && input.details !== "" ? { details: input.details } : {}),
    };
    this.#reports.push(report);
    return Promise.resolve(report);
  }

  public listBySlug(slug: string, limit = DEFAULT_REPORT_LIMIT): Promise<AbuseReport[]> {
    return Promise.resolve(
      this.#reports
        .filter((report) => report.slug === slug)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    );
  }
}

/** Epoch seconds, because DynamoDB TTL is seconds — milliseconds would be year 56000. */
function retentionTtlSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000) + REPORT_RETENTION_DAYS * 24 * 60 * 60;
}
