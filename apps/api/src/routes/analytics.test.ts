import type { AnalyticsResponse, AnalyticsTotalsResponse, AnalyticsWindow } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { AnalyticsCache } from "../repositories/analytics-cache.js";
import type {
  AnalyticsData,
  AnalyticsStore,
  AnalyticsTotals,
} from "../repositories/analytics-store.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { buildServer } from "../server.js";

const config = loadConfig({ NODE_ENV: "test", SHORT_DOMAIN: "urlgen.test" });

/** Fixed so a window resolved from the quantized clock is the same in every test. */
const NOW = Date.parse("2026-08-08T12:00:07.500Z");

const EMPTY_BREAKDOWNS = {
  country: [],
  deviceType: [],
  browser: [],
  os: [],
  referrer: [],
};

class FakeAnalyticsStore implements AnalyticsStore {
  public readonly fetched: { slug: string; window: AnalyticsWindow }[] = [];
  public readonly totalsCalls: { slugs: readonly string[] }[] = [];
  public data: AnalyticsData = { totals: { clicks: 0, visitors: 0 }, series: [], breakdowns: EMPTY_BREAKDOWNS };
  public totals = new Map<string, AnalyticsTotals>();
  public failure: Error | undefined;

  public fetch(slug: string, window: AnalyticsWindow): Promise<AnalyticsData> {
    this.fetched.push({ slug, window });
    return this.failure === undefined ? Promise.resolve(this.data) : Promise.reject(this.failure);
  }

