/**
 * Pins the fake's semantics to the real buffer's.
 *
 * The corresponding assertions in `click-buffer-integration.test.ts` run against
 * Redis. These three behaviours are the ones the flusher's correctness rests on,
 * and a fake that quietly got any of them more convenient than the real thing
 * would make every flusher test pass while the pipeline lost data — which is
 * exactly how the Phase 1 GSI projection bug survived a full green suite.
 */

import { describe, expect, it } from "vitest";

import type { ClickRow } from "../analytics/click-row.js";
import { InMemoryClickBuffer } from "./in-memory-click-buffer.js";

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

describe("InMemoryClickBuffer", () => {
  it("drops past the cap and counts it, rather than growing", async () => {
    const buffer = new InMemoryClickBuffer(2);

    await expect(buffer.push(row("a"))).resolves.toBe("buffered");
    await expect(buffer.push(row("b"))).resolves.toBe("buffered");
    await expect(buffer.push(row("c"))).resolves.toBe("dropped");
    await expect(buffer.droppedTotal()).resolves.toBe(1);
  });

  it("moves a claimed batch to in-flight instead of deleting it", async () => {
    const buffer = new InMemoryClickBuffer();
    await buffer.push(row("a"));

    await buffer.drain(10);

    await expect(buffer.depth()).resolves.toBe(0);
    expect(buffer.inflight.map((r) => r.eventId)).toEqual(["a"]);
  });

  it("re-hands the same batch until it is acknowledged", async () => {
    const buffer = new InMemoryClickBuffer();
    await buffer.push(row("a"));
    await buffer.drain(10);
    await buffer.push(row("b"));

    const retried = await buffer.drain(10);

    /* Identical rows in identical order is what makes the retry deduplicable at
       ClickHouse. Mixing in "b" would change the batch token. */
    expect(retried.rows.map((r) => r.eventId)).toEqual(["a"]);
  });

  it("releases the newer rows once the batch is acknowledged", async () => {
    const buffer = new InMemoryClickBuffer();
    await buffer.push(row("a"));
    await buffer.drain(10);
    await buffer.push(row("b"));

    await buffer.ack();

    expect((await buffer.drain(10)).rows.map((r) => r.eventId)).toEqual(["b"]);
  });

  it("claims at most the requested number, in arrival order", async () => {
    const buffer = new InMemoryClickBuffer();
    for (const id of ["a", "b", "c"]) {
      await buffer.push(row(id));
    }

    const batch = await buffer.drain(2);

    expect(batch.rows.map((r) => r.eventId)).toEqual(["a", "b"]);
    await expect(buffer.depth()).resolves.toBe(1);
  });
});
