/**
 * Integration tests against a real Redis.
 *
 * SKIPPED unless `REDIS_TEST_URL` is set, so `pnpm test` stays green on a machine
 * without Docker:
 *
 *   pnpm services:up
 *   REDIS_TEST_URL=redis://127.0.0.1:6379 pnpm test
 *
 * These cover what the in-memory fake cannot, and the gap is entirely in the Lua:
 * that `LLEN`-then-`RPUSH` is genuinely one atomic step under concurrency, that a
 * drain really moves rows rather than copying them, and that the in-flight list
 * survives a "crashed" flusher — which in this file means a buffer object that is
 * thrown away without ever acknowledging.
 *
 * Every test runs under its own key prefix, so a failure leaves nothing behind and
 * parallel runs cannot collide.
 */

import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ClickRow } from "../analytics/click-row.js";
import { RedisClickBuffer, clickKeys, createRedis } from "./click-buffer.js";

const url = process.env.REDIS_TEST_URL;

let redis: Redis;
let prefix: string;
let counter = 0;

function row(id: string): ClickRow {
  return {
    eventId: id,
    slug: "abc1234",
    ts: Date.parse("2026-08-07T10:00:00.000Z"),
    country: "IN",
    city: "Bengaluru",
    timezone: "Asia/Kolkata",
    colo: "BOM",
    deviceType: "mobile",
    browser: "Safari",
    os: "iOS",
    referrerHost: "news.ycombinator.com",
    visitorHash: "0123456789abcdef0123456789abcdef",
  };
}

function buffer(maxLength = 1000): RedisClickBuffer {
  return new RedisClickBuffer({ redis, maxLength, keyPrefix: prefix });
}

