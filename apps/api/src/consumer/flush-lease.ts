/**
 * The single-flusher lease.
 *
 * The buffer's in-flight list is one shared key, so two flushers draining at once
 * would interleave into it and the first `ack()` would delete rows the other had
 * claimed but not yet inserted. That is silent data loss, and it appears only under
 * a configuration nobody tests — a second API replica with the consumer flag left
 * on.
 *
 * So the constraint is enforced rather than documented: a flusher holds a Redis
 * lease while it works, and one that cannot take the lease does nothing and says
 * so. The lease is time-bounded, not permanent, so a flusher that dies does not
 * take the pipeline down with it — the next one takes over when the lease lapses.
 */

import type { Redis } from "ioredis";

export const DEFAULT_LEASE_KEY = "urlgen:clicks:flusher";

/**
 * Takes the lease if it is free, extends it if we already hold it.
 *
 * The owner check makes extension safe: a plain `SET ... PX` would let a flusher
 * that had already lost the lease (a long GC pause, a network partition) quietly
 * take it back from whoever picked it up in the meantime.
 */
const ACQUIRE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return 1
end
return 0
`;

/** Releases only our own lease — never one that has already lapsed to someone else. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** What the flusher needs to know: may I run? */
export interface FlushLease {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** A lease that is always granted — for tests and single-process local runs. */
export class AlwaysGrantedLease implements FlushLease {
  public acquire(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public release(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RedisFlushLeaseOptions {
  redis: Redis;
  /** Unique per flusher process. Two processes sharing an id defeats the lease. */
  ownerId: string;
  /**
   * How long the lease survives without renewal.
   *
   * Comfortably longer than a flush cycle: if it can lapse mid-batch, a second
   * flusher takes over while the first is still inserting, which is the exact
   * situation the lease exists to prevent.
   */
  ttlMs: number;
  /** Defaults to `urlgen:clicks:flusher`. Must match the buffer's namespace. */
  key?: string | undefined;
}

export class RedisFlushLease implements FlushLease {
  readonly #redis: Redis;
  readonly #ownerId: string;
  readonly #ttlMs: number;
  readonly #key: string;

  public constructor(options: RedisFlushLeaseOptions) {
    this.#redis = options.redis;
    this.#ownerId = options.ownerId;
    this.#ttlMs = options.ttlMs;
    this.#key = options.key ?? DEFAULT_LEASE_KEY;
  }

  public async acquire(): Promise<boolean> {
    const held = await this.#redis.eval(
      ACQUIRE_SCRIPT,
      1,
      this.#key,
      this.#ownerId,
      String(this.#ttlMs),
    );
    return held === 1;
  }

  public async release(): Promise<void> {
    await this.#redis.eval(RELEASE_SCRIPT, 1, this.#key, this.#ownerId);
  }
}
