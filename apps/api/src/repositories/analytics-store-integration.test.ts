/**
 * Integration tests for the analytics read path, against a real ClickHouse.
 *
 * SKIPPED unless `CLICKHOUSE_TEST_URL` is set, so `pnpm test` stays green on a
 * machine without Docker:
 *
 *   pnpm services:up
 *   CLICKHOUSE_TEST_URL=http://127.0.0.1:8123 pnpm test
 *
 * Nothing here can be checked with a fake. Every claim this file makes — that
 * `uniqMerge` and `sum` differ, that `toStartOfDay(ts, tz)` puts a click on the
 * viewer's calendar day rather than UTC's, that a union of five limited selects
 * comes back as five populated panels — is a claim about the server, and a mocked
 * client would only prove that the strings were assembled the way the test expected.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnalyticsWindow } from "@urlgen/shared";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ClickRow } from "../analytics/click-row.js";
import { ClickHouseAnalyticsStore } from "./analytics-store.js";
import { ClickHouseClickInserter, clickBatchToken } from "./clickhouse.js";

const url = process.env.CLICKHOUSE_TEST_URL;
const database = `urlgen_read_test_${String(Date.now())}`;

let admin: ClickHouseClient;
let inserter: ClickHouseClickInserter;
let store: ClickHouseAnalyticsStore;
let slugCounter = 0;
let currentSlug = "";

const DAY_START = Date.parse("2026-08-07T00:00:00.000Z");
const DAY_END = Date.parse("2026-08-08T00:00:00.000Z");

function at(iso: string): number {
  return Date.parse(iso);
}

function row(overrides: Partial<ClickRow> = {}): ClickRow {
  return {
    /* Unique per row: the batch token is a digest of the event ids, so reusing one
       across tests would have the server deduplicate the second insert away. */
    eventId: `${currentSlug}-${String(Math.random())}`,
    slug: currentSlug,
    ts: at("2026-08-07T10:15:00.000Z"),
    country: "IN",
    city: "Bengaluru",
    timezone: "Asia/Kolkata",
    colo: "BOM",
    deviceType: "mobile",
    browser: "Safari",
    os: "iOS",
    referrerHost: "news.ycombinator.com",
    visitorHash: "visitor-a",
    ...overrides,
  };
}

async function insert(rows: ClickRow[]): Promise<void> {
  await inserter.insert(rows, clickBatchToken(rows));
}

function windowOf(overrides: Partial<AnalyticsWindow> = {}): AnalyticsWindow {
  return {
    fromMs: DAY_START,
    toMs: DAY_END,
    timeZone: "UTC",
    granularity: "hour",
    source: "raw",
    ...overrides,
  };
}

