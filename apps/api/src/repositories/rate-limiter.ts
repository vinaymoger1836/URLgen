/**
 * Sliding-window rate limiting.
 *
 * ## Why a sliding window log rather than a fixed-window counter
 *
 * A fixed window (`INCR` a key named for the current minute, expire it) is one
 * command and is what most tutorials show. Its failure is at the boundary: a
 * limit of 20 per minute allows 20 at 11:00:59 and another 20 at 11:01:00 — 40
 * requests inside two seconds, which is exactly the burst the limit exists to
 * stop. Approximating the window away is fine for billing and wrong for abuse.
 *
 * So each key holds a sorted set of the timestamps of its recent requests.
 * Trimming everything older than the window and counting what is left gives the
 * true count over the *trailing* window, at any instant, with no boundary to game.
 * It also makes `Retry-After` honest: the moment capacity returns is exactly when
 * the oldest surviving entry falls out of the window, which is a value we have
 * rather than one we round up to the end of a bucket.
 *
 * The cost is memory — one member per request instead of one integer per window —
 * and that cost is bounded by the limit itself, because the set is trimmed before
 * it is counted and nothing is ever added once it is full. A limit of 20 stores at
 * most 20 members.
 *
 * ## Why it is one Lua script
 *
 * Trim, count, decide and add have to be one atomic step. Issued separately, a
 * burst of concurrent requests each read a count below the limit before any of
 * them wrote, and all of them are admitted — the same race the click buffer's push
 * script exists to close, with the same test to prove it.
 *
 * ## Why the clock comes from the caller
 *
 * `redis.call('TIME')` inside a script is the obvious alternative and it is worse:
 * it makes the script non-deterministic, and it means the limiter's behaviour in a
 * test depends on a clock the test cannot move. The caller passes `now`, so tests
 * drive time directly and the production path uses `Date.now()`.
 */

import { randomUUID } from "node:crypto";

import { Redis, type Result } from "ioredis";

/** One limit: how many requests, over how long a trailing window. */
export interface RateLimitRule {
  /** Requests permitted inside the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Requests still available. Zero on a rejection. */
  remaining: number;
  /** Epoch milliseconds at which capacity returns. */
  resetAtMs: number;
}

export interface RateLimiter {
  /**
   * Records one request against `key` and says whether it is allowed.
   *
   * A rejected request is not recorded, so being refused does not extend the
   * penalty — hammering a limit that has already tripped cannot make the wait
   * longer than the window.
   */
  consume(key: string, rule: RateLimitRule, now?: number): Promise<RateLimitDecision>;
}

/**
 * Trim, count, decide, record — atomically.
 *
 * `ZREMRANGEBYSCORE` drops everything that has aged out of the trailing window,
 * so `ZCARD` is the live count rather than a running total that only resets on
 * expiry. On rejection the oldest survivor's score plus the window is the exact
 * instant capacity returns.
 *
 * The member is a UUID, not the timestamp: sorted-set members are unique, so two
 * requests arriving in the same millisecond under a timestamp member would be one
 * `ZADD` overwriting the other and the limiter would silently undercount.
 */
const CONSUME_SCRIPT = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)
local used = redis.call('ZCARD', KEYS[1])

if used >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local resetAt = now + windowMs
  if oldest[2] ~= nil then
    resetAt = tonumber(oldest[2]) + windowMs
  end
  return {0, 0, resetAt}
end

redis.call('ZADD', KEYS[1], now, ARGV[4])
-- A full window from now, so a key nobody touches again expires itself rather
-- than waiting for eviction.
redis.call('PEXPIRE', KEYS[1], windowMs)
return {1, limit - used - 1, now + windowMs}
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    rateLimitConsume(
      key: string,
      now: string,
      windowMs: string,
      limit: string,
      member: string,
    ): Result<[number, number, number], Context>;
  }
}

export const DEFAULT_RATE_LIMIT_PREFIX = "urlgen:rl";

export interface RedisRateLimiterOptions {
  redis: Redis;
  /** Key namespace, so one Redis can serve more than one environment. */
  keyPrefix?: string | undefined;
}

/** The production limiter. */
export class RedisRateLimiter implements RateLimiter {
  readonly #redis: Redis;
  readonly #prefix: string;

  public constructor(options: RedisRateLimiterOptions) {
    this.#redis = options.redis;
    this.#prefix = options.keyPrefix ?? DEFAULT_RATE_LIMIT_PREFIX;

    /* Idempotent: registering the same name twice on a connection is harmless, and
       doing it here means a limiter built from a shared connection cannot be used
       before its script exists. */
    this.#redis.defineCommand("rateLimitConsume", { numberOfKeys: 1, lua: CONSUME_SCRIPT });
  }

  public async consume(
    key: string,
    rule: RateLimitRule,
    now: number = Date.now(),
  ): Promise<RateLimitDecision> {
    const [allowed, remaining, resetAtMs] = await this.#redis.rateLimitConsume(
      `${this.#prefix}:${key}`,
      String(now),
      String(rule.windowMs),
      String(rule.limit),
      randomUUID(),
    );

    return {
      allowed: allowed === 1,
      limit: rule.limit,
      remaining,
      resetAtMs,
    };
  }
}

/**
 * A limiter that keeps its windows in process memory.
 *
 * Correct for a single process and used by the route tests, which need real
 * limiting behaviour without a Redis. It is deliberately *not* the production
 * fallback for a Redis outage — see `fail-open.ts`-style reasoning in
 * `rate-limit.ts`: a per-process limiter behind N replicas silently multiplies
 * every limit by N, which is a worse lie than admitting the limiter is down.
 */
export class InMemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, number[]>();

  public consume(
    key: string,
    rule: RateLimitRule,
    now: number = Date.now(),
  ): Promise<RateLimitDecision> {
    const cutoff = now - rule.windowMs;
    const kept = (this.#windows.get(key) ?? []).filter((stamp) => stamp > cutoff);

    if (kept.length >= rule.limit) {
      this.#windows.set(key, kept);
      const oldest = kept[0] ?? now;
      return Promise.resolve({
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        resetAtMs: oldest + rule.windowMs,
      });
    }

    kept.push(now);
    this.#windows.set(key, kept);

    return Promise.resolve({
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - kept.length,
      resetAtMs: now + rule.windowMs,
    });
  }

  /** Test helper: forget every window. */
  public reset(): void {
    this.#windows.clear();
  }
}

/** A limiter that allows everything. What `RATE_LIMIT_ENABLED=false` installs. */
export class NoopRateLimiter implements RateLimiter {
  public consume(
    _key: string,
    rule: RateLimitRule,
    now: number = Date.now(),
  ): Promise<RateLimitDecision> {
    return Promise.resolve({
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetAtMs: now + rule.windowMs,
    });
  }
}
