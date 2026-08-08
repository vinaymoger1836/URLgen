/**
 * The analytics read path.
 *
 * Three questions per dashboard load — a total, a time series, and five breakdown
 * panels — answered from whichever table can answer them honestly:
 *
 * | window          | series + totals | breakdowns      |
 * |-----------------|-----------------|-----------------|
 * | up to 48 hours  | `clicks` (raw)  | `clicks` (raw)  |
 * | longer, or old  | `clicks_hourly` | `clicks_daily`  |
 *
 * Raw is exact to the millisecond but grows without bound; the rollups are two
 * pre-aggregated tables that a materialized view maintains on insert. The choice
 * between them is made in `resolveAnalyticsWindow` and arrives here already decided,
 * so this module never has to guess — it only has to build the right query.
 *
 * ## Two things that are easy to get wrong here
 *
 * **`uniqMerge`, never `sum`.** `visitors` in the rollups is an `AggregateFunction`
 * — a HyperLogLog state, not a number. Summing two hours of unique visitors
 * double-counts everyone who appeared in both. Merging the states does not.
 *
 * **The rollups bucket in UTC.** `clicks_hourly` is keyed by UTC hour and
 * `clicks_daily` by UTC day, so a window whose edges do not land on those
 * boundaries is answered to the accuracy of the bucket: the lower bound is snapped
 * *down* so the partial bucket is included rather than dropped. For a zone offset by
 * a whole hour that is exact at hour grain; for India's +05:30 a day boundary can be
 * off by up to half an hour of traffic. The response says which table answered so
 * the dashboard can label an aggregated number as one.
 */

import {
  BREAKDOWN_DIMENSIONS,
  type AnalyticsBreakdowns,
  type AnalyticsWindow,
  type BreakdownDimension,
} from "@urlgen/shared";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { z } from "zod";

import type { ClickHouseConfig } from "./clickhouse.js";

/** How many rows each breakdown panel returns. */
export const BREAKDOWN_LIMIT = 10;

export interface AnalyticsTotals {
  clicks: number;
  visitors: number;
}

export interface AnalyticsSeriesPoint {
  /** Instant the bucket starts at, epoch milliseconds. */
  tsMs: number;
  clicks: number;
  visitors: number;
}

export interface AnalyticsData {
  totals: AnalyticsTotals;
  /** Only the buckets that had traffic; gaps are filled by `fillSeries`. */
  series: AnalyticsSeriesPoint[];
  breakdowns: AnalyticsBreakdowns;
}

export interface AnalyticsStore {
  /** Everything one link's dashboard needs for a window. */
  fetch(slug: string, window: AnalyticsWindow): Promise<AnalyticsData>;
  /** Click and visitor totals for a set of slugs, for the link list. */
  totalsBySlug(
    slugs: readonly string[],
    window: AnalyticsWindow,
  ): Promise<Map<string, AnalyticsTotals>>;
  close(): Promise<void>;
}

/**
 * A table and the expressions that read a window out of it.
 *
 * Everything that differs between raw events and pre-aggregated rows is in here, so
 * the query builders below are written once rather than twice — which is what keeps
 * a fix to the series query from missing the totals query.
 */
interface Grain {
  table: string;
  /** The bucketable time column, as a `DateTime`. */
  time: string;
  /** Window predicate. Placeholders are bound, never interpolated. */
  filter: string;
  clicks: string;
  visitors: string;
}

const FROM_INSTANT = "fromUnixTimestamp64Milli({from:Int64}, 'UTC')";
const TO_INSTANT = "fromUnixTimestamp64Milli({to:Int64}, 'UTC')";

const RAW: Grain = {
  table: "clicks",
  time: "toDateTime(ts)",
  /* Half-open, so a bucket boundary belongs to exactly one window and two adjacent
     ranges never both count the same click. */
  filter: `ts >= ${FROM_INSTANT} AND ts < ${TO_INSTANT}`,
  clicks: "count()",
  visitors: "uniq(visitor_hash)",
};

const HOURLY: Grain = {
  table: "clicks_hourly",
  time: "hour",
  /* Snapped down: the hour bucket containing `from` holds clicks from inside the
     window, and excluding it would lose them. It also holds a few from before the
     window — the trade the rollup makes, and the reason `source` is reported. */
  filter: `hour >= toStartOfHour(${FROM_INSTANT}) AND hour < ${TO_INSTANT}`,
  clicks: "sum(clicks)",
  visitors: "uniqMerge(visitors)",
};

