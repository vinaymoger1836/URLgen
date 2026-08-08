/**
 * Turning the buckets that had traffic into every bucket in the window.
 *
 * ClickHouse returns rows only where rows exist. A chart drawn straight from that
 * lies twice over: a quiet Tuesday disappears instead of showing zero, and the two
 * points either side of it get joined by a line that implies traffic through it.
 * ClickHouse's own `WITH FILL` would do this server-side, but the fill has to happen
 * in the viewer's timezone and against a window this service already knows — doing
 * it here keeps that arithmetic in one testable place instead of split across a SQL
 * clause and a date library.
 *
 * Days are stepped through `addZonedDays` rather than by adding 86,400,000: a
 * calendar day is 23 or 25 hours long twice a year, and flat arithmetic across a
 * DST boundary either skips a day or emits one twice.
 */

import { GRANULARITY_MS, addZonedDays, zonedStartOfDay, zonedStartOfInterval } from "@urlgen/shared";
import type { AnalyticsWindow } from "@urlgen/shared";

import type { AnalyticsSeriesPoint } from "../repositories/analytics-store.js";

/**
 * Upper bound on emitted buckets.
 *
 * The granularity rules keep a real window under ~400 points, so this is not a
 * product limit — it is the thing that turns "the step function stopped advancing"
 * into a short chart instead of a hung event loop holding an unbounded array.
 */
const MAX_BUCKETS = 2_000;

/**
 * Expands a sparse series into one point per bucket across the window.
 *
 * Buckets that ClickHouse did not report as zero are emitted as zero. Anything the
 * walk does not land on is still appended rather than dropped: if the two bucket
 * calculations ever disagree, the result should be a visibly odd chart, not a
 * quietly missing day.
 */
export function fillSeries(
  points: readonly AnalyticsSeriesPoint[],
  window: AnalyticsWindow,
): AnalyticsSeriesPoint[] {
  const remaining = new Map(points.map((point) => [point.tsMs, point]));
  const filled: AnalyticsSeriesPoint[] = [];

  let cursor = firstBucket(window);
  for (let emitted = 0; cursor < window.toMs && emitted < MAX_BUCKETS; emitted += 1) {
    const point = remaining.get(cursor);
    remaining.delete(cursor);
    filled.push(point ?? { tsMs: cursor, clicks: 0, visitors: 0 });

    const next = nextBucket(cursor, window);
    if (next <= cursor) {
      /* Cannot happen with the current step functions; if it ever does, stopping
         beats spinning. */
      break;
    }
    cursor = next;
  }

  if (remaining.size > 0) {
    filled.push(...remaining.values());
    filled.sort((a, b) => a.tsMs - b.tsMs);
  }

  return filled;
}

/** The bucket containing the window's start, in the window's timezone. */
function firstBucket(window: AnalyticsWindow): number {
  if (window.granularity === "day") {
    return zonedStartOfDay(window.fromMs, window.timeZone);
  }
  return zonedStartOfInterval(
    window.fromMs,
    GRANULARITY_MS[window.granularity],
    window.timeZone,
  );
}

function nextBucket(cursor: number, window: AnalyticsWindow): number {
  if (window.granularity === "day") {
    return addZonedDays(cursor, 1, window.timeZone);
  }
  return cursor + GRANULARITY_MS[window.granularity];
}
