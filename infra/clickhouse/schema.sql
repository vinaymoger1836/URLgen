-- URLGen analytics schema.
--
-- `{db}` is substituted by `pnpm clickhouse:create` from CLICKHOUSE_DATABASE, so
-- the same file works against a local container and a real deployment. To run it
-- by hand instead:  sed 's/{db}/urlgen/g' schema.sql | clickhouse-client -mn
--
-- Every statement is idempotent. Re-running this file is the supported way to
-- apply it, not a thing to be careful about.

CREATE DATABASE IF NOT EXISTS {db};

-- ---------------------------------------------------------------------------
-- Raw clicks
-- ---------------------------------------------------------------------------
--
-- ORDER BY (slug, ts) because every query this product asks starts with "for this
-- link, over this window" — that ordering makes the slug a prefix scan and the
-- time range a binary search inside it. Adding a leading time column instead would
-- turn every per-link query into a full partition scan.
--
-- LowCardinality on the columns with a bounded set of values (a few hundred
-- countries, a dozen browsers) stores them as a dictionary-encoded index rather
-- than repeated strings. `city` and `referrer_host` are unbounded and stay plain
-- String — LowCardinality on a high-cardinality column is slower than not using it.
--
-- There is no IP column and there never will be. `visitor_hash` is an HMAC under a
-- salt that is thrown away nightly; see `visitor-hash.ts`.
CREATE TABLE IF NOT EXISTS {db}.clicks
(
    slug          LowCardinality(String),
    ts            DateTime64(3, 'UTC'),
    country       LowCardinality(String),
    city          String,
    timezone      LowCardinality(String),
    colo          LowCardinality(String),
    device_type   LowCardinality(String),
    browser       LowCardinality(String),
    os            LowCardinality(String),
    referrer_host String,
    visitor_hash  String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (slug, ts)
-- Raw events age out after 90 days; the rollups below are written on insert and
-- keep their history, so the dashboard's long ranges survive the deletion. This is
-- what keeps a free-tier 8 GB volume from filling up with rows nothing reads.
TTL toDateTime(ts) + INTERVAL 90 DAY
SETTINGS
    index_granularity = 8192,
    -- Enables `insert_deduplication_token` on a non-replicated table. Without it
    -- the token is accepted and ignored, and a retried flush double-counts. The
    -- window is measured in recent inserted blocks, which is far more history than
    -- a retry needs.
    non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- Rollups
-- ---------------------------------------------------------------------------
--
-- Materialized views here are insert triggers, not stored queries: each row that
-- lands in `clicks` is aggregated into these tables as it arrives, so the
-- dashboard reads a few hundred pre-aggregated rows instead of scanning millions.
--
-- `clicks` is SimpleAggregateFunction(sum, ...) because summing partial counts is
-- exact. `visitors` has to be a full AggregateFunction(uniq, ...) because unique
-- counts do not sum — adding two days of uniques double-counts anyone who came
-- both days. The intermediate HyperLogLog state merges correctly; a stored integer
-- would not.

-- Hourly: the time-series panel. No dimensions, so it stays tiny.
CREATE TABLE IF NOT EXISTS {db}.clicks_hourly
(
    slug     LowCardinality(String),
    hour     DateTime('UTC'),
    clicks   SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (slug, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS {db}.clicks_hourly_mv
TO {db}.clicks_hourly
AS
SELECT
    slug,
    toStartOfHour(ts) AS hour,
    count()           AS clicks,
    uniqState(visitor_hash) AS visitors
FROM {db}.clicks
GROUP BY slug, hour;

-- Daily with dimensions: every breakdown panel (geo, device, browser, OS,
-- referrer) reads this one table. One wide rollup beats five narrow ones — the
-- row count is bounded by the dimension product, which for a single link over a
-- day is small, and a single table keeps the MV count (and the insert cost) down.
CREATE TABLE IF NOT EXISTS {db}.clicks_daily
(
    slug          LowCardinality(String),
    day           Date,
    country       LowCardinality(String),
    device_type   LowCardinality(String),
    browser       LowCardinality(String),
    os            LowCardinality(String),
    referrer_host String,
    clicks        SimpleAggregateFunction(sum, UInt64),
    visitors      AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (slug, day, country, device_type, browser, os, referrer_host);

CREATE MATERIALIZED VIEW IF NOT EXISTS {db}.clicks_daily_mv
TO {db}.clicks_daily
AS
SELECT
    slug,
    toDate(ts) AS day,
    country,
    device_type,
    browser,
    os,
    referrer_host,
    count()                 AS clicks,
    uniqState(visitor_hash) AS visitors
FROM {db}.clicks
GROUP BY slug, day, country, device_type, browser, os, referrer_host;
