import type { AnalyticsWindow } from "@urlgen/shared";
import { describe, expect, it } from "vitest";

import {
  NoopAnalyticsCache,
  analyticsCacheKey,
  analyticsTotalsCacheKey,
  quantizeClock,
} from "./analytics-cache.js";

function windowOf(overrides: Partial<AnalyticsWindow> = {}): AnalyticsWindow {
  return {
    fromMs: Date.UTC(2026, 7, 7),
    toMs: Date.UTC(2026, 7, 8),
    timeZone: "UTC",
    granularity: "hour",
    source: "raw",
    ...overrides,
  };
}

describe("analyticsCacheKey", () => {
  it("is stable for the same window", () => {
    expect(analyticsCacheKey("abc1234", windowOf())).toBe(
      analyticsCacheKey("abc1234", windowOf()),
    );
  });

  it("separates two links", () => {
    expect(analyticsCacheKey("abc1234", windowOf())).not.toBe(
      analyticsCacheKey("xyz9876", windowOf()),
    );
  });

  it("separates two timezones over the same instants", () => {
    /* Same window, different bucket boundaries — sharing an entry would hand a
       viewer someone else's day boundaries. */
    expect(analyticsCacheKey("abc1234", windowOf({ timeZone: "UTC" }))).not.toBe(
      analyticsCacheKey("abc1234", windowOf({ timeZone: "Asia/Kolkata" })),
    );
  });

  it("separates the two sources", () => {
    expect(analyticsCacheKey("abc1234", windowOf({ source: "raw" }))).not.toBe(
      analyticsCacheKey("abc1234", windowOf({ source: "rollup" })),
    );
  });

  it("separates two granularities", () => {
    expect(analyticsCacheKey("abc1234", windowOf({ granularity: "hour" }))).not.toBe(
      analyticsCacheKey("abc1234", windowOf({ granularity: "day" })),
    );
  });

  it("keeps one owner's totals out of another's", () => {
    expect(analyticsTotalsCacheKey("alice", windowOf())).not.toBe(
      analyticsTotalsCacheKey("bob", windowOf()),
    );
  });
});

describe("quantizeClock", () => {
  it("floors to the tick", () => {
    const base = Date.UTC(2026, 7, 8, 12, 0, 0);
    expect(quantizeClock(base + 14_999, 15)).toBe(base);
    expect(quantizeClock(base + 15_000, 15)).toBe(base + 15_000);
  });

  it("gives every request in one tick the same window", () => {
    const base = Date.UTC(2026, 7, 8, 12, 0, 0);
    const keys = [0, 3_000, 9_999, 14_999].map((offset) =>
      quantizeClock(base + offset, 15),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("still quantizes to a second when caching is switched off", () => {
    /* TTL 0 disables storage, not the stable-window property — an unquantized clock
       would make the resolved range jitter by milliseconds between two panels of the
       same page load. */
    const base = Date.UTC(2026, 7, 8, 12, 0, 0);
    expect(quantizeClock(base + 999, 0)).toBe(base);
  });
});

describe("NoopAnalyticsCache", () => {
  it("always misses and never throws", async () => {
    const cache = new NoopAnalyticsCache();
    await cache.set();
    await expect(cache.get()).resolves.toBeUndefined();
  });
});
