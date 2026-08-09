import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import {
  InMemoryAbuseQueue,
  InMemoryAbuseRepository,
} from "../repositories/abuse-repository.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { InMemoryRateLimiter } from "../repositories/rate-limiter.js";
import { buildServer } from "../server.js";

const config = loadConfig({ NODE_ENV: "test", SHORT_DOMAIN: "urlgen.test" });

let app: FastifyInstance;
let reports: InMemoryAbuseRepository;
let queue: InMemoryAbuseQueue;
let repository: InMemoryLinkRepository;

beforeEach(async () => {
  reports = new InMemoryAbuseRepository();
  queue = new InMemoryAbuseQueue();
  repository = new InMemoryLinkRepository();

  app = buildServer(config, {
    linkRepository: repository,
    abuseRepository: reports,
    abuseQueue: queue,
    rateLimiter: new InMemoryRateLimiter(),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function report(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/abuse-reports", payload });
}

describe("POST /api/abuse-reports", () => {
  it("accepts a report and records it", async () => {
    const response = await report({
      slug: "abc1234",
      reason: "phishing",
      details: "pretends to be a bank login",
    });

    expect(response.statusCode).toBe(202);
    const stored = await reports.listBySlug("abc1234");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.reason).toBe("phishing");
    expect(stored[0]?.details).toBe("pretends to be a bank login");
  });

  it("answers identically for a slug that exists and one that does not", async () => {
    /* The enumeration defence. A 404 for an unknown slug would turn a form that
       has to stay open to anonymous callers into a free slug oracle: submit a
       report per candidate and read existence off the status code. */
    await repository.create({
      targetUrl: "https://example.com/",
      ownerId: "alice",
      urlHash: "hash",
      customSlug: "realone",
    });

    const known = await report({ slug: "realone", reason: "spam" });
    const invented = await report({ slug: "nosuchx", reason: "spam" });

    expect(known.statusCode).toBe(invented.statusCode);
    expect(known.body).toBe(invented.body);
  });

  it("puts the slug on the review queue", async () => {
    await report({ slug: "abc1234", reason: "malware" });
    await report({ slug: "abc1234", reason: "phishing" });
    await report({ slug: "zzz9999", reason: "spam" });

    const pending = await queue.list();
    expect(pending.map((entry) => entry.slug)).toContain("abc1234");
    expect(pending.find((entry) => entry.slug === "abc1234")?.reports).toBe(2);
  });

  it("rejects a reason outside the closed set", async () => {
    const response = await report({ slug: "abc1234", reason: "i-just-dont-like-it" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a malformed slug without consulting storage", async () => {
    const response = await report({ slug: "not a slug!", reason: "spam" });

    expect(response.statusCode).toBe(400);
    expect(await reports.listBySlug("not a slug!")).toHaveLength(0);
  });

  it("caps the free-text field", async () => {
    const response = await report({
      slug: "abc1234",
      reason: "other",
      details: "x".repeat(1_001),
    });
    expect(response.statusCode).toBe(400);
  });

  it("stores nothing identifying the reporter", async () => {
    /* Not a policy, a property: there is no field for it, so there is nothing to
       leak, and the assertion is over the whole serialized report. */
    await app.inject({
      method: "POST",
      url: "/api/abuse-reports",
      headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "ReporterBot/1.0" },
      payload: { slug: "abc1234", reason: "spam" },
    });

    const serialized = JSON.stringify(await reports.listBySlug("abc1234"));
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("ReporterBot");
    expect(serialized.toLowerCase()).not.toContain("ip");
  });
});
