import { describe, expect, it, vi, type Mock } from "vitest";

import type { ClickRow } from "../analytics/click-row.js";
import { clickBatchToken, type ClickInserter } from "../repositories/clickhouse.js";
import { InMemoryClickBuffer } from "../repositories/in-memory-click-buffer.js";
import { ClickFlusher, type FlusherLogger } from "./flusher.js";
import type { FlushLease } from "./flush-lease.js";

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

/**
 * A logger plus direct handles on its mocks.
 *
 * The handles exist so assertions never reference `logger.error` off the object —
 * `@typescript-eslint/unbound-method` rightly objects to pulling a method away
 * from its receiver, even when the receiver is a mock that does not use `this`.
 */
function silentLogger(): { logger: FlusherLogger; errors: Mock; warns: Mock } {
  const errors = vi.fn();
  const warns = vi.fn();
  return { logger: { info: vi.fn(), warn: warns, error: errors }, errors, warns };
}

/** Records what it was asked to insert. Fails on demand. */
class RecordingInserter implements ClickInserter {
  public readonly batches: { rows: readonly ClickRow[]; token: string }[] = [];
  public failNext = 0;

  public insert(rows: readonly ClickRow[], token: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error("clickhouse unavailable"));
    }
    this.batches.push({ rows: [...rows], token });
    return Promise.resolve();
  }

  public isReachable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  public get insertedIds(): string[] {
    return this.batches.flatMap((batch) => batch.rows.map((r) => r.eventId));
  }
}

interface Harness {
  buffer: InMemoryClickBuffer;
  inserter: RecordingInserter;
  flusher: ClickFlusher;
  errors: Mock;
}

function harness(options: { batchSize?: number; lease?: FlushLease } = {}): Harness {
  const buffer = new InMemoryClickBuffer();
  const inserter = new RecordingInserter();
  const { logger, errors } = silentLogger();
  const flusher = new ClickFlusher({
    buffer,
    inserter,
    logger,
    batchSize: options.batchSize ?? 3,
    intervalMs: 60_000,
    ...(options.lease !== undefined ? { lease: options.lease } : {}),
  });

  return { buffer, inserter, flusher, errors };
}

async function fill(buffer: InMemoryClickBuffer, count: number, offset = 0): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await buffer.push(row(`event-${String(offset + i)}`));
  }
}

