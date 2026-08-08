/**
 * A short-lived cache in front of the analytics queries.
 *
 * The dashboard polls, and every open tab asks the same question about the same
 * link. Without a cache, ten viewers watching one link during a launch means ten
 * times the ClickHouse work for an answer that cannot have changed meaningfully —
 * the click pipeline flushes in batches every few seconds, so sub-second freshness
 * is not a thing this system has to offer in the first place.
 *
 * ## Why the clock is quantized rather than the answer being timestamped
 *
 * The obvious cache key — slug, range, timezone — does not work for a rolling
 * window: "the last 24 hours" is a different pair of instants every millisecond, so
 * either the key changes on every request (nothing ever hits) or the key ignores the
 * window and starts returning answers to a question nobody asked.
 *
 * So the request's notion of *now* is floored to the cache's own TTL before the
 * window is resolved. Every request inside one 15-second tick resolves to the
 * identical window, which makes the key stable — and, more importantly, makes a
 * cached response byte-identical to the fresh one it stands in for. The cache is
 * then a pure optimisation: removing it changes latency and nothing else.
 *
 * Values are stored as the already-serialized JSON body. A hit skips parsing,
 * re-validating and re-serializing a payload that went through all three on the way
 * in, and it cannot drift from what a miss would have produced.
 */

import type { AnalyticsWindow } from "@urlgen/shared";
import type { Redis } from "ioredis";

/**
 * Bumped whenever the response shape changes.
 *
 * A deploy that changes the payload while old entries are still live would
 * otherwise serve the previous shape to a client expecting the new one for as long
 * as the TTL lasts. Cheap insurance: the old keys simply go unread and expire.
 */
const CACHE_VERSION = "a1";

const KEY_PREFIX = "analytics";

export interface AnalyticsCache {
  /** The stored JSON body, or `undefined` on a miss. */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/**
 * The key for one resolved window.
 *
 * Every input that changes the answer is in it. `granularity` and `source` are
 * derived from the rest and so are strictly redundant — they are included anyway,
 * because the day a threshold moves in `resolveAnalyticsWindow` is the day the same
 * window would otherwise return an entry computed under the old rule.
 */
export function analyticsCacheKey(slug: string, window: AnalyticsWindow): string {
  return [
    KEY_PREFIX,
    CACHE_VERSION,
    slug,
    window.fromMs,
    window.toMs,
    window.timeZone,
    window.granularity,
    window.source,
  ].join(":");
}

/** The key for the owner's link-totals listing. */
export function analyticsTotalsCacheKey(ownerId: string, window: AnalyticsWindow): string {
  return [
    KEY_PREFIX,
    CACHE_VERSION,
    "totals",
    ownerId,
    window.fromMs,
    window.toMs,
    window.source,
  ].join(":");
}

/**
 * Floors an instant to the cache's tick.
 *
 * This is what makes the key stable across a tick. It also caps how stale an answer
 * can be at one tick plus the TTL, which is well inside the flusher's own latency.
 */
export function quantizeClock(now: number, ttlSeconds: number): number {
  const quantumMs = Math.max(ttlSeconds, 1) * 1000;
  return Math.floor(now / quantumMs) * quantumMs;
}

export class RedisAnalyticsCache implements AnalyticsCache {
  readonly #redis: Redis;

  public constructor(redis: Redis) {
    this.#redis = redis;
  }

  public async get(key: string): Promise<string | undefined> {
    const value = await this.#redis.get(key);
    return value ?? undefined;
  }

  public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      return;
    }
    await this.#redis.set(key, value, "EX", ttlSeconds);
  }
}

/**
 * The cache that isn't.
 *
 * Used when the process has no Redis connection — which in practice means a test
 * that injected its own click buffer. Every request goes to ClickHouse, which is
 * correct, just slower.
 */
export class NoopAnalyticsCache implements AnalyticsCache {
  public get(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  public set(): Promise<void> {
    return Promise.resolve();
  }
}
