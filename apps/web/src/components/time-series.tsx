"use client";

/**
 * Clicks and unique visitors over the window.
 *
 * Two series, one axis. They share a unit (a count) and visitors can never exceed
 * clicks, so a single scale is honest — a second y-axis would let the two lines be
 * slid against each other until they appeared to correlate, which is the most
 * common way a dashboard chart lies.
 *
 * Every mark spec here is deliberate: 2px lines, a 10% wash instead of a saturated
 * fill, no dot per point (only on hover, at 8px with a 2px surface ring so it stays
 * legible where the lines cross), solid hairline gridlines rather than dashes, and
 * axis text in the muted ink token rather than the series colour — a light
 * categorical hue is illegible as text, and identity comes from the coloured mark
 * beside a label, never from colouring the label.
 *
 * The table toggle is not a nicety. A tooltip is the only way to read an individual
 * bucket otherwise, and a value that exists only on hover is unreachable by keyboard
 * and by anyone who cannot use a pointer.
 */

import type { AnalyticsGranularity } from "@urlgen/shared";
import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { axisTickInterval, type ChartRow } from "@/lib/analytics-view";
import { formatInstant } from "@/lib/format";

const SERIES = [
  { key: "clicks", label: "Clicks", color: "var(--color-series-1)" },
  { key: "visitors", label: "Unique visitors", color: "var(--color-series-2)" },
] as const;

export interface TimeSeriesProps {
  rows: ChartRow[];
  granularity: AnalyticsGranularity;
  timeZone: string;
}

export function TimeSeries({ rows, timeZone }: TimeSeriesProps) {
  const [showTable, setShowTable] = useState(false);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4">
        <Legend />
        <button
          type="button"
          onClick={() => {
            setShowTable((current) => !current);
          }}
          aria-pressed={showTable}
          className="rounded border border-hairline px-2 py-1 text-xs text-ink-2 hover:bg-plane"
        >
          {showTable ? "Chart" : "Table"}
        </button>
      </div>

      {showTable ? (
        <SeriesTable rows={rows} timeZone={timeZone} />
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            {/* The right margin is not decoration: the final tick sits on the plot's
                right edge, and its label is centred on it — with a small margin the
                last date renders as "8 Au". */}
            <ComposedChart
              data={rows}
              margin={{ top: 8, right: 24, bottom: 0, left: 0 }}
              accessibilityLayer
            >
              {/* Horizontal only, solid, one step off the surface: a grid is a
                  reading aid, not data, and dashes read as "threshold". */}
              <CartesianGrid
                vertical={false}
                stroke="var(--color-grid)"
                strokeDasharray="none"
              />
              <XAxis
                dataKey="label"
                interval={axisTickInterval(rows.length)}
                tickLine={false}
                axisLine={{ stroke: "var(--color-axis)" }}
                tick={{ fill: "var(--color-ink-3)", fontSize: 11 }}
                tickMargin={8}
              />
              <YAxis
                allowDecimals={false}
                width={40}
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--color-ink-3)", fontSize: 11 }}
              />
              <Tooltip
                cursor={{ stroke: "var(--color-axis)", strokeWidth: 1 }}
                content={<SeriesTooltip timeZone={timeZone} />}
              />
              {SERIES.map((series) => (
                <Area
                  key={series.key}
                  type="monotone"
                  dataKey={series.key}
                  name={series.label}
                  stroke={series.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  fill={series.color}
                  fillOpacity={0.1}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-surface)" }}
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/**
 * Hand-rolled rather than Recharts' own.
 *
 * The built-in legend paints its labels in each series' colour, which is exactly
 * what the palette rules forbid — the swatch carries identity, the text stays ink.
 */
function Legend() {
  return (
    <ul className="flex gap-4">
      {SERIES.map((series) => (
        <li key={series.key} className="flex items-center gap-1.5 text-xs text-ink-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: series.color }}
          />
          {series.label}
        </li>
      ))}
    </ul>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number | undefined;
  value?: number | undefined;
}

interface SeriesTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  timeZone: string;
}

function SeriesTooltip({ active, payload, timeZone }: SeriesTooltipProps) {
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }

  /* The full instant, not the axis label: the axis is abbreviated to fit, and a
     tooltip is the one place with room to be unambiguous about which bucket. */
  const row = (payload[0] as { payload?: ChartRow } | undefined)?.payload;

  return (
    <div className="rounded-md border border-hairline bg-surface px-3 py-2 shadow-sm">
      {row !== undefined && (
        <p className="mb-1 text-xs font-medium text-ink">{formatInstant(row.ts, timeZone)}</p>
      )}
      <ul className="space-y-0.5">
        {SERIES.map((series) => {
          const entry = payload.find((candidate) => candidate.dataKey === series.key);
          return (
            <li key={series.key} className="flex items-center gap-2 text-xs text-ink-2">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: series.color }}
              />
              <span className="flex-1">{series.label}</span>
              <span className="font-medium tabular-nums text-ink">{entry?.value ?? 0}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The chart's WCAG-clean twin — every value the chart draws, readable as text. */
function SeriesTable({ rows, timeZone }: { rows: ChartRow[]; timeZone: string }) {
  return (
    <div className="h-72 overflow-y-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-hairline text-ink-3">
            <th scope="col" className="py-1.5 font-medium">
              Bucket
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Clicks
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Visitors
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ts} className="border-b border-hairline/50">
              <td className="py-1.5 text-ink-2">{formatInstant(row.ts, timeZone)}</td>
              <td className="py-1.5 text-right tabular-nums text-ink">{row.clicks}</td>
              <td className="py-1.5 text-right tabular-nums text-ink">{row.visitors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
