import type { KvLinkValue } from "@urlgen/shared";
import { beforeEach, describe, expect, it } from "vitest";

import type { EdgeCache } from "../repositories/edge-cache.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { rescanLinks, type RescanLogger } from "./rescan.js";
import type { SafeBrowsingVerdict, UrlSafetyChecker } from "./safe-browsing.js";

/** Answers whatever it has been told to answer for a given URL. */
class ScriptedChecker implements UrlSafetyChecker {
  public readonly verdicts = new Map<string, SafeBrowsingVerdict>();
  public readonly checked: string[] = [];
  public failOn: string | undefined;

  public check(url: string): Promise<SafeBrowsingVerdict> {
    this.checked.push(url);
    if (url === this.failOn) {
      return Promise.reject(new Error("lookup blew up"));
    }
    return Promise.resolve(this.verdicts.get(url) ?? "safe");
  }
}

class RecordingEdgeCache implements EdgeCache {
  public readonly puts: { slug: string; value: KvLinkValue }[] = [];
  public readonly purges: string[] = [];
  public failure: Error | undefined;

  public put(slug: string, value: KvLinkValue): Promise<void> {
    this.puts.push({ slug, value });
    return this.failure === undefined ? Promise.resolve() : Promise.reject(this.failure);
  }

  public purge(slug: string): Promise<void> {
    this.purges.push(slug);
    return Promise.resolve();
  }
}

class CollectingLogger implements RescanLogger {
  public readonly lines: { level: string; details: Record<string, unknown>; message: string }[] = [];

  public info(details: Record<string, unknown>, message: string): void {
    this.lines.push({ level: "info", details, message });
  }

  public warn(details: Record<string, unknown>, message: string): void {
    this.lines.push({ level: "warn", details, message });
  }

  public error(details: Record<string, unknown>, message: string): void {
    this.lines.push({ level: "error", details, message });
  }
}

const now = new Date("2026-08-09T12:00:00.000Z");

let repository: InMemoryLinkRepository;
let checker: ScriptedChecker;
let edgeCache: RecordingEdgeCache;
let logger: CollectingLogger;

beforeEach(() => {
  repository = new InMemoryLinkRepository();
  checker = new ScriptedChecker();
  edgeCache = new RecordingEdgeCache();
  logger = new CollectingLogger();
});

async function seed(slug: string, targetUrl: string): Promise<void> {
  await repository.create({ targetUrl, ownerId: "alice", urlHash: `hash-${slug}`, customSlug: slug });
}

function run(options: Partial<Parameters<typeof rescanLinks>[0]> = {}) {
  return rescanLinks({
    repository,
    checker,
    edgeCache,
    logger,
    now: () => now,
    ...options,
  });
}

