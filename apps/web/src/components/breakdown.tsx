"use client";

/**
 * One breakdown panel — country, device, browser, OS or referrer.
 *
 * Horizontal bars in plain HTML rather than a chart library. The categories are
 * nominal and the values are one series, so every bar is the same colour: shading
 * them by size would double-encode the length as hue and burn the only free channel
 * on information the bar already carries.
 *
 * It is also its own table view. The label and the number are always rendered as
 * text next to the bar, so nothing here is reachable only by hovering — the bar is
 * the comparison, the text is the fact.
 */

import type { AnalyticsBreakdownRow } from "@urlgen/shared";

import { barWidthPercent, panelTotal } from "@/lib/analytics-view";
import { formatBreakdownKey, formatShare } from "@/lib/format";

export interface BreakdownProps {
  dimension: string;
  rows: readonly AnalyticsBreakdownRow[];
}

export function Breakdown({ dimension, rows }: BreakdownProps) {
  const total = panelTotal(rows);

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-ink" title={formatBreakdownKey(dimension, row.key)}>
              {formatBreakdownKey(dimension, row.key)}
            </span>
            <span className="shrink-0 tabular-nums text-ink-2">
              {row.clicks.toLocaleString("en-US")}
              <span className="ml-1.5 text-ink-3">{formatShare(row.clicks, total)}</span>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-grid">
            {/* Rounded at the data end, square at the baseline — the bar grows from
                a single origin and the shape says which end is which. */}
            <div
              className="h-full rounded-r"
              style={{
                width: `${barWidthPercent(row, rows).toString()}%`,
                backgroundColor: "var(--color-series-1)",
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
