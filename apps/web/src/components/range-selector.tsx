"use client";

/**
 * One filter row, above everything it scopes.
 *
 * Deliberately not a control per card: every panel on the page reads the same
 * window, and a per-chart range is how a dashboard ends up comparing last week's
 * countries against yesterday's clicks.
 */

import { ANALYTICS_PRESETS, type AnalyticsPreset } from "@urlgen/shared";

import { RANGE_LABELS } from "@/lib/format";

export interface RangeSelectorProps {
  value: AnalyticsPreset;
  onChange: (range: AnalyticsPreset) => void;
}

export function RangeSelector({ value, onChange }: RangeSelectorProps) {
  return (
    <div
      role="group"
      aria-label="Time range"
      className="inline-flex rounded-md border border-hairline bg-surface p-0.5"
    >
      {ANALYTICS_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          aria-pressed={preset === value}
          onClick={() => {
            onChange(preset);
          }}
          className={
            preset === value
              ? "rounded px-3 py-1 text-xs font-medium bg-plane text-ink"
              : "rounded px-3 py-1 text-xs text-ink-2 hover:text-ink"
          }
          title={RANGE_LABELS[preset]}
        >
          {preset}
        </button>
      ))}
    </div>
  );
}