describe.skipIf(url === undefined)("RedisClickBuffer (integration)", () => {
  beforeEach(async () => {
    redis ??= createRedis({
      url: url ?? "",
      onError: () => {
        /* Reported by the failing assertion; a console line here adds nothing. */
      },
    });

    counter += 1;
    prefix = `urlgen-test:${String(Date.now())}:${String(counter)}`;
    const keys = clickKeys(prefix);
    await redis.del(keys.buffer, keys.inflight, keys.dropped);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("round-trips a row through Redis unchanged", async () => {
    const subject = buffer();
    await subject.push(row("event-1"));

    const batch = await subject.drain(10);

    /* JSON through Redis and back: the point is that nothing is lost or coerced
       on the way — a number that came back as a string would fail the schema. */
    expect(batch.rows).toEqual([row("event-1")]);
    expect(batch.discarded).toBe(0);
  });

  it("preserves arrival order", async () => {
    const subject = buffer();
    for (let i = 0; i < 5; i += 1) {
      await subject.push(row(`event-${String(i)}`));
    }

    const batch = await subject.drain(10);

    expect(batch.rows.map((r) => r.eventId)).toEqual([
      "event-0",
      "event-1",
      "event-2",
      "event-3",
      "event-4",
    ]);
  });

  it("claims at most the requested number", async () => {
    const subject = buffer();
    for (let i = 0; i < 5; i += 1) {
      await subject.push(row(`event-${String(i)}`));
    }

    const batch = await subject.drain(2);

    expect(batch.rows.map((r) => r.eventId)).toEqual(["event-0", "event-1"]);
    await expect(subject.depth()).resolves.toBe(3);
  });

  describe("the in-flight list", () => {
    it("moves rows out of the buffer without deleting them", async () => {
      const subject = buffer();
      await subject.push(row("event-1"));

      await subject.drain(10);

      await expect(subject.depth()).resolves.toBe(0);
      await expect(redis.llen(clickKeys(prefix).inflight)).resolves.toBe(1);
    });

    it("hands the same batch back to a flusher that crashed before acknowledging", async () => {
      const crashed = buffer();
      await crashed.push(row("event-1"));
      await crashed.push(row("event-2"));
      await crashed.drain(10);

      /* A new process starting up finds the abandoned batch. */
      const restarted = buffer();
      const recovered = await restarted.drain(10);

      expect(recovered.rows.map((r) => r.eventId)).toEqual(["event-1", "event-2"]);
    });

    it("does not mix newer rows into a batch it is re-handing out", async () => {
      const subject = buffer();
      await subject.push(row("event-1"));
      await subject.drain(10);
      await subject.push(row("event-2"));

      const retried = await subject.drain(10);

      /* Identical rows are what make the retry deduplicable at ClickHouse. Adding
         event-2 would change the batch token and defeat the whole mechanism. */
      expect(retried.rows.map((r) => r.eventId)).toEqual(["event-1"]);
    });

    it("releases the newer rows once the stuck batch is acknowledged", async () => {
      const subject = buffer();
      await subject.push(row("event-1"));
      await subject.drain(10);
      await subject.push(row("event-2"));

      await subject.ack();
      const next = await subject.drain(10);

      expect(next.rows.map((r) => r.eventId)).toEqual(["event-2"]);
    });

    it("is empty after an acknowledgement", async () => {
      const subject = buffer();
      await subject.push(row("event-1"));
      await subject.drain(10);

      await subject.ack();

      await expect(redis.llen(clickKeys(prefix).inflight)).resolves.toBe(0);
    });
  });

  describe("backpressure", () => {
    it("refuses a push past the cap", async () => {
      const subject = buffer(2);

      await expect(subject.push(row("event-1"))).resolves.toBe("buffered");
      await expect(subject.push(row("event-2"))).resolves.toBe("buffered");
      await expect(subject.push(row("event-3"))).resolves.toBe("dropped");
    });

    it("counts what it dropped", async () => {
      const subject = buffer(1);
      await subject.push(row("event-1"));

      await subject.push(row("event-2"));
      await subject.push(row("event-3"));

      await expect(subject.droppedTotal()).resolves.toBe(2);
    });

    it("does not overshoot the cap under concurrent pushes", async () => {
      const subject = buffer(10);

      /* The reason the check and the push are one Lua script: issued separately,
         each of these 50 would read a length below the cap before any of them
         wrote, and the buffer would end up at 50. */
      await Promise.all(
        Array.from({ length: 50 }, (_unused, i) => subject.push(row(`event-${String(i)}`))),
      );

      await expect(subject.depth()).resolves.toBe(10);
      await expect(subject.droppedTotal()).resolves.toBe(40);
    });

    it("accepts pushes again once the buffer drains", async () => {
      const subject = buffer(1);
      await subject.push(row("event-1"));
      await expect(subject.push(row("event-2"))).resolves.toBe("dropped");

      await subject.drain(10);
      await subject.ack();

      await expect(subject.push(row("event-3"))).resolves.toBe("buffered");
    });
  });

  describe("corrupt entries", () => {
    it("discards an unparseable row instead of failing the whole batch", async () => {
      const discarded: string[] = [];
      const subject = new RedisClickBuffer({
        redis,
        maxLength: 100,
        keyPrefix: prefix,
        onCorruptRow: (raw) => discarded.push(raw),
      });
      await subject.push(row("event-1"));
      await redis.rpush(clickKeys(prefix).buffer, "}{ not json");
      await subject.push(row("event-2"));

      const batch = await subject.drain(10);

      expect(batch.rows.map((r) => r.eventId)).toEqual(["event-1", "event-2"]);
      expect(batch.discarded).toBe(1);
      expect(discarded).toHaveLength(1);
    });

    it("discards a row that parses but no longer matches the schema", async () => {
      const subject = buffer();
      await redis.rpush(clickKeys(prefix).buffer, JSON.stringify({ slug: "abc1234" }));

      const batch = await subject.drain(10);

      /* A payload written by an older deploy. It has to leave, or every flush from
         here on fails on it and the queue grows behind it forever. */
      expect(batch.rows).toHaveLength(0);
      expect(batch.discarded).toBe(1);
    });
  });

  it("handles a batch larger than Lua's stack limit", async () => {
    const subject = buffer(20_000);
    const pipeline = redis.pipeline();
    for (let i = 0; i < 10_000; i += 1) {
      pipeline.rpush(clickKeys(prefix).buffer, JSON.stringify(row(`event-${String(i)}`)));
    }
    await pipeline.exec();

    const batch = await subject.drain(10_000);

    /* `RPUSH key, unpack(batch)` would blow up around here. The drain script
       pushes one element at a time for exactly this reason. */
    expect(batch.rows).toHaveLength(10_000);
    await expect(subject.depth()).resolves.toBe(0);
  });
});
