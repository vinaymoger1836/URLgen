/**
 * Integration tests for the analytics cache, against a real Redis.
 *
 * SKIPPED unless `REDIS_TEST_URL` is set:
 *
 *   pnpm services:up
 *   REDIS_TEST_URL=redis://127.0.0.1:6379 pnpm test
 *
 * Small, but the two things it checks are the two that a fake cannot: that the TTL
 * is actually attached to the key — an entry written without one is a permanent
 * stale answer, which is the failure mode of a caching bug that looks fine in
 * development — and that a JSON payload survives the round trip byte for byte,
 * since the route serves a hit verbatim without re-parsing it.
 */

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisAnalyticsCache } from "./analytics-cache.js";

const url = process.env.REDIS_TEST_URL;

let redis: Redis;
let cache: RedisAnalyticsCache;
let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return `analytics-test:${String(Date.now())}:${String(keyCounter)}`;
}

describe.skipIf(url === undefined)("RedisAnalyticsCache (integration)", () => {
  beforeAll(() => {
    redis = new Redis(url ?? "", { maxRetriesPerRequest: null });
    cache = new RedisAnalyticsCache(redis);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("misses for a key that was never written", async () => {
    await expect(cache.get(nextKey())).resolves.toBeUndefined();
  });

  it("round-trips a payload unchanged", async () => {
    const key = nextKey();
    const payload = JSON.stringify({ totals: { clicks: 3, visitors: 2 }, note: "üñî\"quoted\"" });

    await cache.set(key, payload, 30);

    /* Identical bytes, because a cache hit is sent to the client as-is. */
    await expect(cache.get(key)).resolves.toBe(payload);
  });

  it("attaches the TTL, so an entry cannot outlive its window", async () => {
    const key = nextKey();
    await cache.set(key, "{}", 30);

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it("writes nothing when caching is switched off", async () => {
    const key = nextKey();
    await cache.set(key, "{}", 0);

    /* A zero TTL means "do not cache". Redis would reject `EX 0` outright, and
       treating it as "no expiry" would be the worst possible reading. */
    await expect(redis.exists(key)).resolves.toBe(0);
  });
});
