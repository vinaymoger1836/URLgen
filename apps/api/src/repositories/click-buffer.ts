/**
 * The durable click buffer.
 *
 * Sits between the ingest endpoint (which must return instantly) and ClickHouse
 * (which wants inserts in the thousands, not one row at a time). Redis is the
 * right tool for exactly this shape: an append-heavy list with cheap atomic
 * multi-item moves, and durability good enough that losing the last second of
 * clicks in a crash costs a few rows in a chart.
 *
 * ## The reliable-queue pattern
 *
 * A naive `LPOP count` is fast and wrong: the moment the rows leave Redis they
 * exist only in the flusher's memory, and a crash between there and a successful
 * `INSERT` loses them silently. So a drain *moves* rows to an in-flight list
 * instead of deleting them, and only `ack()` — after ClickHouse has confirmed the
 * write — removes them.
 *
 * That trades "lost on crash" for "possibly inserted twice on crash", which is the
 * better failure to have because it is the one that can be fixed downstream:
 * recovery re-drains the *identical* in-flight batch, which produces an identical
 * insert block, which ClickHouse deduplicates by token. See `clickhouse.ts`.
 *
 * ## Backpressure
 *
 * The list is capped. Past the cap, clicks are dropped and counted rather than
 * queued, because the alternative is Redis growing until the OOM killer takes the
 * whole origin down — and then the redirects stop too. Losing analytics is
 * survivable; losing the redirect path is not.
 *
 * ## One flusher
 *
 * The in-flight list is a single shared key, so exactly one process may drain at a
 * time. That is not left to documentation — `flusher.ts` holds a Redis lease and
 * refuses to run without it.
 */

import { Redis, type Result } from "ioredis";

import { clickRowSchema, type ClickRow } from "../analytics/click-row.js";

const KEY_PREFIX = "urlgen:clicks";

export const BUFFER_KEY = `${KEY_PREFIX}:buffer`;
export const INFLIGHT_KEY = `${KEY_PREFIX}:inflight`;
export const DROPPED_KEY = `${KEY_PREFIX}:dropped`;

/**
 * Appends one click unless the buffer is already full.
 *
 * `LLEN` and `RPUSH` have to be one atomic step: checked separately, a burst of
 * concurrent ingests would each see room and each push, overshooting the cap by
 * however many requests were in flight.
 */
const PUSH_SCRIPT = `
local length = redis.call('LLEN', KEYS[1])
if length >= tonumber(ARGV[2]) then
  redis.call('INCR', KEYS[2])
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return 1
`;

/**
 * Moves up to N rows from the buffer to the in-flight list and returns them.
 *
 * In-flight wins: if anything is already there, a previous flush did not finish
 * and that batch is returned again unchanged, rather than mixing it with newer
 * rows. Returning the *same* batch is what makes the retry deduplicable.
 *
 * `RPUSH` runs one element at a time rather than via `unpack(batch)`, which blows
 * Lua's stack once a batch gets large. The loop is a few thousand calls inside a
 * single atomic script — still one round trip.
 */
const DRAIN_SCRIPT = `
local pending = redis.call('LRANGE', KEYS[2], 0, -1)
if #pending > 0 then
  return pending
end
local batch = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
if #batch == 0 then
  return batch
end
redis.call('LTRIM', KEYS[1], #batch, -1)
for i = 1, #batch do
  redis.call('RPUSH', KEYS[2], batch[i])
end
return batch
`;

/** Registers the Lua scripts on a connection as typed commands. */
declare module "ioredis" {
  interface RedisCommander<Context> {
    clickPush(
      bufferKey: string,
      droppedKey: string,
      payload: string,
      max: string,
    ): Result<number, Context>;
    clickDrain(bufferKey: string, inflightKey: string, max: string): Result<string[], Context>;
  }
}

export type PushOutcome = "buffered" | "dropped";

/** A batch handed to the flusher, together with what it takes to acknowledge it. */
export interface ClickBatch {
  rows: ClickRow[];
  /** Rows that could not be parsed and will be discarded on `ack`. */
  discarded: number;
}

