/**
 * View models for the analytics panels.
 *
 * Kept apart from the components so the arithmetic a reader would actually be
 * misled by — what share a bar represents, whether a panel has anything in it, how
 * many points a chart should thin its labels to — is testable without a DOM.
 */

import type { AnalyticsBreakdownRow, AnalyticsGranularity, AnalyticsResponse } from "@urlgen/shared";

import { formatBucket } from "./format.js";

export interface ChartRow {
  /** The bucket's instant, kept for the tooltip's full timestamp. */
  ts: string;
  /** Axis label, already formatted in the window's timezone. */
  label: string;
  clicks: number;
  visitors: number;
}

/** Turns the API's series into rows a chart can plot, labelled in the right zone. */
export function toChartRows(
  series: AnalyticsResponse["series"],
  granularity: AnalyticsGranularity,
  timeZone: string,
): ChartRow[] {
  return series.map((point) => ({
    ts: point.ts,
    label: formatBucket(point.ts, granularity, timeZone),
    clicks: point.clicks,
    visitors: point.visitors,
  }));
}

/**
 * How many axis ticks to skip so labels do not collide.
 *
 * A 90-day range is 90 labels in the width of a card; drawing them all produces an
 * unreadable smear, and rotating them to fit costs vertical space the chart needs
 * more. Roughly eight labels reads cleanly at any card width.
 */
export function axisTickInterval(pointCount: number, target = 8): number {
  if (pointCount <= target) {
    return 0;
  }
  return Math.ceil(pointCount / target) - 1;
}

/** Clicks across a panel's rows — the denominator for a share within that panel. */
export function panelTotal(rows: readonly AnalyticsBreakdownRow[]): number {
  return rows.reduce((sum, row) => sum + row.clicks, 0);
}

/**
 * The bar width for a row, as a percentage of the panel's largest.
 *
 * Scaled to the leading row rather than to the panel's total, so the shape of the
 * distribution is visible even when the top entry holds a small share of a long
 * tail. The share the reader is told in text is still computed against the total —
 * the bar is a comparison, the number is the fact.
 */
export function barWidthPercent(row: AnalyticsBreakdownRow, rows: readonly AnalyticsBreakdownRow[]): number {
  const largest = rows.reduce((max, candidate) => Math.max(max, candidate.clicks), 0);
  if (largest <= 0) {
    return 0;
  }
  /* A floor so a row with a single click is still a visible mark rather than a
     sliver indistinguishable from zero. */
  return Math.max((row.clicks / largest) * 100, 2);
}

/**
 * Whether the window contains any traffic at all.
 *
 * Read from the totals rather than the series, because the series is gap-filled:
 * every bucket exists, most of them zero, so `series.length > 0` is true for a link
 * nobody has ever clicked.
 */
export function hasTraffic(data: AnalyticsResponse): boolean {
  return data.totals.clicks > 0;
}

/** The leading row of a panel, or undefined when the panel is empty. */
export function leadingRow(
  rows: readonly AnalyticsBreakdownRow[],
): AnalyticsBreakdownRow | undefined {
  return rows[0];
}
