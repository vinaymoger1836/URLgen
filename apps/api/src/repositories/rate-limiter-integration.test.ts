/**
 * The Redis limiter against a real Redis.
 *
 * SKIPPED unless `REDIS_TEST_URL` is set:
 *
 *   pnpm services:up
 *   REDIS_TEST_URL=redis://127.0.0.1:6379 pnpm test
 *
 * The gap these cover is entirely in the Lua, and it is the same gap as the click
 * buffer's: that trim-count-decide-record is genuinely one atomic step under
 * concurrency. Issued as four separate commands, a burst all reads a count below
 * the limit before any of them writes, and every one of them is admitted — which
 * is precisely the burst a rate limit exists to stop.
 *
 * Every test runs under its own key prefix, so a failure leaves nothing behind.
 */

import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createRedis } from "./click-buffer.js";
import { RedisRateLimiter, type RateLimitRule } from "./rate-limiter.js";

const url = process.env.REDIS_TEST_URL;

let redis: Redis;
let prefix: string;
let counter = 0;

const start = Date.parse("2026-08-09T12:00:00.000Z");

function limiter(): RedisRateLimiter {
  return new RedisRateLimiter({ redis, keyPrefix: prefix });
}

describe.skipIf(url === undefined)("RedisRateLimiter (integration)", () => {
  beforeEach(async () => {
    redis ??= createRedis({
      url: url ?? "",
      onError: () => {
        /* Reported by the failing assertion; a console line adds nothing. */
      },
    });
    if (redis.status === "wait") {
      await redis.connect();
    }
    counter += 1;
    prefix = `urlgen:test:rl:${String(Date.now())}:${String(counter)}`;
  });

  afterAll(async () => {
    const keys = await redis.keys("urlgen:test:rl:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    redis.disconnect();
  });

  it("allows up to the limit and then refuses", async () => {
    const rule: RateLimitRule = { limit: 3, windowMs: 60_000 };
    const subject = limiter();

    expect((await subject.consume("k", rule, start)).allowed).toBe(true);
    expect((await subject.consume("k", rule, start)).allowed).toBe(true);
    expect((await subject.consume("k", rule, start)).allowed).toBe(true);

    const refused = await subject.consume("k", rule, start);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it("counts every request in the same millisecond", async () => {
    /* The bug this pins: a sorted-set member has to be unique. With the timestamp
       as the member, N requests inside one millisecond are one `ZADD` overwriting
       itself N times, `ZCARD` reads 1, and the limiter silently admits everything
       a fast client sends. Reads 20 with a UUID member, 1 without. */
    const rule: RateLimitRule = { limit: 50, windowMs: 60_000 };
    const subject = limiter();

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => subject.consume("same-ms", rule, start)),
    );

    expect(decisions.every((decision) => decision.allowed)).toBe(true);
    expect(await redis.zcard(`${prefix}:same-ms`)).toBe(20);
  });

  it("is atomic under concurrency — 50 simultaneous requests against a limit of 10 admit exactly 10", async () => {
    const rule: RateLimitRule = { limit: 10, windowMs: 60_000 };
    const subject = limiter();

    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => subject.consume("burst", rule, start)),
    );

    /* Reads 50 without the Lua script: each of the 50 checks the count before any
       of them has written. */
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(40);
  });

  it("slides rather than resetting at a boundary", async () => {
    const rule: RateLimitRule = { limit: 2, windowMs: 10_000 };
    const subject = limiter();

    await subject.consume("slide", rule, start);
    await subject.consume("slide", rule, start + 5_000);
    expect((await subject.consume("slide", rule, start + 6_000)).allowed).toBe(false);

    /* The first has aged out, the second has not: one slot back, not two. */
    const partial = await subject.consume("slide", rule, start + 10_001);
    expect(partial.allowed).toBe(true);
    expect(partial.remaining).toBe(0);
  });

  it("reports the reset as the oldest survivor's expiry, not the end of a bucket", async () => {
    const rule: RateLimitRule = { limit: 1, windowMs: 30_000 };
    const subject = limiter();

    await subject.consume("reset", rule, start);
    const refused = await subject.consume("reset", rule, start + 7_000);

    expect(refused.allowed).toBe(false);
    expect(refused.resetAtMs).toBe(start + 30_000);
  });

  it("expires its key so an untouched limit costs no memory", async () => {
    const rule: RateLimitRule = { limit: 5, windowMs: 30_000 };
    await limiter().consume("ttl", rule, Date.now());

    const ttl = await redis.pttl(`${prefix}:ttl`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  it("stores at most `limit` members, so memory is bounded by the limit itself", async () => {
    const rule: RateLimitRule = { limit: 4, windowMs: 60_000 };
    const subject = limiter();

    for (let index = 0; index < 40; index += 1) {
      await subject.consume("bounded", rule, start + index);
    }

    expect(await redis.zcard(`${prefix}:bounded`)).toBe(4);
  });
});
