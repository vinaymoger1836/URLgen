"use client";

/**
 * One link's analytics.
 *
 * Everything on the page reads a single window, chosen once in the filter row — the
 * stat tiles, the time series and all five breakdown panels come from one request,
 * so no two panels can ever be showing different ranges.
 *
 * When the server answers from the rollups rather than raw events it says so, and
 * the page repeats it. A number aggregated from UTC-bucketed hourly rows is a
 * slightly different claim from one counted off individual events, and a dashboard
 * that presents both as exact is quietly lying about one of them.
 */

import { BREAKDOWN_DIMENSIONS, type AnalyticsPreset } from "@urlgen/shared";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";

import { Breakdown } from "@/components/breakdown";
import { CopyButton } from "@/components/copy-button";
import { Panel } from "@/components/panel";
import { RangeSelector } from "@/components/range-selector";
import { StatTile } from "@/components/stat-tile";
import { TimeSeries } from "@/components/time-series";
import { api, ApiError, browserTimeZone } from "@/lib/api";
import { hasTraffic, toChartRows } from "@/lib/analytics-view";
import { DIMENSION_LABELS, formatBreakdownKey, formatDate, RANGE_LABELS } from "@/lib/format";
import { usePoll } from "@/lib/use-poll";

export default function LinkAnalyticsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [range, setRange] = useState<AnalyticsPreset>("7d");
  const [timeZone] = useState(browserTimeZone);

  const linkFetcher = useCallback(() => api.getLink(slug), [slug]);
  const analyticsFetcher = useCallback(
    () => api.analytics(slug, { range, timeZone }),
    [slug, range, timeZone],
  );

  const link = usePoll(linkFetcher);
  const analytics = usePoll(analyticsFetcher);

  if (link.error instanceof ApiError && link.error.isNotFound) {
    return (
      <div className="rounded-lg border border-hairline bg-surface p-8 text-center">
        <p className="text-sm text-ink">No such link.</p>
        <Link href="/" className="mt-3 inline-block text-xs text-ink-2 underline">
          Back to your links
        </Link>
      </div>
    );
  }

  const data = analytics.data;
  const empty = data !== undefined && !hasTraffic(data);
  const rangeLabel = (RANGE_LABELS[range] ?? range).toLowerCase();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-xs text-ink-3 hover:text-ink-2">
          ← Your links
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">/{slug}</h1>
            {link.data !== undefined && (
              <p className="mt-0.5 truncate text-xs text-ink-3" title={link.data.targetUrl}>
                → {link.data.targetUrl}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {link.data !== undefined && <CopyButton value={link.data.shortUrl} />}
            <RangeSelector value={range} onChange={setRange} />
          </div>
        </div>
        {link.data !== undefined && (
          <p className="mt-2 text-xs text-ink-3">
            Created {formatDate(link.data.createdAt)}
            {link.data.expiresAt !== undefined && ` · expires ${formatDate(link.data.expiresAt)}`}
            {link.data.status !== "active" && ` · ${link.data.status}`}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Clicks" value={data?.totals.clicks ?? 0} hero hint={rangeLabel} />
        <StatTile
          label="Unique visitors"
          value={data?.totals.visitors ?? 0}
          hint="Salted daily hash, never an IP"
        />
        <StatTile
          label="Top country"
          value={data?.breakdowns.country[0]?.clicks ?? 0}
          hint={
            data?.breakdowns.country[0]?.key === undefined
              ? "No data yet"
              : formatBreakdownKey("country", data.breakdowns.country[0].key)
          }
        />
      </div>

      <Panel
        title="Clicks over time"
        subtitle={
          data === undefined
            ? undefined
            : data.window.source === "rollup"
              ? `Aggregated from pre-computed rollups · ${data.granularity} buckets · ${data.window.timeZone}`
              : `Counted from raw events · ${data.granularity} buckets · ${data.window.timeZone}`
        }
        isLoading={analytics.isLoading}
        isRefreshing={analytics.isRefreshing}
        error={analytics.error}
        onRetry={analytics.refresh}
        isEmpty={empty}
        emptyMessage="No clicks in this range yet."
      >
        {data !== undefined && (
          <TimeSeries
            rows={toChartRows(data.series, data.granularity, data.window.timeZone)}
            granularity={data.granularity}
            timeZone={data.window.timeZone}
          />
        )}
      </Panel>

      <div className="grid gap-4 sm:grid-cols-2">
        {BREAKDOWN_DIMENSIONS.map((dimension) => (
          <Panel
            key={dimension}
            title={DIMENSION_LABELS[dimension] ?? dimension}
            isLoading={analytics.isLoading}
            isRefreshing={analytics.isRefreshing}
            error={analytics.error}
            onRetry={analytics.refresh}
            isEmpty={data?.breakdowns[dimension].length === 0}
          >
            {data !== undefined && (
              <Breakdown dimension={dimension} rows={data.breakdowns[dimension]} />
            )}
          </Panel>
        ))}
      </div>

      <p className="text-xs text-ink-3">
        Updates every 15 seconds while this tab is visible. Bot traffic is recorded and shown
        under Device.
      </p>
    </div>
  );
}
