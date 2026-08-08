/**
 * Assembly for the click pipeline.
 *
 * Kept out of `server.ts` because this is the one subsystem with a lifecycle:
 * a Redis connection, a ClickHouse client and a background flusher that all have
 * to be shut down in order when the process stops. Building it in one place means
 * there is exactly one place where that order is written down.
 *
 * Nothing here connects to anything at construction time. That is what lets the
 * server be built in a test that never sends a click.
 */

import type { Redis } from "ioredis";

import type { Config } from "../config.js";
import { RedisFlushLease, type FlushLease } from "../consumer/flush-lease.js";
import { ClickFlusher, type FlusherLogger } from "../consumer/flusher.js";
import { RedisClickBuffer, createRedis, type ClickBuffer } from "../repositories/click-buffer.js";
import { createClickInserter, type ClickInserter } from "../repositories/clickhouse.js";
import { VisitorHasher } from "../services/visitor-hash.js";

/**
 * What the pipeline needs from whatever is hosting it.
 *
 * Deliberately not a `FastifyInstance`: the standalone consumer (`pnpm consumer`)
 * runs this exact wiring with no HTTP server at all, and the shutdown ordering is
 * far too easy to get subtly wrong to be worth writing twice.
 */
export interface PipelineHost {
  log: FlusherLogger;
  /** Runs on shutdown, in registration order. */
  onShutdown(hook: () => Promise<void>): void;
}

export interface ClickPipeline {
  buffer: ClickBuffer;
  visitorHasher: VisitorHasher;
  /** Present only when this process is the one configured to flush. */
  flusher: ClickFlusher | undefined;
  /**
   * The connection this pipeline opened, for other subsystems to share.
   *
   * `undefined` when the buffer was injected — there is no connection, because
   * opening one nobody asked for would be worse than the caller doing without.
   * The analytics cache is the only other user, and it degrades to a no-op.
   */
  redis: Redis | undefined;
}

/** Injection points for tests. An override replaces both the object and its lifecycle. */
export interface ClickPipelineOverrides {
  buffer?: ClickBuffer | undefined;
  inserter?: ClickInserter | undefined;
  lease?: FlushLease | undefined;
}

/**
 * Wires the pipeline onto a server and registers its shutdown.
 *
 * The flusher starts only when this process is configured to own it. Two flushers
 * against one buffer is silent data loss, so the default is off — and the lease in
 * `flush-lease.ts` catches the case where it gets switched on twice anyway.
 */
export function buildClickPipeline(
  host: PipelineHost,
  config: Config,
  overrides: ClickPipelineOverrides = {},
): ClickPipeline {
  const visitorHasher = new VisitorHasher({
    salt: config.VISITOR_HASH_SALT,
    onMissingSalt: () => {
      host.log.warn(
        {},
        "VISITOR_HASH_SALT is not set — using an ephemeral seed; visitor counts will reset on restart",
      );
    },
  });

  /* An injected buffer means the caller owns the storage. Building the real Redis
     connection anyway would open a socket nobody asked for. */
  const redis = overrides.buffer === undefined ? buildRedis(host, config) : undefined;
  const buffer = overrides.buffer ?? buildBuffer(host, config, redis);
  const inserter = config.CLICK_CONSUMER_ENABLED ? buildInserter(config, overrides) : undefined;
  const flusher =
    inserter === undefined
      ? undefined
      : new ClickFlusher({
          buffer,
          inserter,
          logger: host.log,
          batchSize: config.CLICK_FLUSH_BATCH_SIZE,
          intervalMs: config.CLICK_FLUSH_INTERVAL_MS,
          lease: overrides.lease ?? buildLease(config, redis),
        });

  flusher?.start();

  host.onShutdown(async () => {
    /* Strict order: the flusher's `stop()` performs a final drain, so it has to
       run while Redis and ClickHouse are both still connected. */
    await flusher?.stop();
    await inserter?.close();
    redis?.disconnect();
  });

  return { buffer, visitorHasher, flusher, redis };
}

function buildRedis(host: PipelineHost, config: Config): Redis {
  return createRedis({
    url: config.REDIS_URL,
    onError: (error) => {
      host.log.error({ err: error }, "redis connection error");
    },
  });
}

function buildBuffer(host: PipelineHost, config: Config, redis: Redis | undefined): ClickBuffer {
  if (redis === undefined) {
    throw new Error("buildBuffer requires a redis connection");
  }

  return new RedisClickBuffer({
    redis,
    maxLength: config.CLICK_BUFFER_MAX,
    onCorruptRow: () => {
      /* The row itself is never logged — it carries a visitor hash and a slug, and
         a corrupt payload is exactly the kind of thing that lives in a log
         aggregator forever. The fact that it happened is what matters. */
      host.log.error({}, "discarded an unparseable buffered click");
    },
  });
}

function buildInserter(config: Config, overrides: ClickPipelineOverrides): ClickInserter {
  return (
    overrides.inserter ??
    createClickInserter({
      url: config.CLICKHOUSE_URL,
      username: config.CLICKHOUSE_USER,
      password: config.CLICKHOUSE_PASSWORD,
      database: config.CLICKHOUSE_DATABASE,
    })
  );
}

/**
 * The lease that keeps a second flusher from draining the same buffer.
 *
 * Without a Redis connection there is nothing to coordinate through, which only
 * happens when a test injected its own buffer — so the flusher falls back to its
 * always-granted lease, which is correct for a single in-process consumer.
 */
function buildLease(config: Config, redis: Redis | undefined): FlushLease | undefined {
  if (redis === undefined) {
    return undefined;
  }

  return new RedisFlushLease({
    redis,
    ownerId: `${process.env.HOSTNAME ?? "local"}:${process.pid}`,
    /* Three cycles of slack, floored, so a fast interval cannot produce a lease
       that lapses while a slow ClickHouse insert is still in flight. */
    ttlMs: Math.max(config.CLICK_FLUSH_INTERVAL_MS * 3, 30_000),
  });
}
