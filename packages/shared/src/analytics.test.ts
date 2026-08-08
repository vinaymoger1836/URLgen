import { describe, expect, it } from "vitest";

import {
  MAX_ANALYTICS_SPAN_MS,
  RAW_RETENTION_MS,
  RAW_SOURCE_MAX_SPAN_MS,
  analyticsQuerySchema,
  analyticsResponseSchema,
  granularityForSpan,
  resolveAnalyticsWindow,
} from "./analytics.js";
import { zonedStartOfDay } from "./time.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A fixed clock: 2026-08-08 09:15 UTC, mid-day and mid-hour on purpose. */
const NOW = Date.UTC(2026, 7, 8, 9, 15);

function parseQuery(input: Record<string, unknown>) {
  const result = analyticsQuerySchema.safeParse(input);
  if (!result.success) {
    throw new Error(`expected a valid query: ${result.error.issues[0]?.message ?? ""}`);
  }
  return result.data;
}

describe("analyticsQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(analyticsQuerySchema.safeParse({}).success).toBe(true);
  });

  it("accepts a preset", () => {
    expect(parseQuery({ range: "7d" }).range).toBe("7d");
  });

  it("rejects an unknown preset", () => {
    expect(analyticsQuerySchema.safeParse({ range: "1y" }).success).toBe(false);
  });

  it("rejects half of a custom range", () => {
    const result = analyticsQuerySchema.safeParse({ from: "2026-08-01T00:00:00Z" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("together");
  });

  it("rejects an inverted range", () => {
    const result = analyticsQuerySchema.safeParse({
      from: "2026-08-08T00:00:00Z",
      to: "2026-08-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("after");
  });

  it("rejects a range longer than the cap", () => {
    const result = analyticsQuerySchema.safeParse({
      from: new Date(NOW - MAX_ANALYTICS_SPAN_MS - DAY).toISOString(),
      to: new Date(NOW).toISOString(),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("too long");
  });

  it("normalizes the timezone rather than passing it through", () => {
    expect(parseQuery({ tz: "america/new_york" }).tz).toBe("America/New_York");
  });

  it("rejects an unknown timezone instead of letting it reach a query", () => {
    const result = analyticsQuerySchema.safeParse({ tz: "Mars/Olympus_Mons" });
    expect(result.success).toBe(false);
  });
});

describe("granularityForSpan", () => {
  it("picks a bucket that keeps the chart readable", () => {
    expect(granularityForSpan(6 * HOUR)).toBe("15m");
    expect(granularityForSpan(24 * HOUR)).toBe("hour");
    expect(granularityForSpan(7 * DAY)).toBe("hour");
    expect(granularityForSpan(30 * DAY)).toBe("day");
    expect(granularityForSpan(90 * DAY)).toBe("day");
  });
});

describe("resolveAnalyticsWindow", () => {
  it("makes 24h a rolling window, not a calendar one", () => {
    const window = resolveAnalyticsWindow(parseQuery({ range: "24h" }), NOW);
    expect(window.fromMs).toBe(NOW - 24 * HOUR);
    expect(window.toMs).toBe(NOW);
  });

  it("starts the multi-day presets at a local midnight", () => {
    const window = resolveAnalyticsWindow(parseQuery({ range: "7d", tz: "UTC" }), NOW);
    /* Six whole days back plus today in progress. */
    expect(window.fromMs).toBe(Date.UTC(2026, 7, 2));
    expect(window.toMs).toBe(NOW);
  });

  it("uses the viewer's midnight, not UTC's", () => {
    const window = resolveAnalyticsWindow(
      parseQuery({ range: "7d", tz: "America/New_York" }),
      NOW,
    );
    expect(window.fromMs).toBe(zonedStartOfDay(NOW - 6 * DAY, "America/New_York"));
    /* 04:00 UTC, because New York is on -04:00 in August. A UTC-bucketed window
       would have started four hours earlier and swept in part of the previous day. */
    expect(window.fromMs).toBe(Date.UTC(2026, 7, 2, 4, 0));
  });

  it("reads raw for a short window and the rollups for a long one", () => {
    expect(resolveAnalyticsWindow(parseQuery({ range: "24h" }), NOW).source).toBe("raw");
    expect(resolveAnalyticsWindow(parseQuery({ range: "7d" }), NOW).source).toBe("rollup");
    expect(resolveAnalyticsWindow(parseQuery({ range: "30d" }), NOW).source).toBe("rollup");
  });

  it("switches to the rollups exactly at the raw span limit", () => {
    const atLimit = parseQuery({
      from: new Date(NOW - RAW_SOURCE_MAX_SPAN_MS).toISOString(),
      to: new Date(NOW).toISOString(),
    });
    const overLimit = parseQuery({
      from: new Date(NOW - RAW_SOURCE_MAX_SPAN_MS - 1000).toISOString(),
      to: new Date(NOW).toISOString(),
    });
    expect(resolveAnalyticsWindow(atLimit, NOW).source).toBe("raw");
    expect(resolveAnalyticsWindow(overLimit, NOW).source).toBe("rollup");
  });

  it("does not read raw for a short window that predates retention", () => {
    /* The trap: span is tiny, so a span-only rule would choose raw — but the rows
       aged out months ago and the answer would be an empty chart for a link that
       had traffic. */
    const ancient = parseQuery({
      from: new Date(NOW - RAW_RETENTION_MS - DAY).toISOString(),
      to: new Date(NOW - RAW_RETENTION_MS - DAY + HOUR).toISOString(),
    });
    expect(resolveAnalyticsWindow(ancient, NOW).source).toBe("rollup");
  });

  it("never asks the hourly rollup for a 15-minute bucket", () => {
    /* A short window six months back: the span says 15m, retention says the rollup
       is the only table left. The rollup cannot resolve quarter-hours, so the
       granularity has to give way — otherwise the chart would be labelled 15m and
       drawn from hour buckets. */
    const ancientAndShort = parseQuery({
      from: new Date(NOW - RAW_RETENTION_MS - DAY).toISOString(),
      to: new Date(NOW - RAW_RETENTION_MS - DAY + 2 * HOUR).toISOString(),
    });
    const window = resolveAnalyticsWindow(ancientAndShort, NOW);
    expect(window.source).toBe("rollup");
    expect(window.granularity).toBe("hour");
  });

  it("defaults to UTC when the caller supplies no zone", () => {
    expect(resolveAnalyticsWindow(parseQuery({}), NOW).timeZone).toBe("UTC");
  });

  it("honours an explicit custom range verbatim", () => {
    const window = resolveAnalyticsWindow(
      parseQuery({ from: "2026-08-01T00:00:00Z", to: "2026-08-03T00:00:00Z" }),
      NOW,
    );
    expect(window.fromMs).toBe(Date.UTC(2026, 7, 1));
    expect(window.toMs).toBe(Date.UTC(2026, 7, 3));
  });
});

describe("analyticsResponseSchema", () => {
  it("accepts a well-formed payload", () => {
    const payload = {
      slug: "abc1234",
      window: {
        from: "2026-08-07T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z",
        timeZone: "UTC",
        source: "raw",
      },
      granularity: "hour",
      totals: { clicks: 4, visitors: 3 },
      series: [{ ts: "2026-08-07T00:00:00.000Z", clicks: 4, visitors: 3 }],
      breakdowns: {
        country: [{ key: "IN", clicks: 4, visitors: 3 }],
        deviceType: [],
        browser: [],
        os: [],
        referrer: [],
      },
      generatedAt: "2026-08-08T00:00:00.000Z",
    };
    expect(analyticsResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects a negative count", () => {
    const result = analyticsResponseSchema.safeParse({
      slug: "abc1234",
      window: {
        from: "2026-08-07T00:00:00.000Z",
        to: "2026-08-08T00:00:00.000Z",
        timeZone: "UTC",
        source: "raw",
      },
      granularity: "hour",
      totals: { clicks: -1, visitors: 0 },
      series: [],
      breakdowns: { country: [], deviceType: [], browser: [], os: [], referrer: [] },
      generatedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
