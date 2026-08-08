/**
 * The analytics contract: what the dashboard may ask for, and what it gets back.
 *
 * Shared because three parties have to agree on it — the API that answers, the web
 * app that renders it, and the tests that pin it. The interesting part is not the
 * shapes but `resolveAnalyticsWindow`, which turns "last 7 days, I'm in Kolkata"
 * into a concrete instant range, a bucket size, and a decision about which table
 * can honestly answer it.
 */

import { z } from "zod";

import { timestampSchema } from "./schemas.js";
import { addZonedDays, normalizeTimeZone } from "./time.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Preset windows the dashboard offers.
 *
 * `24h` is a rolling window — "the last twenty-four hours" — while the others start
 * at a local midnight, because "the last 7 days" that begins at 14:37 makes both
 * ends of the chart a partial day and nobody reads it that way.
 */
export const ANALYTICS_PRESETS = ["24h", "7d", "30d", "90d"] as const;
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number];

/** How wide one point on the time series is. */
export const ANALYTICS_GRANULARITIES = ["15m", "hour", "day"] as const;
export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];

/** Which table answered: the raw events, or the pre-aggregated rollups. */
export const ANALYTICS_SOURCES = ["raw", "rollup"] as const;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];

/** Bucket width in milliseconds, for the fixed-width granularities. */
export const GRANULARITY_MS: Readonly<Record<AnalyticsGranularity, number>> = {
  "15m": 900_000,
  hour: MS_PER_HOUR,
  /* Nominal only. A calendar day is 23, 24 or 25 hours long depending on the zone
     and the date, so day-stepping goes through `addZonedDays`, never this value. */
  day: MS_PER_DAY,
};

/**
 * The longest window that raw `clicks` will be asked for.
 *
 * Raw is exact — its rows carry the real instant, so a window with any boundary can
 * be answered to the millisecond. The rollups cannot: `clicks_hourly` buckets by UTC
 * hour and `clicks_daily` by UTC day, so a window whose edges fall inside a bucket
 * is answered to the accuracy of that bucket. Under two days the raw scan is a few
 * thousand rows for one slug and the precision is worth having; above it the row
 * count grows without bound and the rollup is the only design that survives volume.
 */
export const RAW_SOURCE_MAX_SPAN_MS = 48 * MS_PER_HOUR;

/**
 * How far back raw `clicks` can be trusted to still exist.
 *
 * The table carries `TTL ts + 90 DAY`, and TTL deletion is a background merge, not
 * a scheduled sweep — rows can survive past 90 days or vanish shortly after. Two
 * days of margin keeps a short window near the edge of retention from returning a
 * half-deleted answer that looks like a traffic collapse.
 */
export const RAW_RETENTION_MS = 88 * MS_PER_DAY;

/** The widest custom window accepted, so one query cannot scan an unbounded range. */
export const MAX_ANALYTICS_SPAN_MS = 366 * MS_PER_DAY;

/** Chosen granularity for a span, sized to keep a chart between ~24 and ~350 points. */
export function granularityForSpan(spanMs: number): AnalyticsGranularity {
  if (spanMs <= 12 * MS_PER_HOUR) {
    return "15m";
  }
  if (spanMs <= 14 * MS_PER_DAY) {
    return "hour";
  }
  return "day";
}

/**
 * A timezone the runtime recognises, stored in its canonical IANA spelling.
 *
 * Canonical matters downstream: this string is passed to ClickHouse as a query
 * parameter for `toStartOfDay(ts, tz)`, and that lookup is exact where `Intl`'s is
 * forgiving about case.
 */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .transform((value) => normalizeTimeZone(value))
  .refine((value): value is string => value !== undefined, "unknown timezone");

/**
 * The query string of an analytics request.
 *
 * Either a preset or an explicit pair — never one half of a pair, which is the
 * request most likely to be a client bug and least likely to mean anything useful.
 */
export const analyticsQuerySchema = z
  .object({
    range: z.enum(ANALYTICS_PRESETS).optional(),
    from: timestampSchema.optional(),
    to: timestampSchema.optional(),
    tz: timeZoneSchema.optional(),
  })
  .superRefine(({ from, to }, ctx) => {
    if ((from === undefined) !== (to === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "from and to must be provided together",
      });
      return;
    }

    if (from === undefined || to === undefined) {
      return;
    }

    /* Both have already been through `timestampSchema`, so neither parse is NaN. */
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);

    if (toMs <= fromMs) {
      ctx.addIssue({ code: "custom", message: "to must be after from" });
      return;
    }

    if (toMs - fromMs > MAX_ANALYTICS_SPAN_MS) {
      ctx.addIssue({ code: "custom", message: "the requested range is too long" });
    }
  });

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/** A request resolved against a clock: concrete instants, a bucket size, a table. */
export interface AnalyticsWindow {
  fromMs: number;
  toMs: number;
  timeZone: string;
  granularity: AnalyticsGranularity;
  source: AnalyticsSource;
}

