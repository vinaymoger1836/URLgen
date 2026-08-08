"use client";

/**
 * A number that is the whole chart.
 *
 * Total clicks and unique visitors are single values — drawing either as a one-bar
 * bar chart would spend a card's worth of space restating a number the reader could
 * have read directly.
 *
 * Proportional figures, not `tabular-nums`: equal-width digits are for columns that
 * have to line up vertically, and at display sizes they make a number like 121 look
 * loose.
 */

import { formatCount } from "@/lib/format";

export interface StatTileProps {
  label: string;
  value: number;
  /** Set on exactly one tile per view — the number the page leads with. */
  hero?: boolean;
  hint?: string | undefined;
}

export function StatTile({ label, value, hero = false, hint }: StatTileProps) {
  return (
    <div className="rounded-lg border border-hairline bg-surface p-4">
      <p className="text-xs text-ink-3">{label}</p>
      <p
        className={
          hero
            ? "mt-1 text-5xl font-semibold leading-none text-ink"
            : "mt-1 text-3xl font-semibold leading-none text-ink"
        }
        title={value.toLocaleString("en-US")}
      >
        {formatCount(value)}
      </p>
      {hint !== undefined && <p className="mt-2 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}
