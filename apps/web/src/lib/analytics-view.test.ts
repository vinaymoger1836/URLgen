import type { AnalyticsBreakdownRow, AnalyticsResponse } from "@urlgen/shared";
import { describe, expect, it } from "vitest";

import {
  axisTickInterval,
  barWidthPercent,
  hasTraffic,
  panelTotal,
  toChartRows,
} from "./analytics-view.js";

function rows(...clicks: number[]): AnalyticsBreakdownRow[] {
  return clicks.map((count, index) => ({
    key: `k${String(index)}`,
    clicks: count,
    visitors: count,
  }));
}

describe("toChartRows", () => {
  it("labels each bucket in the window's zone and keeps the instant", () => {
    const chartRows = toChartRows(
      [{ ts: "2026-08-08T14:00:00.000Z", clicks: 3, visitors: 2 }],
      "hour",
      "Asia/Kolkata",
    );

    expect(chartRows).toEqual([
      { ts: "2026-08-08T14:00:00.000Z", label: "19:30", clicks: 3, visitors: 2 },
    ]);
  });
});

describe("axisTickInterval", () => {
  it("labels every point when there are few", () => {
    expect(axisTickInterval(6)).toBe(0);
    expect(axisTickInterval(8)).toBe(0);
  });

  it("thins the labels on a long range", () => {
    /* 90 days of day buckets in the width of a card is an unreadable smear. */
    expect(axisTickInterval(90)).toBe(11);
    expect(axisTickInterval(24)).toBe(2);
  });

  it("leaves roughly the target number of labels", () => {
    for (const count of [24, 48, 90, 168, 336]) {
      const shown = Math.ceil(count / (axisTickInterval(count) + 1));
      expect(shown).toBeLessThanOrEqual(12);
      expect(shown).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("panelTotal", () => {
  it("sums the panel's clicks", () => {
    expect(panelTotal(rows(5, 3, 2))).toBe(10);
  });

  it("is zero for an empty panel", () => {
    expect(panelTotal([])).toBe(0);
  });
});

describe("barWidthPercent", () => {
  it("scales to the panel's largest row, not its total", () => {
    /* Scaled to the total, a long tail would render every bar as a sliver and the
       shape of the distribution would be invisible. */
    const panel = rows(10, 5, 1);
    expect(barWidthPercent(panel[0] as AnalyticsBreakdownRow, panel)).toBe(100);
    expect(barWidthPercent(panel[1] as AnalyticsBreakdownRow, panel)).toBe(50);
  });

  it("keeps a tiny row visible rather than showing nothing", () => {
    const panel = rows(1000, 1);
    expect(barWidthPercent(panel[1] as AnalyticsBreakdownRow, panel)).toBe(2);
  });

  it("does not divide by zero when every row is zero", () => {
    const panel = rows(0, 0);
    expect(barWidthPercent(panel[0] as AnalyticsBreakdownRow, panel)).toBe(0);
  });
});

describe("hasTraffic", () => {
  const base: AnalyticsResponse = {
    slug: "abc1234",
    window: {
      from: "2026-08-07T00:00:00.000Z",
      to: "2026-08-08T00:00:00.000Z",
      timeZone: "UTC",
      source: "raw",
    },
    granularity: "hour",
    totals: { clicks: 0, visitors: 0 },
    series: [],
    breakdowns: { country: [], deviceType: [], browser: [], os: [], referrer: [] },
    generatedAt: "2026-08-08T00:00:00.000Z",
  };

  it("reads the totals, not the series length", () => {
    /* The series is gap-filled, so a link nobody has ever clicked still comes back
       with 24 buckets of zero. Checking `series.length` would call that traffic. */
    const gapFilled: AnalyticsResponse = {
      ...base,
      series: [
        { ts: "2026-08-07T00:00:00.000Z", clicks: 0, visitors: 0 },
        { ts: "2026-08-07T01:00:00.000Z", clicks: 0, visitors: 0 },
      ],
    };
    expect(hasTraffic(gapFilled)).toBe(false);
  });

  it("is true once there is a click", () => {
    expect(hasTraffic({ ...base, totals: { clicks: 1, visitors: 1 } })).toBe(true);
  });
});