const DAILY: Grain = {
  table: "clicks_daily",
  time: "toDateTime(day, 'UTC')",
  /* `day` is a Date, so both bounds are inclusive dates: a window ending at 09:15
     still needs that day's row. */
  filter: `day >= toDate(${FROM_INSTANT}) AND day <= toDate(${TO_INSTANT})`,
  clicks: "sum(clicks)",
  visitors: "uniqMerge(visitors)",
};

/** Response key to the column that backs it. */
const BREAKDOWN_COLUMNS: Readonly<Record<BreakdownDimension, string>> = {
  country: "country",
  deviceType: "device_type",
  browser: "browser",
  os: "os",
  referrer: "referrer_host",
};

/** ClickHouse quotes 64-bit integers in JSON, so a count arrives as a string. */
const countValue = z.coerce.number().int().nonnegative();

const totalsRowSchema = z.object({ clicks: countValue, visitors: countValue });
const seriesRowSchema = z.object({
  bucket: z.coerce.number().int(),
  clicks: countValue,
  visitors: countValue,
});
const breakdownRowSchema = z.object({
  dimension: z.enum(BREAKDOWN_DIMENSIONS),
  key: z.string(),
  clicks: countValue,
  visitors: countValue,
});
const slugTotalsRowSchema = totalsRowSchema.extend({ slug: z.string() });

export class ClickHouseAnalyticsStore implements AnalyticsStore {
  readonly #client: ClickHouseClient;

  public constructor(config: ClickHouseConfig) {
    this.#client = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      /* A dashboard load issues three queries at once and the endpoint is cached,
         so the pool only has to cover a burst of uncached viewers. */
      max_open_connections: 10,
      request_timeout: 10_000,
      clickhouse_settings: {
        /* A per-slug dashboard query that needs a quarter gigabyte is a bug in this
           file, not a reason to let one viewer push the click pipeline out of memory
           on a box with a gigabyte of it. */
        max_memory_usage: "256000000",
        /* This client only ever reads. `2` rather than `1` because `1` also forbids
           the per-query settings sent alongside it, which makes the request itself
           fail rather than the write it is meant to prevent. */
        readonly: "2",
      },
    });
  }

  public async fetch(slug: string, window: AnalyticsWindow): Promise<AnalyticsData> {
    const timeGrain = window.source === "raw" ? RAW : HOURLY;
    const breakdownGrain = window.source === "raw" ? RAW : DAILY;
    const params = windowParams(slug, window);

    /* Concurrent because they are independent reads of the same window, and a
       dashboard that waits for three round trips in series feels broken. */
    const [totals, series, breakdowns] = await Promise.all([
      this.#totals(timeGrain, params),
      this.#series(timeGrain, window, params),
      this.#breakdowns(breakdownGrain, params),
    ]);

    return { totals, series, breakdowns };
  }

  public async totalsBySlug(
    slugs: readonly string[],
    window: AnalyticsWindow,
  ): Promise<Map<string, AnalyticsTotals>> {
    if (slugs.length === 0) {
      /* No slugs means no query. `slug IN []` is legal and returns nothing, but
         paying a round trip to learn that is silly. */
      return new Map();
    }

    const grain = window.source === "raw" ? RAW : HOURLY;
    const rows = await this.#query(
      slugTotalsRowSchema,
      `SELECT toString(slug) AS slug, ${grain.clicks} AS clicks, ${grain.visitors} AS visitors
       FROM ${grain.table}
       WHERE slug IN {slugs:Array(String)} AND ${grain.filter}
       GROUP BY slug`,
      { slugs, from: window.fromMs, to: window.toMs },
    );

    return new Map(rows.map((row) => [row.slug, { clicks: row.clicks, visitors: row.visitors }]));
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }

  async #totals(grain: Grain, params: QueryParams): Promise<AnalyticsTotals> {
    const rows = await this.#query(
      totalsRowSchema,
      `SELECT ${grain.clicks} AS clicks, ${grain.visitors} AS visitors
       FROM ${grain.table}
       WHERE slug = {slug:String} AND ${grain.filter}`,
      params,
    );

    /* An aggregate with no GROUP BY always returns exactly one row, even over an
       empty table — but reading `[0]` without a fallback would be an undefined
       waiting for the day that stops being true. */
    return rows[0] ?? { clicks: 0, visitors: 0 };
  }

  async #series(
    grain: Grain,
    window: AnalyticsWindow,
    params: QueryParams,
  ): Promise<AnalyticsSeriesPoint[]> {
    const bucket = bucketExpression(grain.time, window.granularity);
    const rows = await this.#query(
      seriesRowSchema,
      `SELECT toUnixTimestamp(${bucket}) AS bucket,
              ${grain.clicks} AS clicks,
              ${grain.visitors} AS visitors
       FROM ${grain.table}
       WHERE slug = {slug:String} AND ${grain.filter}
       GROUP BY bucket
       ORDER BY bucket`,
      params,
    );

    return rows.map((row) => ({
      tsMs: row.bucket * 1000,
      clicks: row.clicks,
      visitors: row.visitors,
    }));
  }

  async #breakdowns(grain: Grain, params: QueryParams): Promise<AnalyticsBreakdowns> {
    const rows = await this.#query(breakdownRowSchema, breakdownQuery(grain), params);

    const breakdowns: AnalyticsBreakdowns = {
      country: [],
      deviceType: [],
      browser: [],
      os: [],
      referrer: [],
    };
    for (const row of rows) {
      breakdowns[row.dimension].push({
        key: row.key,
        clicks: row.clicks,
        visitors: row.visitors,
      });
    }

    /* One query returns all five panels interleaved, so each is re-sorted here
       rather than trusting the union's row order. */
    for (const dimension of BREAKDOWN_DIMENSIONS) {
      breakdowns[dimension].sort((a, b) => b.clicks - a.clicks || a.key.localeCompare(b.key));
    }

    return breakdowns;
  }

  /** Runs a query and parses every row — ClickHouse is a boundary like any other. */
  async #query<Row>(
    schema: z.ZodType<Row>,
    query: string,
    params: QueryParams,
  ): Promise<Row[]> {
    const result = await this.#client.query({
      query,
      query_params: params,
      format: "JSONEachRow",
    });

    const rows = await result.json<unknown>();
    return rows.map((row) => schema.parse(row));
  }
}

