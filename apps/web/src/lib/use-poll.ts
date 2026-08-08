"use client";

/**
 * Polling, and why it is polling.
 *
 * The alternative was SSE, and it loses on every axis that matters here:
 *
 * - **There is nothing to push.** Clicks reach ClickHouse through a Redis buffer
 *   that the flusher drains on a timer. The data's own freshness is measured in
 *   seconds, so a stream would spend its life idle and then deliver an update the
 *   next poll would have caught anyway.
 * - **A stream is a held connection per open tab**, on a t3.micro that is also
 *   running Redis, ClickHouse and the API. Polling is stateless: the request either
 *   happens or it does not, and nothing accumulates when a viewer walks away with
 *   the tab open.
 * - **The server already has the matching cache.** Analytics responses are cached
 *   for one tick and the window is quantized to the same tick, so N tabs polling in
 *   one interval collapse into a single ClickHouse read. Push would need its own
 *   fan-out to achieve what falls out of the cache for free.
 * - **It survives what SSE does not** — proxies that buffer, a laptop lid closing,
 *   a connection dropping. There is no reconnect logic here because there is no
 *   connection.
 *
 * The interval is 15 seconds, matching the server's cache TTL: polling faster would
 * return the identical bytes, and slower would waste freshness the server already
 * paid for.
 *
 * Two behaviours that make it feel live rather than merely repetitive: a hidden tab
 * does not poll at all, and it refetches immediately on becoming visible, so
 * returning to the tab shows current data rather than whatever was on screen when it
 * was hidden.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Matches the API's `ANALYTICS_CACHE_TTL_SECONDS` default. */
export const POLL_INTERVAL_MS = 15_000;

export interface PollState<T> {
  data: T | undefined;
  error: Error | undefined;
  /** True only for the first load — a refresh must not blank the screen. */
  isLoading: boolean;
  /** True while a background refresh is in flight, for a subtle busy hint. */
  isRefreshing: boolean;
  refresh: () => void;
}

/**
 * Runs `fetcher` now, then every interval while the tab is visible.
 *
 * `fetcher` is expected to be stable — wrap it in `useCallback` with the values it
 * closes over, and changing those is what re-runs the query.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = POLL_INTERVAL_MS,
): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  /* Guards against a slow response from a previous query — a range change while a
     request is in flight would otherwise let the stale answer land last and win. */
  const generation = useRef(0);

  const run = useCallback(async () => {
    const current = generation.current;
    setIsRefreshing(true);
    try {
      const result = await fetcher();
      if (generation.current === current) {
        setData(result);
        setError(undefined);
      }
    } catch (caught) {
      if (generation.current === current) {
        setError(caught instanceof Error ? caught : new Error("Request failed"));
      }
    } finally {
      if (generation.current === current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [fetcher]);

  useEffect(() => {
    generation.current += 1;
    /* A new fetcher means a different question. Show the loading state rather than
       the previous question's answer, which would otherwise sit there mislabelled. */
    setIsLoading(true);
    setData(undefined);
    void run();

    let timer: ReturnType<typeof setInterval> | undefined;

    const start = (): void => {
      timer ??= setInterval(() => void run(), intervalMs);
    };

    const stop = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        /* Catch up immediately: a tab that was hidden for ten minutes should not
           show ten-minute-old numbers for another fifteen seconds. */
        void run();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [run, intervalMs]);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  return { data, error, isLoading, isRefreshing, refresh };
}
