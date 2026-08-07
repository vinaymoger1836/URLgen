/**
 * Redis buffer -> ClickHouse.
 *
 * The only component in the click pipeline that is allowed to be slow, because
 * nothing is waiting on it: the visitor got their 302 long ago and the ingest
 * endpoint answered the moment the row hit Redis.
 *
 * ## Two triggers, for two different problems
 *
 * A **size** trigger keeps inserts big under load, which is what ClickHouse wants.
 * A **time** trigger keeps latency bounded when traffic is thin, which is what a
 * dashboard wants — without it, one click on a quiet link would sit in Redis until
 * 999 more arrived to fill the batch.
 *
 * ## Failure is a no-op, not a loss
 *
 * If the insert fails, the batch is simply not acknowledged. It stays in the
 * in-flight list and the next cycle claims the same rows again. Nothing is retried
 * from memory, so a crash mid-retry changes nothing. The one thing this must never
 * do is `ack()` a batch ClickHouse did not confirm.
 */

import { clickBatchToken, type ClickInserter } from "../repositories/clickhouse.js";
import type { ClickBuffer } from "../repositories/click-buffer.js";
import { AlwaysGrantedLease, type FlushLease } from "./flush-lease.js";

/**
 * Cap on batches per cycle.
 *
 * A deep backlog is drained aggressively, but not without end: an unbounded loop
 * would hold the lease and the event loop for as long as the backlog lasted, and
 * the process would look hung while it caught up.
 */
const MAX_BATCHES_PER_CYCLE = 20;

export interface FlushResult {
  /** Rows ClickHouse confirmed. */
  inserted: number;
  /** Rows dropped because they no longer parse. Should always be zero. */
  discarded: number;
  /** Set when the cycle ended early — the reason is worth logging. */
  stoppedBecause?: "insert-failed" | "no-lease" | "batch-limit";
}

/** The subset of a logger this needs. Fastify's `app.log` satisfies it. */
export interface FlusherLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface ClickFlusherOptions {
  buffer: ClickBuffer;
  inserter: ClickInserter;
  logger: FlusherLogger;
  /** Rows per ClickHouse insert. */
  batchSize: number;
  /** How often to flush when the batch never fills. */
  intervalMs: number;
  /** Defaults to always-granted, which is correct only for a single process. */
  lease?: FlushLease | undefined;
}

export class ClickFlusher {
  readonly #buffer: ClickBuffer;
  readonly #inserter: ClickInserter;
  readonly #logger: FlusherLogger;
  readonly #batchSize: number;
  readonly #intervalMs: number;
  readonly #lease: FlushLease;

  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;

  public constructor(options: ClickFlusherOptions) {
    this.#buffer = options.buffer;
    this.#inserter = options.inserter;
    this.#logger = options.logger;
    this.#batchSize = options.batchSize;
    this.#intervalMs = options.intervalMs;
    this.#lease = options.lease ?? new AlwaysGrantedLease();
  }

  /** Begins flushing on the interval. Safe to call once. */
  public start(): void {
    if (this.#timer !== undefined) {
      return;
    }

    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#intervalMs);

    /* Do not hold the process open just to run the flush timer — a container that
       will not exit on SIGTERM is a deploy that hangs. */
    this.#timer.unref();

    this.#logger.info(
      { batchSize: this.#batchSize, intervalMs: this.#intervalMs },
      "click flusher started",
    );
  }

  /**
   * Stops the timer, drains what is left, and gives up the lease.
   *
   * The final flush is the difference between a clean deploy and a few thousand
   * clicks sitting in Redis until the next process happens to start.
   */
  public async stop(): Promise<void> {
    this.#stopped = true;

    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    try {
      await this.flush();
    } catch (error) {
      this.#logger.error({ err: error }, "final click flush failed — rows remain buffered");
    }

    try {
      await this.#lease.release();
    } catch (error) {
      this.#logger.warn({ err: error }, "could not release the flush lease — it will lapse");
    }
  }

  /**
   * Drains the buffer until it is empty or the batch limit is reached.
   *
   * Public so tests (and the shutdown path) can flush deterministically instead of
   * waiting on a timer.
   */
  public async flush(): Promise<FlushResult> {
    if (!(await this.#lease.acquire())) {
      /* Another process holds the lease. This is normal in a multi-replica deploy
         and a misconfiguration in a single one, so it is a warning either way. */
      return { inserted: 0, discarded: 0, stoppedBecause: "no-lease" };
    }

    let inserted = 0;
    let discarded = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch += 1) {
      const claimed = await this.#buffer.drain(this.#batchSize);
      discarded += claimed.discarded;

      if (claimed.rows.length === 0) {
        if (claimed.discarded > 0) {
          /* The batch was entirely unparseable rows. Acknowledge it anyway, or it
             is claimed again forever and everything behind it starves. */
          await this.#buffer.ack();
          continue;
        }
        return { inserted, discarded };
      }

      try {
        await this.#inserter.insert(claimed.rows, clickBatchToken(claimed.rows));
      } catch (error) {
        /* Deliberately no `ack()`. The rows stay in the in-flight list and the
           next cycle claims exactly these rows again, producing an identical
           block that ClickHouse will deduplicate if this insert did in fact land. */
        this.#logger.error(
          { err: error, rows: claimed.rows.length },
          "clickhouse insert failed — batch stays buffered and will be retried",
        );
        return { inserted, discarded, stoppedBecause: "insert-failed" };
      }

      await this.#buffer.ack();
      inserted += claimed.rows.length;

      if (claimed.rows.length < this.#batchSize) {
        return { inserted, discarded };
      }
    }

    return { inserted, discarded, stoppedBecause: "batch-limit" };
  }

  /** One timer cycle, with overlap protection and no unhandled rejections. */
  async #tick(): Promise<void> {
    if (this.#running || this.#stopped) {
      /* A cycle that outran the interval must not start a second drain — two
         concurrent drains in one process defeat the in-flight list exactly as two
         processes would. */
      return;
    }

    this.#running = true;
    try {
      const result = await this.flush();

      if (result.stoppedBecause === "no-lease") {
        this.#logger.warn({}, "another process holds the click flush lease — not flushing");
      } else if (result.inserted > 0 || result.discarded > 0) {
        this.#logger.info(
          { inserted: result.inserted, discarded: result.discarded },
          "flushed clicks to clickhouse",
        );
      }
    } catch (error) {
      /* Anything reaching here is Redis being unavailable. Swallowed on purpose:
         an unhandled rejection in a timer takes the whole API down with it, and the
         API still has redirects to resolve. */
      this.#logger.error({ err: error }, "click flush cycle failed");
    } finally {
      this.#running = false;
    }
  }
}
