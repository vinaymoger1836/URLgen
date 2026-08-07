/**
 * Integration tests for the single-flusher lease, against a real Redis.
 *
 * SKIPPED unless `REDIS_TEST_URL` is set. There is nothing worth faking here: the
 * lease is a compare-and-set in Lua, and a fake would only be testing that the
 * fake works. What matters is that a second process really is refused, and that a
 * dead one's lease really does lapse.
 */

import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { RedisFlushLease } from "./flush-lease.js";

const url = process.env.REDIS_TEST_URL;

let redis: Redis;
let key: string;
let counter = 0;

function lease(ownerId: string, ttlMs = 30_000): RedisFlushLease {
  return new RedisFlushLease({ redis, ownerId, ttlMs, key });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe.skipIf(url === undefined)("RedisFlushLease (integration)", () => {
  beforeEach(async () => {
    redis ??= new Redis(url ?? "", { maxRetriesPerRequest: null });
    counter += 1;
    key = `urlgen-test:lease:${String(Date.now())}:${String(counter)}`;
    await redis.del(key);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("grants the lease to the first caller", async () => {
    await expect(lease("flusher-a").acquire()).resolves.toBe(true);
  });

  it("refuses a second holder", async () => {
    await lease("flusher-a").acquire();

    /* The whole point: two flushers against one in-flight list is silent data
       loss, and it only happens under a configuration nobody tests. */
    await expect(lease("flusher-b").acquire()).resolves.toBe(false);
  });

  it("lets the holder renew without losing it", async () => {
    const holder = lease("flusher-a");
    await holder.acquire();

    await expect(holder.acquire()).resolves.toBe(true);
    await expect(lease("flusher-b").acquire()).resolves.toBe(false);
  });

  it("hands over once the lease lapses", async () => {
    await lease("flusher-a", 200).acquire();

    await sleep(300);

    /* A flusher that dies must not take the pipeline down with it. */
    await expect(lease("flusher-b").acquire()).resolves.toBe(true);
  });

  it("frees the lease on release, so a deploy hands over immediately", async () => {
    const holder = lease("flusher-a");
    await holder.acquire();

    await holder.release();

    await expect(lease("flusher-b").acquire()).resolves.toBe(true);
  });

  it("does not let a lapsed holder release someone else's lease", async () => {
    await lease("flusher-a", 200).acquire();
    await sleep(300);
    await lease("flusher-b").acquire();

    /* The classic distributed-lock bug: A pauses long enough to lose the lease,
       wakes up, and deletes the lock B is now holding. The owner check in the
       release script is what prevents it. */
    await lease("flusher-a", 200).release();

    await expect(lease("flusher-c").acquire()).resolves.toBe(false);
  });

  it("does not let a lapsed holder steal the lease back by renewing", async () => {
    const stale = lease("flusher-a", 200);
    await stale.acquire();
    await sleep(300);
    await lease("flusher-b").acquire();

    await expect(stale.acquire()).resolves.toBe(false);
  });
});
