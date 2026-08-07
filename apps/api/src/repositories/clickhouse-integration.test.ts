/**
 * Integration tests against a real ClickHouse.
 *
 * SKIPPED unless `CLICKHOUSE_TEST_URL` is set, so `pnpm test` stays green on a
 * machine without Docker:
 *
 *   pnpm services:up
 *   CLICKHOUSE_TEST_URL=http://127.0.0.1:8123 pnpm test
 *
 * These cover the two claims nothing else can check. First, that
 * `insert_deduplication_token` actually deduplicates — it is a server setting that
 * is silently ignored on a table without `non_replicated_deduplication_window`, so
 * a passing unit test proves nothing about replay safety. Second, that the
 * materialized views fire on insert and that their `uniq` states merge, which is
 * the whole reason the dashboard can read rollups instead of raw rows.
 *
 * The real `infra/clickhouse/schema.sql` is applied to a throwaway database, so a
 * schema change that breaks these is caught here rather than in production.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ClickRow } from "../analytics/click-row.js";
import { ClickHouseClickInserter, clickBatchToken } from "./clickhouse.js";

const url = process.env.CLICKHOUSE_TEST_URL;
const database = `urlgen_test_${String(Date.now())}`;

let admin: ClickHouseClient;
let reader: ClickHouseClient;
let inserter: ClickHouseClickInserter;
let slugCounter = 0;
let currentSlug = "";

/**
 * A row for the current test.
 *
 * `eventId` is namespaced by the test's slug on purpose. The batch token is a
 * digest of the event ids and nothing else, so two tests using the literal id
 * "a" would produce the *same* token and the second one's insert would be
 * deduplicated away — which is the token doing its job, and a confusing way to
 * discover it. In production these are UUIDs minted at the edge, one per click.
 */
