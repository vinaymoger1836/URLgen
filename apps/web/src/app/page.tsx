"use client";

/**
 * The link list.
 *
 * Two requests, polled together: the links themselves from DynamoDB and their click
 * totals from ClickHouse. They are separate endpoints because they are separate
 * stores with different consistency and different cost — joining them here, on the
 * slug, costs one `Map` lookup and keeps the API from inventing a join it would then
 * have to keep fast.
 *
 * The stored `clickCount` on a link is deliberately not what is shown. Nothing
 * increments it — clicks are counted in the analytics pipeline, never on the
 * redirect's critical path — so rendering it would print a confident zero next to a
 * link with thousands of visits.
 */

import type { AnalyticsPreset, LinkApiResponse } from "@urlgen/shared";
import Link from "next/link";
import { useCallback, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { CreateLinkForm } from "@/components/create-link-form";
import { Panel } from "@/components/panel";
import { RangeSelector } from "@/components/range-selector";
import { api, browserTimeZone } from "@/lib/api";
import { formatCount, formatDate, RANGE_LABELS } from "@/lib/format";
import { usePoll } from "@/lib/use-poll";

interface DashboardData {
  links: LinkApiResponse[];
  totals: Map<string, { clicks: number; visitors: number }>;
}

export default function LinksPage() {
  const [range, setRange] = useState<AnalyticsPreset>("7d");
  /* Bumped after a create or delete so the poll refetches immediately rather than
     leaving the new link missing for up to a full interval. */
  const [revision, setRevision] = useState(0);
  const [timeZone] = useState(browserTimeZone);

  const fetcher = useCallback(async (): Promise<DashboardData> => {
    void revision;
    const [links, totals] = await Promise.all([
      api.listLinks(),
      api.totals({ range, timeZone }),
    ]);
    return {
      links: links.items,
      totals: new Map(totals.items.map((item) => [item.slug, item])),
    };
  }, [range, timeZone, revision]);

  const { data, error, isLoading, isRefreshing, refresh } = usePoll(fetcher);

  const reload = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  return (
    <div className="space-y-6">
      <CreateLinkForm onCreated={reload} />

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold text-ink">Your links</h1>
        <RangeSelector value={range} onChange={setRange} />
      </div>

      <Panel
        title="Links"
        subtitle={`Clicks over ${(RANGE_LABELS[range] ?? range).toLowerCase()}`}
        isLoading={isLoading}
        isRefreshing={isRefreshing}
        error={error}
        onRetry={refresh}
        isEmpty={data?.links.length === 0}
        emptyMessage="No links yet — shorten one above."
      >
        <ul className="divide-y divide-hairline">
          {data?.links.map((link) => (
            <LinkRow
              key={link.slug}
              link={link}
              totals={data.totals.get(link.slug)}
              onDeleted={reload}
            />
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function LinkRow({
  link,
  totals,
  onDeleted,
}: {
  link: LinkApiResponse;
  totals: { clicks: number; visitors: number } | undefined;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            href={`/links/${link.slug}`}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            /{link.slug}
          </Link>
          <StatusBadge status={link.status} />
        </div>
        <p className="mt-0.5 truncate text-xs text-ink-3" title={link.targetUrl}>
          {link.targetUrl}
        </p>
      </div>

      <div className="flex items-center gap-4 text-right">
        <div>
          <p className="text-sm font-medium tabular-nums text-ink">
            {formatCount(totals?.clicks ?? 0)}
          </p>
          <p className="text-xs text-ink-3">clicks</p>
        </div>
        <div>
          <p className="text-sm font-medium tabular-nums text-ink">
            {formatCount(totals?.visitors ?? 0)}
          </p>
          <p className="text-xs text-ink-3">visitors</p>
        </div>
        <div className="hidden sm:block">
          <p className="text-xs text-ink-2">{formatDate(link.createdAt)}</p>
          <p className="text-xs text-ink-3">created</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <CopyButton value={link.shortUrl} />
        <button
          type="button"
          disabled={deleting}
          onClick={() => {
            setDeleting(true);
            setDeleteError(undefined);
            api.deleteLink(link.slug).then(
              () => {
                onDeleted();
              },
              (caught: unknown) => {
                setDeleting(false);
                setDeleteError(caught instanceof Error ? caught.message : "Delete failed");
              },
            );
          }}
          className="rounded border border-hairline px-2 py-0.5 text-xs text-ink-2 hover:bg-plane disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>

      {deleteError !== undefined && (
        <p role="alert" className="w-full text-xs text-critical">
          {deleteError}
        </p>
      )}
    </li>
  );
}

function StatusBadge({ status }: { status: LinkApiResponse["status"] }) {
  if (status === "active") {
    return null;
  }
  /* Colour is never the only signal — the word is the label, and the colour only
     reinforces it. */
  return (
    <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] uppercase tracking-wide text-warning">
      {status}
    </span>
  );
}