/**
 * Turns a validated query into the window the store will actually run.
 *
 * `now` is a parameter rather than a call to `Date.now()` so that the caller can
 * quantize it — the API rounds the clock down to the cache window, which makes a
 * cached answer byte-identical to the fresh one it stands in for, and makes every
 * test here deterministic.
 */
export function resolveAnalyticsWindow(
  query: AnalyticsQuery,
  now: number,
  defaultTimeZone = "UTC",
): AnalyticsWindow {
  const timeZone = query.tz ?? defaultTimeZone;
  const { fromMs, toMs } =
    query.from !== undefined && query.to !== undefined
      ? { fromMs: Date.parse(query.from), toMs: Date.parse(query.to) }
      : presetBounds(query.range ?? "24h", now, timeZone);

  const spanMs = toMs - fromMs;

  return {
    fromMs,
    toMs,
    timeZone,
    granularity: granularityForSpan(spanMs),
    source: sourceForSpan(spanMs, fromMs, now),
  };
}

/**
 * Raw only when it is both affordable and still there.
 *
 * The retention half of the condition is the one that is easy to forget: a *short*
 * custom window can still sit six months in the past, where the raw rows have been
 * deleted and only the rollups remain. Choosing raw there would return an empty
 * chart for a link that had plenty of traffic.
 */
function sourceForSpan(spanMs: number, fromMs: number, now: number): AnalyticsSource {
  const withinRetention = fromMs >= now - RAW_RETENTION_MS;
  return spanMs <= RAW_SOURCE_MAX_SPAN_MS && withinRetention ? "raw" : "rollup";
}

function presetBounds(
  preset: AnalyticsPreset,
  now: number,
  timeZone: string,
): { fromMs: number; toMs: number } {
  if (preset === "24h") {
    return { fromMs: now - 24 * MS_PER_HOUR, toMs: now };
  }

  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  /* `days - 1` because the window includes today: "last 7 days" is six whole days
     plus the one in progress, which is what a viewer counts on a calendar. */
  return { fromMs: addZonedDays(now, -(days - 1), timeZone), toMs: now };
}

export const analyticsWindowSchema = z.object({
  from: timestampSchema,
  to: timestampSchema,
  timeZone: z.string(),
  source: z.enum(ANALYTICS_SOURCES),
});

const countSchema = z.number().int().nonnegative();

export const analyticsBucketSchema = z.object({
  /** Instant the bucket starts at. The client formats it in `window.timeZone`. */
  ts: timestampSchema,
  clicks: countSchema,
  visitors: countSchema,
});

export const analyticsBreakdownRowSchema = z.object({
  key: z.string(),
  clicks: countSchema,
  visitors: countSchema,
});

/**
 * The breakdown panels.
 *
 * There is deliberately no `city`. The daily rollup does not carry one — city is
 * unbounded, so including it would produce a rollup row per city per day per link
 * and defeat the point of rolling up at all. A city panel would therefore work for
 * windows under two days and silently empty beyond them, which is a worse product
 * than not offering it.
 */
export const analyticsBreakdownsSchema = z.object({
  country: z.array(analyticsBreakdownRowSchema),
  deviceType: z.array(analyticsBreakdownRowSchema),
  browser: z.array(analyticsBreakdownRowSchema),
  os: z.array(analyticsBreakdownRowSchema),
  referrer: z.array(analyticsBreakdownRowSchema),
});

export const analyticsResponseSchema = z.object({
  slug: z.string(),
  window: analyticsWindowSchema,
  granularity: z.enum(ANALYTICS_GRANULARITIES),
  totals: z.object({ clicks: countSchema, visitors: countSchema }),
  series: z.array(analyticsBucketSchema),
  breakdowns: analyticsBreakdownsSchema,
  generatedAt: timestampSchema,
});

export const analyticsTotalsResponseSchema = z.object({
  window: analyticsWindowSchema,
  items: z.array(
    z.object({ slug: z.string(), clicks: countSchema, visitors: countSchema }),
  ),
});

export type AnalyticsBucket = z.infer<typeof analyticsBucketSchema>;
export type AnalyticsBreakdownRow = z.infer<typeof analyticsBreakdownRowSchema>;
export type AnalyticsBreakdowns = z.infer<typeof analyticsBreakdownsSchema>;
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;
export type AnalyticsTotalsResponse = z.infer<typeof analyticsTotalsResponseSchema>;

/** The breakdown panels, in the order the dashboard shows them. */
export const BREAKDOWN_DIMENSIONS = [
  "country",
  "deviceType",
  "browser",
  "os",
  "referrer",
] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];