function row(overrides: Partial<ClickRow> = {}): ClickRow {
  return {
    eventId: `${currentSlug}-${String(Math.random())}`,
    slug: currentSlug,
    ts: Date.parse("2026-08-07T10:15:00.000Z"),
    country: "IN",
    city: "Bengaluru",
    timezone: "Asia/Kolkata",
    colo: "BOM",
    deviceType: "mobile",
    browser: "Safari",
    os: "iOS",
    referrerHost: "news.ycombinator.com",
    visitorHash: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

/** Inserts a batch under its real token, exactly as the flusher would. */
async function insert(rows: ClickRow[]): Promise<void> {
  await inserter.insert(rows, clickBatchToken(rows));
}

async function queryOne<T>(query: string): Promise<T> {
  const result = await reader.query({ query, format: "JSONEachRow" });
  const rows = await result.json<T>();
  if (rows[0] === undefined) {
    throw new Error(`query returned no rows: ${query}`);
  }
  return rows[0];
}

async function rawCount(): Promise<number> {
  const { total } = await queryOne<{ total: string }>(
    `SELECT count() AS total FROM clicks WHERE slug = '${currentSlug}'`,
  );
  return Number(total);
}

describe.skipIf(url === undefined)("ClickHouse analytics schema (integration)", () => {
  beforeAll(async () => {
    admin = createClient({ url: url ?? "" });

    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = resolve(here, "../../../../infra/clickhouse/schema.sql");
    const schema = readFileSync(schemaPath, "utf8").replaceAll("{db}", database);

    for (const statement of schema
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)) {
      await admin.command({ query: statement });
    }

    reader = createClient({ url: url ?? "", database });
    inserter = new ClickHouseClickInserter({
      url: url ?? "",
      username: "default",
      password: "",
      database,
    });
  }, 60_000);

  beforeEach(() => {
    /* A fresh slug per test: the tables are shared, and the ORDER BY makes the
       slug the natural isolation key. */
    slugCounter += 1;
    currentSlug = `s${String(slugCounter).padStart(6, "0")}`;
  });

  afterAll(async () => {
    await inserter?.close();
    await reader?.close();
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin?.close();
  });

  it("stores every column the pipeline produces", async () => {
    await insert([row({ eventId: `${currentSlug}-e1` })]);

    const stored = await queryOne<Record<string, string>>(
      `SELECT slug, toString(ts) AS ts, country, city, timezone, colo,
              device_type, browser, os, referrer_host, visitor_hash
       FROM clicks WHERE slug = '${currentSlug}'`,
    );

    expect(stored).toMatchObject({
      slug: currentSlug,
      /* The timestamp survives the round trip in UTC, not shifted by the server's
         timezone. That is what `DateTime64(3, 'UTC')` plus a UTC-formatted string
         buys, and it is worth asserting because a shift would be silent. */
      ts: "2026-08-07 10:15:00.000",
      country: "IN",
      city: "Bengaluru",
      timezone: "Asia/Kolkata",
      colo: "BOM",
      device_type: "mobile",
      browser: "Safari",
      os: "iOS",
      referrer_host: "news.ycombinator.com",
      visitor_hash: "0123456789abcdef0123456789abcdef",
    });
  });

  it("has no column that could hold an IP address", async () => {
    const columns = await reader.query({
      query: `SELECT name FROM system.columns WHERE database = '${database}' AND table = 'clicks'`,
      format: "JSONEachRow",
    });
    const names = (await columns.json<{ name: string }>()).map((c) => c.name);

    /* The privacy guarantee, asserted rather than described: there is nowhere for
       an address to be stored even if something upstream tried. */
    expect(names).not.toContain("ip");
    expect(names.some((name) => name.includes("ip"))).toBe(false);
  });

  it("inserts a whole batch as one block", async () => {
    await insert([row({ eventId: `${currentSlug}-a` }), row({ eventId: `${currentSlug}-b` }), row({ eventId: `${currentSlug}-c` })]);

    await expect(rawCount()).resolves.toBe(3);
  });

  describe("replay safety", () => {
    it("drops a batch replayed under the same token", async () => {
      const batch = [row({ eventId: `${currentSlug}-a` }), row({ eventId: `${currentSlug}-b` })];

      await insert(batch);
      await insert(batch);

      /* This is the failure the whole design turns on: ClickHouse accepted the
         write and the response was lost, so the flusher never acknowledged and
         retried the identical batch. Without the token this would read 4. */
      await expect(rawCount()).resolves.toBe(2);
    });

    it("still deduplicates after other batches have been inserted in between", async () => {
      const batch = [row({ eventId: `${currentSlug}-a` })];

      await insert(batch);
      await insert([row({ eventId: `${currentSlug}-x` })]);
      await insert([row({ eventId: `${currentSlug}-y` })]);
      await insert(batch);

      await expect(rawCount()).resolves.toBe(3);
    });

    it("accepts a batch with different rows", async () => {
      await insert([row({ eventId: `${currentSlug}-a` })]);
      await insert([row({ eventId: `${currentSlug}-b` })]);

      await expect(rawCount()).resolves.toBe(2);
    });

    it("does not deduplicate two genuinely distinct clicks that look alike", async () => {
      /* Same visitor, same second, same everything except the edge's idempotency
         key — a double-click. Both are real and both must be counted. */
      await insert([row({ eventId: `${currentSlug}-first` }), row({ eventId: `${currentSlug}-second` })]);

      await expect(rawCount()).resolves.toBe(2);
    });
  });

  describe("rollups", () => {
    it("aggregates into the hourly view on insert", async () => {
      await insert([
        row({ eventId: `${currentSlug}-a`, ts: Date.parse("2026-08-07T10:05:00.000Z") }),
        row({ eventId: `${currentSlug}-b`, ts: Date.parse("2026-08-07T10:55:00.000Z") }),
        row({ eventId: `${currentSlug}-c`, ts: Date.parse("2026-08-07T11:05:00.000Z") }),
      ]);

      const hours = await reader.query({
        query: `SELECT toString(hour) AS hour, sum(clicks) AS clicks
                FROM clicks_hourly WHERE slug = '${currentSlug}'
                GROUP BY hour ORDER BY hour`,
        format: "JSONEachRow",
      });

      expect(await hours.json<{ hour: string; clicks: string }>()).toEqual([
        { hour: "2026-08-07 10:00:00", clicks: "2" },
        { hour: "2026-08-07 11:00:00", clicks: "1" },
      ]);
    });

    it("merges unique-visitor states instead of summing them", async () => {
      const visitor = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      await insert([
        row({ eventId: `${currentSlug}-a`, visitorHash: visitor }),
        row({ eventId: `${currentSlug}-b`, visitorHash: visitor }),
        row({ eventId: `${currentSlug}-c`, visitorHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      ]);

      const { clicks, visitors } = await queryOne<{ clicks: string; visitors: string }>(
        `SELECT sum(clicks) AS clicks, uniqMerge(visitors) AS visitors
         FROM clicks_hourly WHERE slug = '${currentSlug}'`,
      );

      /* Three clicks, two people. A stored integer could not do this — unique
         counts do not sum, which is why the column is an AggregateFunction and
         not a UInt64. */
      expect(Number(clicks)).toBe(3);
      expect(Number(visitors)).toBe(2);
    });

    it("counts a visitor once across separate inserts", async () => {
      const visitor = "cccccccccccccccccccccccccccccccc";
      await insert([row({ eventId: `${currentSlug}-a`, visitorHash: visitor })]);
      await insert([row({ eventId: `${currentSlug}-b`, visitorHash: visitor })]);

      const { visitors } = await queryOne<{ visitors: string }>(
        `SELECT uniqMerge(visitors) AS visitors
         FROM clicks_hourly WHERE slug = '${currentSlug}'`,
      );

      /* Batching is an implementation detail of the flusher; it must not change
         what the dashboard reports. */
      expect(Number(visitors)).toBe(1);
    });

    it("breaks the daily rollup down by every dimension the dashboard shows", async () => {
      await insert([
        row({ eventId: `${currentSlug}-a`, country: "IN", deviceType: "mobile", browser: "Safari" }),
        row({ eventId: `${currentSlug}-b`, country: "IN", deviceType: "mobile", browser: "Safari" }),
        row({ eventId: `${currentSlug}-c`, country: "US", deviceType: "desktop", browser: "Chrome" }),
      ]);

      const breakdown = await reader.query({
        query: `SELECT country, device_type, browser, sum(clicks) AS clicks
                FROM clicks_daily WHERE slug = '${currentSlug}'
                GROUP BY country, device_type, browser ORDER BY clicks DESC`,
        format: "JSONEachRow",
      });

      expect(await breakdown.json<Record<string, string>>()).toEqual([
        { country: "IN", device_type: "mobile", browser: "Safari", clicks: "2" },
        { country: "US", device_type: "desktop", browser: "Chrome", clicks: "1" },
      ]);
    });

    it("does not double-count a rollup when the raw insert is deduplicated", async () => {
      const batch = [row({ eventId: `${currentSlug}-a` }), row({ eventId: `${currentSlug}-b` })];

      await insert(batch);
      await insert(batch);

      const { clicks } = await queryOne<{ clicks: string }>(
        `SELECT sum(clicks) AS clicks FROM clicks_hourly WHERE slug = '${currentSlug}'`,
      );

      /* A dropped block never reaches the materialized views either, so the
         rollups stay consistent with the raw table. If they diverged, the
         dashboard would disagree with the source of truth and nothing would say so. */
      expect(Number(clicks)).toBe(2);
    });
  });
});
