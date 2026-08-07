/**
 * Tests the *wiring*, not the parts.
 *
 * `ClickFlusher` and `RedisClickBuffer` have their own tests. What is only
 * expressible here is the assembly: that a shutdown hook is registered at all,
 * that it drains before it closes the ClickHouse client, and that the flusher does
 * not start in a process that is not supposed to own it. Every one of those is a
 * one-line mistake that no unit test would notice and that would cost a deploy's
 * worth of buffered clicks.
 */

import { describe, expect, it, vi, type Mock } from "vitest";

import { loadConfig, type Config } from "../config.js";
import type { FlusherLogger } from "../consumer/flusher.js";
import type { ClickRow } from "./click-row.js";
import type { ClickInserter } from "../repositories/clickhouse.js";
import { InMemoryClickBuffer } from "../repositories/in-memory-click-buffer.js";
import { buildClickPipeline, type PipelineHost } from "./pipeline.js";

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

/** Records the order operations happened in — the thing this file is really about. */
class OrderedInserter implements ClickInserter {
  public readonly events: string[] = [];
  public readonly rows: ClickRow[] = [];

  public insert(rows: readonly ClickRow[]): Promise<void> {
    this.events.push("insert");
    this.rows.push(...rows);
    return Promise.resolve();
  }

  public isReachable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public close(): Promise<void> {
    this.events.push("close");
    return Promise.resolve();
  }
}

interface TestHost extends PipelineHost {
  shutdown(): Promise<void>;
  hookCount(): number;
  /* Held directly rather than read back off `log`: `unbound-method` rightly
     objects to pulling a method away from its receiver, mock or not. */
  warnings: Mock;
}

function host(): TestHost {
  const hooks: (() => Promise<void>)[] = [];
  const warnings = vi.fn();
  const log: FlusherLogger = { info: vi.fn(), warn: warnings, error: vi.fn() };

  return {
    log,
    warnings,
    onShutdown: (hook) => hooks.push(hook),
    shutdown: async () => {
      for (const hook of hooks) {
        await hook();
      }
    },
    hookCount: () => hooks.length,
  };
}

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    VISITOR_HASH_SALT: "a-test-seed-of-at-least-16-chars",
    ...overrides,
  });
}

describe("buildClickPipeline", () => {
  it("does not start a flusher unless this process owns it", () => {
    const pipeline = buildClickPipeline(host(), config({ CLICK_CONSUMER_ENABLED: "false" }), {
      buffer: new InMemoryClickBuffer(),
    });

    /* Off by default: two flushers against one buffer is silent data loss, so the
       API's replicas must not each start one. */
    expect(pipeline.flusher).toBeUndefined();
  });

  it("starts a flusher when this process does own it", () => {
    const pipeline = buildClickPipeline(host(), config({ CLICK_CONSUMER_ENABLED: "true" }), {
      buffer: new InMemoryClickBuffer(),
      inserter: new OrderedInserter(),
    });

    expect(pipeline.flusher).toBeDefined();
  });

  it("registers a shutdown hook", () => {
    const testHost = host();

    buildClickPipeline(testHost, config(), { buffer: new InMemoryClickBuffer() });

    expect(testHost.hookCount()).toBe(1);
  });

  it("drains the buffer on shutdown", async () => {
    const testHost = host();
    const buffer = new InMemoryClickBuffer();
    const inserter = new OrderedInserter();
    buildClickPipeline(testHost, config({ CLICK_CONSUMER_ENABLED: "true" }), { buffer, inserter });
    await buffer.push(row("a"));
    await buffer.push(row("b"));

    await testHost.shutdown();

    /* Without this, every deploy strands whatever was buffered until some later
       process happens to start and its timer fires. */
    expect(inserter.rows.map((r) => r.eventId)).toEqual(["a", "b"]);
    await expect(buffer.depth()).resolves.toBe(0);
  });

  it("drains before it closes the ClickHouse client", async () => {
    const testHost = host();
    const buffer = new InMemoryClickBuffer();
    const inserter = new OrderedInserter();
    buildClickPipeline(testHost, config({ CLICK_CONSUMER_ENABLED: "true" }), { buffer, inserter });
    await buffer.push(row("a"));

    await testHost.shutdown();

    /* Order, not just presence: closing first would make the final flush fail and
       the rows would sit in Redis with nothing to say why. */
    expect(inserter.events).toEqual(["insert", "close"]);
  });

  it("shuts down cleanly when there is nothing buffered", async () => {
    const testHost = host();
    buildClickPipeline(testHost, config({ CLICK_CONSUMER_ENABLED: "true" }), {
      buffer: new InMemoryClickBuffer(),
      inserter: new OrderedInserter(),
    });

    await expect(testHost.shutdown()).resolves.toBeUndefined();
  });

  it("warns rather than failing when no visitor salt is configured", () => {
    const testHost = host();

    buildClickPipeline(testHost, loadConfig({ NODE_ENV: "test" }), {
      buffer: new InMemoryClickBuffer(),
    });

    /* Local development must work without a secret; the config schema is what
       makes it mandatory in production. A silent fallback is the bad outcome. */
    expect(testHost.warnings).toHaveBeenCalledWith(
      {},
      expect.stringContaining("VISITOR_HASH_SALT"),
    );
  });
});
