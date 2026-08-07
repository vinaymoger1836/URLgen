/**
 * The analytics store.
 *
 * ClickHouse is written to in batches and only in batches. Every insert creates a
 * part on disk that a background merge then has to consolidate; a thousand
 * one-row inserts produce a thousand parts, and the server starts refusing writes
 * with "too many parts" long before the data itself is a problem. Batching is not
 * an optimisation here, it is the operating requirement.
 *
 * ## Exactly-once, via the server
 *
 * The buffer guarantees a batch survives a crash, which means a batch can be
 * inserted twice. Rather than deduplicating rows after the fact, each insert
 * carries an `insert_deduplication_token` derived from the batch's contents: if
 * the identical batch arrives again, ClickHouse recognises the token and drops the
 * block. The materialized views never fire for a dropped block either, so the
 * rollups stay consistent with the raw table.
 *
 * This only works because the token depends on nothing but the rows — same rows,
 * same token, forever. A timestamp or a random id in the token would make every
 * retry look new, which is the failure this is meant to prevent.
 */

import { createHash } from "node:crypto";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import type { ClickRow } from "../analytics/click-row.js";

export const CLICKS_TABLE = "clicks";

/** What the flusher needs from the analytics store. */
export interface ClickInserter {
  insert(rows: readonly ClickRow[], token: string): Promise<void>;
  /** True when the server answers. Used by `/health`, never by the ingest path. */
  isReachable(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ClickHouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

/**
 * The row as ClickHouse receives it.
 *
 * snake_case here and only here: the column names are the schema's business, and
 * translating at this one boundary keeps every other module in TypeScript's
 * conventions.
 */
interface ClickHouseRow {
  slug: string;
  ts: string;
  country: string;
  city: string;
  timezone: string;
  colo: string;
  device_type: string;
  browser: string;
  os: string;
  referrer_host: string;
  visitor_hash: string;
}

export class ClickHouseClickInserter implements ClickInserter {
  readonly #client: ClickHouseClient;

  public constructor(config: ClickHouseConfig) {
    this.#client = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      /* The flusher owns retries: it leaves the batch in the in-flight list and
         tries again next cycle, which is durable. A client-level retry would
         re-send from memory and lose the rows if the process died mid-retry. */
      max_open_connections: 4,
      request_timeout: 10_000,
      clickhouse_settings: {
        /* Wait for the write to be durable before reporting success, so `ack()`
           can only ever delete rows ClickHouse has actually accepted. */
        async_insert: 0,
      },
    });
  }

  /** Inserts a batch as a single block, idempotent under the given token. */
  public async insert(rows: readonly ClickRow[], token: string): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    await this.#client.insert<ClickHouseRow>({
      table: CLICKS_TABLE,
      values: rows.map(toClickHouseRow),
      format: "JSONEachRow",
      clickhouse_settings: { insert_deduplication_token: token },
    });
  }

  public async isReachable(): Promise<boolean> {
    const result = await this.#client.ping();
    return result.success;
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }
}

/** Builds a configured inserter. */
export function createClickInserter(config: ClickHouseConfig): ClickInserter {
  return new ClickHouseClickInserter(config);
}

/**
 * A batch's idempotency token: a digest of its rows' event ids, in order.
 *
 * Order is part of the identity on purpose. The buffer always hands back an
 * in-flight batch in the order it was claimed, so a genuine retry produces the
 * same token — while a batch that merely happens to contain the same clicks in a
 * different order is a different insert and should not be silently dropped.
 */
export function clickBatchToken(rows: readonly ClickRow[]): string {
  const digest = createHash("sha256");
  for (const row of rows) {
    digest.update(row.eventId);
    digest.update("\n");
  }
  return digest.digest("hex");
}

/**
 * Formats an instant the way ClickHouse's default parser reads a DateTime64(3).
 *
 * Explicitly UTC on both sides — the column is declared `DateTime64(3, 'UTC')` —
 * so no server or container timezone setting can shift a click by hours. The
 * dashboard converts to the viewer's zone at query time, where the viewer is known.
 */
export function toClickHouseDateTime(epochMs: number): string {
  /* "2026-08-07T11:22:33.456Z" -> "2026-08-07 11:22:33.456" */
  return new Date(epochMs).toISOString().replace("T", " ").replace("Z", "");
}

function toClickHouseRow(row: ClickRow): ClickHouseRow {
  return {
    slug: row.slug,
    ts: toClickHouseDateTime(row.ts),
    country: row.country,
    city: row.city,
    timezone: row.timezone,
    colo: row.colo,
    device_type: row.deviceType,
    browser: row.browser,
    os: row.os,
    referrer_host: row.referrerHost,
    visitor_hash: row.visitorHash,
  };
}
