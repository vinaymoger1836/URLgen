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
  /**
   * A count, or a name.
   *
   * "Top country" is a tile whose answer is *India*, not a number — rendering the
   * count as the value and the country as the hint reads as "Top country: 14",
   * which answers a question nobody asked. A string value is set smaller because a
   * name is longer than a number and has to survive "United States".
   */
  value: number | string;
  /** Set on exactly one tile per view — the number the page leads with. */
  hero?: boolean;
  hint?: string | undefined;
}

export function StatTile({ label, value, hero = false, hint }: StatTileProps) {
  const isNumeric = typeof value === "number";
  const size = hero ? "text-5xl" : isNumeric ? "text-3xl" : "text-2xl";

  return (
    <div className="rounded-lg border border-hairline bg-surface p-4">
      <p className="text-xs text-ink-3">{label}</p>
      <p
        className={`mt-1 truncate font-semibold leading-tight text-ink ${size}`}
        title={isNumeric ? value.toLocaleString("en-US") : value}
      >
        {isNumeric ? formatCount(value) : value}
      </p>
      {hint !== undefined && <p className="mt-2 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}
