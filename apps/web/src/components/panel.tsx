"use client";

/**
 * The card every panel lives in, and the three states it can be in.
 *
 * States are a prop rather than something each panel re-implements, because "no
 * data yet" and "the query failed" look identical if you let them: both render
 * nothing. A panel that silently shows an empty chart when ClickHouse is down is
 * the exact failure this dashboard exists to make visible.
 *
 * A refresh never returns to the skeleton. The previous render is held at reduced
 * opacity, so the numbers do not disappear and the layout does not jump every
 * fifteen seconds.
 */

import type { ReactNode } from "react";

export interface PanelProps {
  title: string;
  subtitle?: string | undefined;
  action?: ReactNode;
  isLoading?: boolean;
  isRefreshing?: boolean;
  error?: Error | undefined;
  isEmpty?: boolean;
  emptyMessage?: string;
  onRetry?: (() => void) | undefined;
  children: ReactNode;
}

export function Panel({
  title,
  subtitle,
  action,
  isLoading = false,
  isRefreshing = false,
  error,
  isEmpty = false,
  emptyMessage = "No data in this range",
  onRetry,
  children,
}: PanelProps) {
  return (
    <section className="flex flex-col rounded-lg border border-hairline bg-surface p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </header>

      {error !== undefined ? (
        <PanelError error={error} onRetry={onRetry} />
      ) : isLoading ? (
        <PanelSkeleton />
      ) : isEmpty ? (
        <p className="py-8 text-center text-sm text-ink-3">{emptyMessage}</p>
      ) : (
        <div className={isRefreshing ? "opacity-60 transition-opacity" : "transition-opacity"}>
          {children}
        </div>
      )}
    </section>
  );
}

function PanelError({ error, onRetry }: { error: Error; onRetry?: (() => void) | undefined }) {
  return (
    <div role="alert" className="py-6 text-center">
      <p className="text-sm text-critical">{error.message}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded border border-hairline px-3 py-1 text-xs text-ink-2 hover:bg-plane"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * A skeleton, not a spinner.
 *
 * A spinner that never resolves looks the same as one that is about to; a shape
 * that matches the content it is standing in for at least does not move the page
 * when the content arrives.
 */
function PanelSkeleton() {
  return (
    <div className="animate-pulse space-y-2 py-2" aria-hidden="true">
      <div className="h-3 w-2/3 rounded bg-grid" />
      <div className="h-3 w-1/2 rounded bg-grid" />
      <div className="h-3 w-3/4 rounded bg-grid" />
    </div>
  );
}