describe("ClickFlusher", () => {
  it("does nothing when the buffer is empty", async () => {
    const { flusher, inserter } = harness();

    const result = await flusher.flush();

    expect(result).toEqual({ inserted: 0, discarded: 0 });
    expect(inserter.batches).toHaveLength(0);
  });

  it("inserts a partial batch rather than waiting for it to fill", async () => {
    const { buffer, flusher, inserter } = harness({ batchSize: 100 });
    await fill(buffer, 2);

    const result = await flusher.flush();

    /* The time trigger is the whole reason a quiet link's clicks reach the
       dashboard in seconds instead of whenever 98 more arrive. */
    expect(result.inserted).toBe(2);
    expect(inserter.batches).toHaveLength(1);
  });

  it("splits a deep buffer into batch-sized inserts", async () => {
    const { buffer, flusher, inserter } = harness({ batchSize: 3 });
    await fill(buffer, 7);

    const result = await flusher.flush();

    expect(result.inserted).toBe(7);
    expect(inserter.batches.map((batch) => batch.rows.length)).toEqual([3, 3, 1]);
  });

  it("empties the buffer it drained", async () => {
    const { buffer, flusher } = harness();
    await fill(buffer, 5);

    await flusher.flush();

    await expect(buffer.depth()).resolves.toBe(0);
    expect(buffer.inflight).toHaveLength(0);
  });

  it("stops at the batch limit rather than looping on a huge backlog", async () => {
    const { buffer, flusher } = harness({ batchSize: 1 });
    await fill(buffer, 25);

    const result = await flusher.flush();

    /* A process that looks hung while it catches up is worse than one that takes
       two cycles. */
    expect(result.stoppedBecause).toBe("batch-limit");
    expect(result.inserted).toBe(20);
    await expect(buffer.depth()).resolves.toBe(5);
  });

  describe("when ClickHouse fails", () => {
    it("leaves the batch claimed instead of acknowledging it", async () => {
      const { buffer, flusher, inserter } = harness();
      await fill(buffer, 3);
      inserter.failNext = 1;

      const result = await flusher.flush();

      expect(result).toMatchObject({ inserted: 0, stoppedBecause: "insert-failed" });
      /* The rows must still exist somewhere. Acknowledging an unconfirmed insert
         is the one bug in this pipeline that loses data silently. */
      expect(buffer.inflight).toHaveLength(3);
    });

    it("retries exactly the same rows on the next cycle", async () => {
      const { buffer, flusher, inserter } = harness();
      await fill(buffer, 3);
      inserter.failNext = 1;

      await flusher.flush();
      const result = await flusher.flush();

      expect(result.inserted).toBe(3);
      expect(inserter.insertedIds).toEqual(["event-0", "event-1", "event-2"]);
    });

    it("retries with an identical token, so a landed insert is deduplicated", async () => {
      const { buffer, flusher, inserter } = harness();
      await fill(buffer, 3);
      const expected = clickBatchToken([row("event-0"), row("event-1"), row("event-2")]);
      inserter.failNext = 1;

      await flusher.flush();
      await flusher.flush();

      /* The failure mode this covers: ClickHouse accepted the write and the
         *response* was lost. The retry is a byte-identical block under the same
         token, so the server drops it instead of double-counting. */
      expect(inserter.batches[0]?.token).toBe(expected);
    });

    it("does not lose rows that arrived while the batch was stuck", async () => {
      const { buffer, flusher, inserter } = harness({ batchSize: 3 });
      await fill(buffer, 3);
      inserter.failNext = 1;

      await flusher.flush();
      await fill(buffer, 2, 100);
      await flusher.flush();

      expect(inserter.insertedIds).toEqual([
        "event-0",
        "event-1",
        "event-2",
        "event-100",
        "event-101",
      ]);
    });

    it("logs the failure without swallowing it into silence", async () => {
      const { buffer, flusher, inserter, errors } = harness();
      await fill(buffer, 1);
      inserter.failNext = 1;

      await flusher.flush();

      expect(errors).toHaveBeenCalledTimes(1);
    });
  });

  describe("the lease", () => {
    it("does not drain when another process holds it", async () => {
      const denied: FlushLease = {
        acquire: () => Promise.resolve(false),
        release: () => Promise.resolve(),
      };
      const { buffer, flusher, inserter } = harness({ lease: denied });
      await fill(buffer, 3);

      const result = await flusher.flush();

      expect(result.stoppedBecause).toBe("no-lease");
      expect(inserter.batches).toHaveLength(0);
      /* Untouched, so whoever does hold the lease flushes them. */
      await expect(buffer.depth()).resolves.toBe(3);
    });
  });

  describe("shutdown", () => {
    it("drains what is left before the process exits", async () => {
      const { buffer, flusher, inserter } = harness();
      flusher.start();
      await fill(buffer, 2);

      await flusher.stop();

      /* Without this, a deploy strands every buffered click until some later
         process happens to start. */
      expect(inserter.insertedIds).toEqual(["event-0", "event-1"]);
    });

    it("releases the lease so the next process can take over immediately", async () => {
      const release = vi.fn(() => Promise.resolve());
      const lease: FlushLease = { acquire: () => Promise.resolve(true), release };
      const { flusher } = harness({ lease });

      await flusher.stop();

      expect(release).toHaveBeenCalledTimes(1);
    });

    it("survives a final flush that fails", async () => {
      const { buffer, flusher, inserter, errors } = harness();
      await fill(buffer, 1);
      inserter.failNext = 1;

      await expect(flusher.stop()).resolves.toBeUndefined();

      expect(errors).toHaveBeenCalled();
      expect(buffer.inflight).toHaveLength(1);
    });
  });

  describe("unparseable rows", () => {
    it("acknowledges a batch of nothing but bad rows instead of starving behind it", async () => {
      /* One payload from an older deploy would otherwise be claimed forever and
         every click behind it would never be inserted. */
      const buffer = new InMemoryClickBuffer();
      const inserter = new RecordingInserter();
      let drained = false;
      const poisoned = {
        push: buffer.push.bind(buffer),
        depth: buffer.depth.bind(buffer),
        droppedTotal: buffer.droppedTotal.bind(buffer),
        ack: vi.fn(() => Promise.resolve()),
        drain: vi.fn(() => {
          if (drained) {
            return Promise.resolve({ rows: [], discarded: 0 });
          }
          drained = true;
          return Promise.resolve({ rows: [], discarded: 2 });
        }),
      };

      const flusher = new ClickFlusher({
        buffer: poisoned,
        inserter,
        logger: silentLogger().logger,
        batchSize: 3,
        intervalMs: 60_000,
      });

      const result = await flusher.flush();

      expect(result.discarded).toBe(2);
      expect(poisoned.ack).toHaveBeenCalledTimes(1);
    });
  });

  describe("the timer", () => {
    it("flushes on the interval", async () => {
      vi.useFakeTimers();
      try {
        const { buffer, flusher, inserter } = harness();
        await fill(buffer, 2);
        flusher.start();

        await vi.advanceTimersByTimeAsync(60_000);

        expect(inserter.insertedIds).toEqual(["event-0", "event-1"]);
        await flusher.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not start a second drain while one is still running", async () => {
      vi.useFakeTimers();
      try {
        const buffer = new InMemoryClickBuffer();
        let release: (() => void) | undefined;
        const inserter: ClickInserter = {
          insert: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
          isReachable: () => Promise.resolve(true),
          close: () => Promise.resolve(),
        };
        const drain = vi.spyOn(buffer, "drain");

        const flusher = new ClickFlusher({
          buffer,
          inserter,
          logger: silentLogger().logger,
          batchSize: 3,
          intervalMs: 1000,
        });
        await fill(buffer, 3);
        flusher.start();

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);

        /* Two concurrent drains in one process defeat the in-flight list exactly
           as two processes would. */
        expect(drain).toHaveBeenCalledTimes(1);

        release?.();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
