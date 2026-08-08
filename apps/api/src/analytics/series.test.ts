import type { AnalyticsWindow } from "@urlgen/shared";
import { describe, expect, it } from "vitest";

import { fillSeries } from "./series.js";

const HOUR = 3_600_000;

function windowOf(overrides: Partial<AnalyticsWindow>): AnalyticsWindow {
  return {
    fromMs: Date.UTC(2026, 7, 8, 0, 0),
    toMs: Date.UTC(2026, 7, 8, 4, 0),
    timeZone: "UTC",
    granularity: "hour",
    source: "raw",
    ...overrides,
  };
}

describe("fillSeries", () => {
  it("emits every bucket in the window", () => {
    const filled = fillSeries([], windowOf({}));
    expect(filled).toHaveLength(4);
    expect(filled.map((point) => point.tsMs)).toEqual([
      Date.UTC(2026, 7, 8, 0),
      Date.UTC(2026, 7, 8, 1),
      Date.UTC(2026, 7, 8, 2),
      Date.UTC(2026, 7, 8, 3),
    ]);
    expect(filled.every((point) => point.clicks === 0 && point.visitors === 0)).toBe(true);
  });

  it("keeps the buckets that had traffic", () => {
    const filled = fillSeries(
      [{ tsMs: Date.UTC(2026, 7, 8, 2), clicks: 7, visitors: 3 }],
      windowOf({}),
    );
    expect(filled.map((point) => point.clicks)).toEqual([0, 0, 7, 0]);
    expect(filled[2]?.visitors).toBe(3);
  });

  it("excludes the bucket the window ends on", () => {
    /* The window is half-open, so a 04:00 boundary belongs to the next window. Two
       adjacent ranges must not both contain it. */
    const filled = fillSeries([], windowOf({}));
    expect(filled.at(-1)?.tsMs).toBe(Date.UTC(2026, 7, 8, 3));
  });

  it("starts from the bucket containing a mid-bucket window start", () => {
    const filled = fillSeries(
      [],
      windowOf({ fromMs: Date.UTC(2026, 7, 8, 0, 37), toMs: Date.UTC(2026, 7, 8, 3, 0) }),
    );
    expect(filled[0]?.tsMs).toBe(Date.UTC(2026, 7, 8, 0));
  });

  it("aligns buckets to the viewer's zone, not to UTC", () => {
    const filled = fillSeries(
      [],
      windowOf({
        fromMs: Date.UTC(2026, 7, 8, 0, 0),
        toMs: Date.UTC(2026, 7, 8, 2, 0),
        timeZone: "Asia/Kolkata",
      }),
    );
    /* Kolkata's hours begin at :30 past the UTC hour. */
    expect(filled.map((point) => point.tsMs)).toEqual([
      Date.UTC(2026, 7, 7, 23, 30),
      Date.UTC(2026, 7, 8, 0, 30),
      Date.UTC(2026, 7, 8, 1, 30),
    ]);
  });

  it("fills quarter-hours", () => {
    const filled = fillSeries(
      [],
      windowOf({
        granularity: "15m",
        fromMs: Date.UTC(2026, 7, 8, 0, 0),
        toMs: Date.UTC(2026, 7, 8, 1, 0),
      }),
    );
    expect(filled).toHaveLength(4);
    expect(filled[1]?.tsMs).toBe(Date.UTC(2026, 7, 8, 0, 15));
  });

  it("steps calendar days, not 24-hour blocks, across a DST boundary", () => {
    /* 2026-03-08 is 23 hours long in New York. Flat arithmetic would drift an hour
       per transition and eventually emit a duplicate or skip a day. */
    const filled = fillSeries(
      [],
      windowOf({
        granularity: "day",
        timeZone: "America/New_York",
        fromMs: Date.UTC(2026, 2, 6, 5, 0),
        toMs: Date.UTC(2026, 2, 11, 4, 0),
      }),
    );
    expect(filled.map((point) => point.tsMs)).toEqual([
      Date.UTC(2026, 2, 6, 5, 0),
      Date.UTC(2026, 2, 7, 5, 0),
      Date.UTC(2026, 2, 8, 5, 0),
      /* From here the zone is on -04:00: the local day still starts at midnight. */
      Date.UTC(2026, 2, 9, 4, 0),
      Date.UTC(2026, 2, 10, 4, 0),
    ]);
  });

  it("never emits the same bucket twice across a fall-back boundary", () => {
    const filled = fillSeries(
      [],
      windowOf({
        granularity: "day",
        timeZone: "America/New_York",
        fromMs: Date.UTC(2026, 9, 30, 4, 0),
        toMs: Date.UTC(2026, 10, 4, 5, 0),
      }),
    );
    const stamps = filled.map((point) => point.tsMs);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it("keeps a point the walk did not land on rather than dropping it", () => {
    /* A bucket that does not sit on a boundary can only mean the two calculations
       disagree. That should show up in the chart, not vanish from it. */
    const stray = { tsMs: Date.UTC(2026, 7, 8, 1, 17), clicks: 5, visitors: 5 };
    const filled = fillSeries([stray], windowOf({}));
    expect(filled).toHaveLength(5);
    expect(filled.map((point) => point.tsMs)).toEqual([...filled.map((p) => p.tsMs)].sort());
    expect(filled).toContainEqual(stray);
  });

  it("stops rather than looping when the window is inverted", () => {
    const filled = fillSeries(
      [],
      windowOf({ fromMs: Date.UTC(2026, 7, 8, 4), toMs: Date.UTC(2026, 7, 8, 0) }),
    );
    expect(filled).toEqual([]);
  });

  it("bounds an absurd window instead of allocating without limit", () => {
    const filled = fillSeries(
      [],
      windowOf({
        granularity: "15m",
        fromMs: Date.UTC(2020, 0, 1),
        toMs: Date.UTC(2026, 0, 1),
      }),
    );
    expect(filled).toHaveLength(2_000);
  });
});

describe("fillSeries totals", () => {
  it("does not invent or lose clicks", () => {
    const points = [
      { tsMs: Date.UTC(2026, 7, 8, 0), clicks: 2, visitors: 2 },
      { tsMs: Date.UTC(2026, 7, 8, 3), clicks: 4, visitors: 1 },
    ];
    const filled = fillSeries(points, windowOf({}));
    const total = filled.reduce((sum, point) => sum + point.clicks, 0);
    expect(total).toBe(6);
  });
});

/** Guards the assumption `fillSeries` leans on: a bucket start is stable. */
describe("bucket alignment", () => {
  it("re-filling an already-filled series changes nothing", () => {
    const window = windowOf({ toMs: Date.UTC(2026, 7, 8, 0) + 4 * HOUR });
    const once = fillSeries([{ tsMs: Date.UTC(2026, 7, 8, 1), clicks: 1, visitors: 1 }], window);
    expect(fillSeries(once, window)).toEqual(once);
  });
});