interface QueryParams {
  [key: string]: string | number | readonly string[];
}

function windowParams(slug: string, window: AnalyticsWindow): QueryParams {
  return { slug, from: window.fromMs, to: window.toMs, tz: window.timeZone };
}

/**
 * The bucket a row falls into, computed in the viewer's zone.
 *
 * The zone is a bound parameter rather than an interpolated string, and it has
 * already been through `normalizeTimeZone`, so an unknown zone is a 400 from the
 * schema rather than an error from ClickHouse.
 */
function bucketExpression(time: string, granularity: AnalyticsWindow["granularity"]): string {
  switch (granularity) {
    case "15m":
      return `toStartOfInterval(${time}, INTERVAL 15 MINUTE, {tz:String})`;
    case "hour":
      return `toStartOfHour(${time}, {tz:String})`;
    case "day":
      return `toStartOfDay(${time}, {tz:String})`;
  }
}

/**
 * All five breakdown panels as one query.
 *
 * A union of five limited selects rather than five round trips, and rather than
 * `GROUPING SETS` — which returns an empty string for the columns a row is not
 * grouped by, and `referrer_host` is genuinely empty for direct traffic. There
 * would be no way to tell the two apart without also selecting `GROUPING()` bits.
 *
 * `toString` on the key because the dimension columns are `LowCardinality(String)`
 * except `referrer_host`, and a union has to agree on a type.
 */
function breakdownQuery(grain: Grain): string {
  return BREAKDOWN_DIMENSIONS.map(
    (dimension) => `(
      SELECT '${dimension}' AS dimension,
             toString(${BREAKDOWN_COLUMNS[dimension]}) AS key,
             ${grain.clicks} AS clicks,
             ${grain.visitors} AS visitors
      FROM ${grain.table}
      WHERE slug = {slug:String} AND ${grain.filter}
      GROUP BY key
      ORDER BY clicks DESC, key ASC
      LIMIT ${BREAKDOWN_LIMIT}
    )`,
  ).join("\nUNION ALL\n");
}

/** Builds a configured analytics store. */
export function createAnalyticsStore(config: ClickHouseConfig): AnalyticsStore {
  return new ClickHouseAnalyticsStore(config);
}