  public totalsBySlug(slugs: readonly string[]): Promise<Map<string, AnalyticsTotals>> {
    this.totalsCalls.push({ slugs });
    return this.failure === undefined ? Promise.resolve(this.totals) : Promise.reject(this.failure);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAnalyticsCache implements AnalyticsCache {
  public readonly entries = new Map<string, string>();
  public readFailure: Error | undefined;
  public writeFailure: Error | undefined;

  public get(key: string): Promise<string | undefined> {
    if (this.readFailure !== undefined) {
      return Promise.reject(this.readFailure);
    }
    return Promise.resolve(this.entries.get(key));
  }

  public set(key: string, value: string): Promise<void> {
    if (this.writeFailure !== undefined) {
      return Promise.reject(this.writeFailure);
    }
    this.entries.set(key, value);
    return Promise.resolve();
  }
}

let app: FastifyInstance;
let repository: InMemoryLinkRepository;
let store: FakeAnalyticsStore;
let cache: FakeAnalyticsCache;

async function createLink(slug: string, ownerId: string): Promise<void> {
  await repository.create({
    targetUrl: "https://example.com/",
    ownerId,
    urlHash: `hash-${slug}`,
    customSlug: slug,
  });
}

function get(url: string, ownerId = "alice") {
  return app.inject({ method: "GET", url, headers: { "x-owner-id": ownerId } });
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  repository = new InMemoryLinkRepository();
  store = new FakeAnalyticsStore();
  cache = new FakeAnalyticsCache();
  app = buildServer(config, {
    linkRepository: repository,
    analyticsStore: store,
    analyticsCache: cache,
  });
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

describe("GET /api/analytics/:slug — authorization", () => {
  it("returns 404 for a slug that does not exist", async () => {
    const response = await get("/api/analytics/nosuch1");
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("link_not_found");
  });

  it("returns the same 404 for another owner's link, and never queries it", async () => {
    await createLink("secret1", "bob");

    const response = await get("/api/analytics/secret1", "alice");

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("link_not_found");
    /* The click rows carry no owner, so this check is the only thing between a
       guessed slug and someone else's numbers. If it ever stops running before the
       store, the leak is silent. */
    expect(store.fetched).toEqual([]);
  });

  it("returns 404 for a deleted link", async () => {
    await createLink("gone123", "alice");
    await repository.softDelete("gone123");

    expect((await get("/api/analytics/gone123")).statusCode).toBe(404);
    expect(store.fetched).toEqual([]);
  });

  it("returns 404 for a malformed slug without touching storage", async () => {
    const response = await get("/api/analytics/no");
    expect(response.statusCode).toBe(404);
    expect(store.fetched).toEqual([]);
  });
});

describe("GET /api/analytics/:slug — query validation", () => {
  beforeEach(async () => {
    await createLink("abc1234", "alice");
  });

  it("rejects an unknown preset", async () => {
    const response = await get("/api/analytics/abc1234?range=1y");
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("invalid_request");
  });

  it("rejects half of a custom range", async () => {
    const response = await get("/api/analytics/abc1234?from=2026-08-01T00:00:00Z");
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown timezone rather than passing it to ClickHouse", async () => {
    const response = await get("/api/analytics/abc1234?tz=Mars/Olympus_Mons");
    expect(response.statusCode).toBe(400);
    expect(store.fetched).toEqual([]);
  });

  it("defaults to the last 24 hours, read from raw", async () => {
    await get("/api/analytics/abc1234");

    const window = store.fetched[0]?.window;
    expect(window?.source).toBe("raw");
    /* The clock is floored to the cache tick before the window is resolved. */
    expect(window?.toMs).toBe(Date.parse("2026-08-08T12:00:00.000Z"));
    expect(window?.fromMs).toBe(Date.parse("2026-08-07T12:00:00.000Z"));
  });

  it("reads the rollups for a 30-day range", async () => {
    await get("/api/analytics/abc1234?range=30d");
    expect(store.fetched[0]?.window.source).toBe("rollup");
    expect(store.fetched[0]?.window.granularity).toBe("day");
  });
});

describe("GET /api/analytics/:slug — payload", () => {
  beforeEach(async () => {
    await createLink("abc1234", "alice");
  });

  it("returns totals, a gap-filled series and every breakdown panel", async () => {
    store.data = {
      totals: { clicks: 3, visitors: 2 },
      series: [{ tsMs: Date.parse("2026-08-08T10:00:00.000Z"), clicks: 3, visitors: 2 }],
      breakdowns: {
        ...EMPTY_BREAKDOWNS,
        country: [{ key: "IN", clicks: 3, visitors: 2 }],
      },
    };

    const response = await get("/api/analytics/abc1234");
    const body = response.json<AnalyticsResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.slug).toBe("abc1234");
    expect(body.totals).toEqual({ clicks: 3, visitors: 2 });
    expect(body.window).toEqual({
      from: "2026-08-07T12:00:00.000Z",
      to: "2026-08-08T12:00:00.000Z",
      timeZone: "UTC",
      source: "raw",
    });
    expect(body.granularity).toBe("hour");
    expect(body.breakdowns.country).toEqual([{ key: "IN", clicks: 3, visitors: 2 }]);

    /* 24 hourly buckets, with the one that had traffic in its place and the rest
       explicitly zero — a chart cannot tell "no data" from "not sent". */
    expect(body.series).toHaveLength(24);
    expect(body.series.filter((point) => point.clicks > 0)).toEqual([
      { ts: "2026-08-08T10:00:00.000Z", clicks: 3, visitors: 2 },
    ]);
  });

  it("buckets in the requested timezone", async () => {
    const response = await get("/api/analytics/abc1234?tz=Asia/Kolkata");
    const body = response.json<AnalyticsResponse>();

    expect(response.statusCode).toBe(200);
    /* Kolkata's hour boundaries are at :30 past the UTC hour. */
    expect(body.series[0]?.ts).toBe("2026-08-07T11:30:00.000Z");
  });
});

describe("GET /api/analytics/:slug — caching", () => {
  beforeEach(async () => {
    await createLink("abc1234", "alice");
  });

  it("serves a repeat request from the cache", async () => {
    const first = await get("/api/analytics/abc1234");
    const second = await get("/api/analytics/abc1234");

    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(store.fetched).toHaveLength(1);
  });

  it("caches per timezone, because the buckets differ", async () => {
    await get("/api/analytics/abc1234?tz=UTC");
    await get("/api/analytics/abc1234?tz=Asia/Kolkata");
    expect(store.fetched).toHaveLength(2);
  });

  it("does not serve one owner's link from another's request path", async () => {
    await get("/api/analytics/abc1234", "alice");
    /* Bob does not own it, so he is refused before the cache is even consulted. */
    const response = await get("/api/analytics/abc1234", "bob");
    expect(response.statusCode).toBe(404);
  });

  it("falls through to the store when the cache read fails", async () => {
    cache.readFailure = new Error("redis down");

    const response = await get("/api/analytics/abc1234");

    /* A cache exists to make this faster, not to make it possible. */
    expect(response.statusCode).toBe(200);
    expect(store.fetched).toHaveLength(1);
  });

  it("still answers when the cache write fails", async () => {
    cache.writeFailure = new Error("redis down");
    expect((await get("/api/analytics/abc1234")).statusCode).toBe(200);
  });
});

describe("GET /api/analytics/:slug — failures", () => {
  beforeEach(async () => {
    await createLink("abc1234", "alice");
  });

  it("returns 503 when ClickHouse is unavailable, and leaks nothing", async () => {
    store.failure = new Error("connect ECONNREFUSED 127.0.0.1:8123");

    const response = await get("/api/analytics/abc1234");
    const body = response.json<{ error: { code: string; message: string } }>();

    expect(response.statusCode).toBe(503);
    expect(body.error.code).toBe("upstream_unavailable");
    expect(body.error.message).not.toContain("ECONNREFUSED");
  });

  it("does not cache a failure", async () => {
    store.failure = new Error("boom");
    await get("/api/analytics/abc1234");
    store.failure = undefined;

    expect((await get("/api/analytics/abc1234")).statusCode).toBe(200);
  });
});

describe("GET /api/analytics — owner totals", () => {
  it("returns one row per link, with zeroes where there was no traffic", async () => {
    await createLink("aaa1111", "alice");
    await createLink("bbb2222", "alice");
    store.totals = new Map([["aaa1111", { clicks: 9, visitors: 4 }]]);

    const response = await get("/api/analytics");
    const body = response.json<AnalyticsTotalsResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.items).toContainEqual({ slug: "aaa1111", clicks: 9, visitors: 4 });
    expect(body.items).toContainEqual({ slug: "bbb2222", clicks: 0, visitors: 0 });
  });

  it("never asks about another owner's slugs", async () => {
    await createLink("mine111", "alice");
    await createLink("theirs1", "bob");

    await get("/api/analytics", "alice");

    expect(store.totalsCalls[0]?.slugs).toEqual(["mine111"]);
  });

  it("excludes deleted links", async () => {
    await createLink("aaa1111", "alice");
    await createLink("bbb2222", "alice");
    await repository.softDelete("bbb2222");

    await get("/api/analytics", "alice");

    expect(store.totalsCalls[0]?.slugs).toEqual(["aaa1111"]);
  });

  it("returns 503 when the store fails", async () => {
    await createLink("aaa1111", "alice");
    store.failure = new Error("boom");

    expect((await get("/api/analytics")).statusCode).toBe(503);
  });

  it("validates its range the same way", async () => {
    expect((await get("/api/analytics?range=1y")).statusCode).toBe(400);
  });
});