describe.skipIf(url === undefined)("ClickHouseAnalyticsStore (integration)", () => {
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

    const config = { url: url ?? "", username: "default", password: "", database };
    inserter = new ClickHouseClickInserter(config);
    store = new ClickHouseAnalyticsStore(config);
  }, 60_000);

  beforeEach(() => {
    slugCounter += 1;
    currentSlug = `r${String(slugCounter).padStart(6, "0")}`;
  });

  afterAll(async () => {
    await store?.close();
    await inserter?.close();
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin?.close();
  });

  describe("raw source", () => {
    it("counts clicks and distinct visitors", async () => {
      await insert([
        row({ visitorHash: "visitor-a" }),
        row({ visitorHash: "visitor-a" }),
        row({ visitorHash: "visitor-b" }),
      ]);

      const data = await store.fetch(currentSlug, windowOf());
      expect(data.totals).toEqual({ clicks: 3, visitors: 2 });
    });

    it("returns zeroes for a link with no clicks, rather than failing", async () => {
      const data = await store.fetch(currentSlug, windowOf());
      expect(data.totals).toEqual({ clicks: 0, visitors: 0 });
      expect(data.series).toEqual([]);
      expect(data.breakdowns.country).toEqual([]);
    });

    it("excludes clicks outside the window at both ends", async () => {
      await insert([
        row({ ts: at("2026-08-06T23:59:59.000Z") }),
        row({ ts: at("2026-08-07T00:00:00.000Z") }),
        row({ ts: at("2026-08-07T23:59:59.999Z") }),
        row({ ts: at("2026-08-08T00:00:00.000Z") }),
      ]);

      const data = await store.fetch(currentSlug, windowOf());
      /* Half-open: the lower bound is in, the upper bound is not. */
      expect(data.totals.clicks).toBe(2);
    });

    it("buckets the series by hour", async () => {
      await insert([
        row({ ts: at("2026-08-07T10:15:00.000Z") }),
        row({ ts: at("2026-08-07T10:45:00.000Z") }),
        row({ ts: at("2026-08-07T11:05:00.000Z") }),
      ]);

      const data = await store.fetch(currentSlug, windowOf());
      expect(data.series).toEqual([
        { tsMs: at("2026-08-07T10:00:00.000Z"), clicks: 2, visitors: 1 },
        { tsMs: at("2026-08-07T11:00:00.000Z"), clicks: 1, visitors: 1 },
      ]);
    });

    it("buckets days on the viewer's calendar, not UTC's", async () => {
      /* 19:00 UTC is already 00:30 the next morning in Kolkata. Bucketing in UTC
         would file it under the 7th and show the viewer traffic on a day they were
         asleep for. */
      await insert([
        row({ ts: at("2026-08-07T17:00:00.000Z") }),
        row({ ts: at("2026-08-07T19:00:00.000Z") }),
      ]);

      const data = await store.fetch(
        currentSlug,
        windowOf({
          granularity: "day",
          timeZone: "Asia/Kolkata",
          fromMs: at("2026-08-06T18:30:00.000Z"),
          toMs: at("2026-08-08T18:30:00.000Z"),
        }),
      );

      expect(data.series).toEqual([
        { tsMs: at("2026-08-06T18:30:00.000Z"), clicks: 1, visitors: 1 },
        { tsMs: at("2026-08-07T18:30:00.000Z"), clicks: 1, visitors: 1 },
      ]);
    });

    it("returns all five breakdown panels from one query", async () => {
      await insert([
        row({ country: "IN", deviceType: "mobile", browser: "Safari", os: "iOS" }),
        row({ country: "IN", deviceType: "desktop", browser: "Chrome", os: "Windows" }),
        row({ country: "US", deviceType: "desktop", browser: "Chrome", os: "Windows" }),
      ]);

      const { breakdowns } = await store.fetch(currentSlug, windowOf());

      expect(breakdowns.country).toEqual([
        { key: "IN", clicks: 2, visitors: 1 },
        { key: "US", clicks: 1, visitors: 1 },
      ]);
      expect(breakdowns.deviceType.map((entry) => entry.key)).toEqual(["desktop", "mobile"]);
      expect(breakdowns.browser[0]).toEqual({ key: "Chrome", clicks: 2, visitors: 1 });
      expect(breakdowns.os[0]?.key).toBe("Windows");
      expect(breakdowns.referrer[0]?.key).toBe("news.ycombinator.com");
    });

    it("keeps direct traffic as an empty referrer rather than losing the row", async () => {
      /* The reason the breakdown is a union rather than GROUPING SETS: an empty
         referrer_host is real data (someone typed the link), and grouping sets
         would make it indistinguishable from "this row is not grouped by referrer". */
      await insert([row({ referrerHost: "" }), row({ referrerHost: "t.co" })]);

      const { breakdowns } = await store.fetch(currentSlug, windowOf());
      expect(breakdowns.referrer).toHaveLength(2);
      expect(breakdowns.referrer.map((entry) => entry.key).sort()).toEqual(["", "t.co"]);
    });

    it("orders each panel by clicks and breaks ties by key", async () => {
      await insert([
        row({ country: "DE" }),
        row({ country: "AU" }),
        row({ country: "IN" }),
        row({ country: "IN" }),
      ]);

      const { breakdowns } = await store.fetch(currentSlug, windowOf());
      expect(breakdowns.country.map((entry) => entry.key)).toEqual(["IN", "AU", "DE"]);
    });

    it("caps each panel at the breakdown limit", async () => {
      await insert(
        Array.from({ length: 15 }, (_unused, index) =>
          row({ referrerHost: `host-${String(index).padStart(2, "0")}.example` }),
        ),
      );

      const { breakdowns } = await store.fetch(currentSlug, windowOf());
      expect(breakdowns.referrer).toHaveLength(10);
    });
  });

  describe("rollup source", () => {
    it("agrees with the raw table on click totals", async () => {
      await insert([
        row({ ts: at("2026-08-07T10:15:00.000Z") }),
        row({ ts: at("2026-08-07T11:15:00.000Z") }),
        row({ ts: at("2026-08-07T11:45:00.000Z") }),
      ]);

      const raw = await store.fetch(currentSlug, windowOf({ source: "raw" }));
      const rollup = await store.fetch(currentSlug, windowOf({ source: "rollup" }));
      expect(rollup.totals.clicks).toBe(raw.totals.clicks);
    });

    it("merges unique visitors instead of summing them", async () => {
      /* The same person, twice, in two different hours. Each hourly rollup row
         holds a uniq state of 1. Summing those gives 2 and is the single easiest
         mistake to make against this schema; merging the HyperLogLog states gives
         the 1 that is true. */
      await insert([
        row({ ts: at("2026-08-07T10:15:00.000Z"), visitorHash: "same-person" }),
        row({ ts: at("2026-08-07T11:15:00.000Z"), visitorHash: "same-person" }),
      ]);

      const rollup = await store.fetch(currentSlug, windowOf({ source: "rollup" }));

      expect(rollup.totals).toEqual({ clicks: 2, visitors: 1 });
      /* Per-hour the answer really is 1 and 1 — which is exactly why adding them up
         would look plausible. */
      expect(rollup.series.map((point) => point.visitors)).toEqual([1, 1]);
    });

    it("reads the daily rollup for breakdowns", async () => {
      await insert([
        row({ country: "IN", browser: "Safari" }),
        row({ country: "US", browser: "Chrome" }),
        row({ country: "US", browser: "Chrome" }),
      ]);

      const { breakdowns } = await store.fetch(currentSlug, windowOf({ source: "rollup" }));
      expect(breakdowns.country).toEqual([
        { key: "US", clicks: 2, visitors: 1 },
        { key: "IN", clicks: 1, visitors: 1 },
      ]);
      expect(breakdowns.browser.map((entry) => entry.key)).toEqual(["Chrome", "Safari"]);
    });

    it("includes the hour bucket that straddles the window's start", async () => {
      /* The rollup is keyed by UTC hour, so a window starting at 10:30 has to snap
         down to the 10:00 bucket or it drops clicks that are inside the window. */
      await insert([row({ ts: at("2026-08-07T10:45:00.000Z") })]);

      const data = await store.fetch(
        currentSlug,
        windowOf({ source: "rollup", fromMs: at("2026-08-07T10:30:00.000Z") }),
      );
      expect(data.totals.clicks).toBe(1);
    });
  });

  describe("totalsBySlug", () => {
    it("returns one entry per slug that has traffic", async () => {
      const other = `${currentSlug}x`;
      await insert([row({ visitorHash: "v1" }), row({ visitorHash: "v1" })]);
      await insert([row({ slug: other, visitorHash: "v2" })]);

      const totals = await store.totalsBySlug([currentSlug, other, "no-such-slug"], windowOf());

      expect(totals.get(currentSlug)).toEqual({ clicks: 2, visitors: 1 });
      expect(totals.get(other)).toEqual({ clicks: 1, visitors: 1 });
      /* Absent rather than zero: the caller knows which slugs it asked about, and
         inventing a row for one with no clicks would hide the difference between
         "no traffic" and "not queried". */
      expect(totals.has("no-such-slug")).toBe(false);
    });

    it("does not query at all for an empty slug list", async () => {
      await expect(store.totalsBySlug([], windowOf())).resolves.toEqual(new Map());
    });

    it("reads the rollup when asked to", async () => {
      await insert([row(), row()]);
      const totals = await store.totalsBySlug([currentSlug], windowOf({ source: "rollup" }));
      expect(totals.get(currentSlug)?.clicks).toBe(2);
    });
  });
});