describe("rescanLinks", () => {
  it("disables a link that has gone bad since it was created", async () => {
    await seed("gonebad", "https://was-fine.example/");
    checker.verdicts.set("https://was-fine.example/", "malicious");

    const summary = await run();

    expect(summary.disabled).toBe(1);
    expect((await repository.findBySlug("gonebad"))?.status).toBe("disabled");
  });

  it("overwrites the edge entry with the disabled tombstone", async () => {
    await seed("gonebad", "https://was-fine.example/");
    checker.verdicts.set("https://was-fine.example/", "malicious");

    await run();

    /* Same reasoning as the admin path: the link most worth disabling is the one
       still receiving traffic, so a tombstone answered at the edge beats a purge
       that points all of that traffic at the origin. */
    expect(edgeCache.puts).toEqual([
      { slug: "gonebad", value: { u: "https://was-fine.example/", s: "disabled" } },
    ]);
    expect(edgeCache.purges).toHaveLength(0);
  });

  it("leaves a clean link alone but records that it was checked", async () => {
    await seed("stillfine", "https://fine.example/");

    const summary = await run();

    expect(summary.disabled).toBe(0);
    const record = await repository.findBySlug("stillfine");
    expect(record?.status).toBe("active");
    expect(record?.safeBrowsingVerdict).toBe("safe");
    expect(record?.verdictCheckedAt).toBe(now.toISOString());
  });

  it("never disables on an `unknown` verdict", async () => {
    /* `unknown` is what a timeout, a missing key or an unparseable body produces.
       Acting on it would make Google's availability the reason someone's link
       stopped working — the same fail-open posture as the create path. */
    await seed("unclear", "https://unclear.example/");
    checker.verdicts.set("https://unclear.example/", "unknown");

    const summary = await run();

    expect(summary.disabled).toBe(0);
    expect((await repository.findBySlug("unclear"))?.status).toBe("active");
  });

  it("skips links whose verdict is still fresh, spending no quota on them", async () => {
    await seed("fresh", "https://fresh.example/");
    await repository.update("fresh", {
      safeBrowsingVerdict: "safe",
      verdictCheckedAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    await seed("stale", "https://stale.example/");

    const summary = await run({ staleAfterMs: 24 * 60 * 60 * 1000 });

    expect(summary.skippedFresh).toBe(1);
    expect(summary.checked).toBe(1);
    expect(checker.checked).toEqual(["https://stale.example/"]);
  });

  it("re-checks a link once its verdict has aged past the threshold", async () => {
    await seed("old", "https://old.example/");
    await repository.update("old", {
      safeBrowsingVerdict: "safe",
      verdictCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const summary = await run({ staleAfterMs: 7 * 24 * 60 * 60 * 1000 });

    expect(summary.checked).toBe(1);
    expect(summary.skippedFresh).toBe(0);
  });

  it("checks a link that has never been checked", async () => {
    await seed("never", "https://never.example/");

    const summary = await run();

    expect(summary.checked).toBe(1);
  });

  it("stops at the per-run lookup ceiling and says so", async () => {
    for (let index = 0; index < 10; index += 1) {
      await seed(`link${String(index)}`, `https://example.com/${String(index)}`);
    }

    const summary = await run({ maxChecks: 4, pageSize: 3 });

    expect(summary.checked).toBe(4);
    expect(checker.checked).toHaveLength(4);
    expect(logger.lines.some((line) => line.message.includes("per-run lookup ceiling"))).toBe(true);
  });

  it("skips disabled and deleted links entirely", async () => {
    await seed("active", "https://active.example/");
    await seed("off", "https://off.example/");
    await repository.update("off", { status: "disabled" });
    await seed("gone", "https://gone.example/");
    await repository.softDelete("gone");

    const summary = await run();

    expect(summary.scanned).toBe(1);
    expect(checker.checked).toEqual(["https://active.example/"]);
  });

  it("one failing link does not end the sweep", async () => {
    await seed("boom", "https://boom.example/");
    await seed("after", "https://after.example/");
    checker.failOn = "https://boom.example/";
    /* Ordering is the repository's, so assert on the outcome rather than sequence:
       both were attempted, one failed, and the other still got its verdict. */

    const summary = await run();

    expect(summary.errors).toBe(1);
    expect(summary.checked).toBe(2);
    expect((await repository.findBySlug("after"))?.safeBrowsingVerdict).toBe("safe");
  });

  it("counts an edge-sync failure without un-disabling the link", async () => {
    await seed("gonebad", "https://was-fine.example/");
    checker.verdicts.set("https://was-fine.example/", "malicious");
    edgeCache.failure = new Error("cloudflare said no");

    const summary = await run();

    /* The source of truth already says disabled, so every cache miss resolves
       correctly; only an entry cached before the change is at risk, and that is
       bounded by the backstop TTL. */
    expect(summary.disabled).toBe(1);
    expect(summary.errors).toBe(1);
    expect((await repository.findBySlug("gonebad"))?.status).toBe("disabled");
  });

  it("logs the disable at warn level with the slug, for an operator to alert on", async () => {
    await seed("gonebad", "https://was-fine.example/");
    checker.verdicts.set("https://was-fine.example/", "malicious");

    await run();

    const line = logger.lines.find((entry) => entry.details.event === "link_disabled_by_rescan");
    expect(line?.level).toBe("warn");
    expect(line?.details.slug).toBe("gonebad");
  });

  it("pages through more links than fit in one scan page", async () => {
    for (let index = 0; index < 7; index += 1) {
      await seed(`link${String(index)}`, `https://example.com/${String(index)}`);
    }

    const summary = await run({ pageSize: 2 });

    expect(summary.scanned).toBe(7);
    expect(summary.checked).toBe(7);
  });
});