/** What the ingest route and the flusher need. Narrow enough to fake in a test. */
export interface ClickBuffer {
  push(row: ClickRow): Promise<PushOutcome>;
  drain(max: number): Promise<ClickBatch>;
  ack(): Promise<void>;
  depth(): Promise<number>;
  droppedTotal(): Promise<number>;
}

export interface RedisClickBufferOptions {
  redis: Redis;
  /** Hard ceiling on buffered rows. Past it, clicks are dropped and counted. */
  maxLength: number;
  /** Called for every unparseable buffered row, so corruption is never silent. */
  onCorruptRow?: ((raw: string) => void) | undefined;
}

/** The Redis-backed buffer. */
export class RedisClickBuffer implements ClickBuffer {
  readonly #redis: Redis;
  readonly #maxLength: number;
  readonly #onCorruptRow: ((raw: string) => void) | undefined;

  public constructor(options: RedisClickBufferOptions) {
    this.#redis = options.redis;
    this.#maxLength = options.maxLength;
    this.#onCorruptRow = options.onCorruptRow;
  }

  /** Appends a click, or reports that the buffer is full. Never blocks the caller. */
  public async push(row: ClickRow): Promise<PushOutcome> {
    const accepted = await this.#redis.clickPush(
      BUFFER_KEY,
      DROPPED_KEY,
      JSON.stringify(row),
      String(this.#maxLength),
    );
    return accepted === 1 ? "buffered" : "dropped";
  }

  /**
   * Claims up to `max` rows, leaving them recoverable until `ack()`.
   *
   * A row that no longer parses is counted and dropped rather than allowed to
   * poison the batch forever: one bad payload from an older deploy would otherwise
   * fail every flush from here on, and the queue would grow without bound behind
   * it. The batch is still acknowledged as a whole, so the bad row does leave.
   */
  public async drain(max: number): Promise<ClickBatch> {
    const raw = await this.#redis.clickDrain(BUFFER_KEY, INFLIGHT_KEY, String(max));

    const rows: ClickRow[] = [];
    let discarded = 0;

    for (const entry of raw) {
      const parsed = parseRow(entry);
      if (parsed === undefined) {
        discarded += 1;
        this.#onCorruptRow?.(entry);
        continue;
      }
      rows.push(parsed);
    }

    return { rows, discarded };
  }

  /**
   * Discards the in-flight batch after ClickHouse has confirmed it.
   *
   * Called only on success. On failure the batch is deliberately left in place so
   * the next cycle picks up the same rows.
   */
  public async ack(): Promise<void> {
    await this.#redis.del(INFLIGHT_KEY);
  }

  /** Rows waiting to be claimed. The number to alert on if it keeps climbing. */
  public async depth(): Promise<number> {
    return await this.#redis.llen(BUFFER_KEY);
  }

  /** Rows refused since the counter was last reset. Should be zero. */
  public async droppedTotal(): Promise<number> {
    const value = await this.#redis.get(DROPPED_KEY);
    return value === null ? 0 : Number.parseInt(value, 10);
  }
}

/**
 * Builds a Redis connection with the click scripts attached.
 *
 * `maxRetriesPerRequest: null` because every caller of this connection already has
 * a defined answer for failure — ingest drops the click, the flusher retries the
 * batch next cycle. What must not happen is a command rejecting mid-reconnect and
 * turning a transient blip into lost rows.
 */
export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    /* Fail fast on a dead Redis rather than queueing commands forever: the ingest
       route needs an answer in milliseconds, not whenever Redis comes back. */
    enableOfflineQueue: false,
    connectTimeout: 2000,
    lazyConnect: false,
  });

  redis.defineCommand("clickPush", { numberOfKeys: 2, lua: PUSH_SCRIPT });
  redis.defineCommand("clickDrain", { numberOfKeys: 2, lua: DRAIN_SCRIPT });

  return redis;
}

/** Parses one buffered entry, returning undefined for anything unusable. */
function parseRow(raw: string): ClickRow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = clickRowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
