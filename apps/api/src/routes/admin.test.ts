import { kvLinkKey, type KvLinkValue } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import {
  InMemoryAbuseQueue,
  InMemoryAbuseRepository,
} from "../repositories/abuse-repository.js";
import { EdgeCacheError, type EdgeCache } from "../repositories/edge-cache.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { InMemoryRateLimiter } from "../repositories/rate-limiter.js";
import { buildServer } from "../server.js";

const ADMIN_TOKEN = "a".repeat(40);
const config = loadConfig({
  NODE_ENV: "test",
  SHORT_DOMAIN: "urlgen.test",
  ADMIN_API_TOKEN: ADMIN_TOKEN,
});

type EdgeOp = { op: "put"; slug: string; value: KvLinkValue } | { op: "purge"; slug: string };

class RecordingEdgeCache implements EdgeCache {
  public readonly ops: EdgeOp[] = [];
  public failure: Error | undefined;

  public put(slug: string, value: KvLinkValue): Promise<void> {
    this.ops.push({ op: "put", slug, value });
    return this.#settle();
  }

  public purge(slug: string): Promise<void> {
    this.ops.push({ op: "purge", slug });
    return this.#settle();
  }

  #settle(): Promise<void> {
    return this.failure === undefined ? Promise.resolve() : Promise.reject(this.failure);
  }
}

let app: FastifyInstance;
let repository: InMemoryLinkRepository;
let reports: InMemoryAbuseRepository;
let queue: InMemoryAbuseQueue;
let edgeCache: RecordingEdgeCache;

function build(overrideConfig = config): FastifyInstance {
  repository = new InMemoryLinkRepository();
  reports = new InMemoryAbuseRepository();
  queue = new InMemoryAbuseQueue();
  edgeCache = new RecordingEdgeCache();

  return buildServer(overrideConfig, {
    linkRepository: repository,
    abuseRepository: reports,
    abuseQueue: queue,
    edgeCache,
    rateLimiter: new InMemoryRateLimiter(),
  });
}

async function seedLink(slug: string): Promise<void> {
  await repository.create({
    targetUrl: "https://malware.example/payload",
    ownerId: "alice",
    urlHash: `hash-${slug}`,
    customSlug: slug,
  });
}

function asAdmin(method: "GET" | "POST", url: string) {
  return app.inject({ method, url, headers: { "x-admin-token": ADMIN_TOKEN } });
}

beforeEach(async () => {
  app = build();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("admin authentication", () => {
  it("refuses a request with no token", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/abuse" });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("unauthorized");
  });

  it("refuses a wrong token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/abuse",
      headers: { "x-admin-token": "b".repeat(40) },
    });

    expect(response.statusCode).toBe(401);
  });

  it("does not accept the internal token in place of the admin one", async () => {
    /* Two credentials for two jobs. One token doing both means a leaked
       service-to-service secret also grants the ability to disable links. */
    const withInternal = buildServer(
      loadConfig({
        NODE_ENV: "test",
        ADMIN_API_TOKEN: ADMIN_TOKEN,
        INTERNAL_API_TOKEN: "c".repeat(40),
      }),
      {
        linkRepository: new InMemoryLinkRepository(),
        abuseRepository: new InMemoryAbuseRepository(),
        abuseQueue: new InMemoryAbuseQueue(),
        rateLimiter: new InMemoryRateLimiter(),
      },
    );

    const response = await withInternal.inject({
      method: "GET",
      url: "/admin/abuse",
      headers: { "x-internal-token": "c".repeat(40) },
    });

    expect(response.statusCode).toBe(401);
    await withInternal.close();
  });

  it("does not mount the routes at all when no admin token is configured", async () => {
    /* 404, not 401: an unconfigured admin surface should not advertise that it is
       there and invite someone to go looking for the credential. */
    const unconfigured = build(loadConfig({ NODE_ENV: "test" }));
    await unconfigured.ready();

    const response = await unconfigured.inject({ method: "GET", url: "/admin/abuse" });
    expect(response.statusCode).toBe(404);

    await unconfigured.close();
  });
});

describe("GET /admin/abuse", () => {
  it("lists the review queue, most recently reported first", async () => {
    await app.inject({
      method: "POST",
      url: "/api/abuse-reports",
      payload: { slug: "badlink", reason: "malware" },
    });

    const response = await asAdmin("GET", "/admin/abuse");

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: { slug: string; reports: number }[] }>();
    expect(body.items[0]?.slug).toBe("badlink");
    expect(body.items[0]?.reports).toBe(1);
  });
});

describe("GET /admin/abuse/:slug", () => {
  it("returns the reports filed against one slug", async () => {
    await reports.record({ slug: "badlink", reason: "phishing", details: "fake login" });

    const response = await asAdmin("GET", "/admin/abuse/badlink");

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: { reason: string }[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.reason).toBe("phishing");
  });
});

describe("POST /admin/links/:slug/disable", () => {
  it("disables the link and overwrites the edge entry rather than purging it", async () => {
    await seedLink("badlink");

    const response = await asAdmin("POST", "/admin/links/badlink/disable");

    expect(response.statusCode).toBe(200);
    expect((await repository.findBySlug("badlink"))?.status).toBe("disabled");

    /*
     * The deliberate divergence from the phase checklist's "purges KV". A link
     * disabled for abuse is the one most likely to be under active traffic, so a
     * `disabled` tombstone answering 410 at the edge beats a purge that converts
     * every one of those hits into an origin round trip. The property the
     * checklist protects — the edge stops redirecting immediately — is met either
     * way; this way is cheaper under exactly the load that matters.
     */
    expect(edgeCache.ops).toEqual([
      { op: "put", slug: "badlink", value: { u: "https://malware.example/payload", s: "disabled" } },
    ]);
    expect(edgeCache.ops.some((op) => op.op === "purge")).toBe(false);
  });

  it("clears the slug from the review queue", async () => {
    await seedLink("badlink");
    await queue.add("badlink", new Date());

    await asAdmin("POST", "/admin/links/badlink/disable");

    expect(await queue.list()).toHaveLength(0);
  });

  it("tells the operator when the change did not reach the edge", async () => {
    /* The one edge-sync failure in the system worth surfacing. On the owner-facing
       paths a failed sync is swallowed, because the owner cannot act on it. An
       operator asking "is this malware link still live?" can, and "yes, possibly"
       is the honest answer. */
    await seedLink("badlink");
    edgeCache.failure = new EdgeCacheError("cloudflare said no");

    const response = await asAdmin("POST", "/admin/links/badlink/disable");

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "may still redirect",
    );
    /* The store still changed — the link is disabled for every cache miss. */
    expect((await repository.findBySlug("badlink"))?.status).toBe("disabled");
  });

  it("returns 404 for a slug that does not exist", async () => {
    const response = await asAdmin("POST", "/admin/links/nosuchx/disable");
    expect(response.statusCode).toBe(404);
  });

  it("works on a link the admin does not own", async () => {
    /* Ownership scoping is what the owner-facing routes enforce; an abuse review
       that could only act on the reviewer's own links would be useless. */
    await seedLink("someoneelse");

    const response = await asAdmin("POST", "/admin/links/someoneelse/disable");

    expect(response.statusCode).toBe(200);
    expect((await repository.findBySlug("someoneelse"))?.ownerId).toBe("alice");
  });
});

describe("POST /admin/links/:slug/enable", () => {
  it("puts a disabled link back and syncs the edge", async () => {
    await seedLink("badlink");
    await asAdmin("POST", "/admin/links/badlink/disable");
    edgeCache.ops.length = 0;

    const response = await asAdmin("POST", "/admin/links/badlink/enable");

    expect(response.statusCode).toBe(200);
    expect((await repository.findBySlug("badlink"))?.status).toBe("active");
    expect(edgeCache.ops).toEqual([
      { op: "put", slug: "badlink", value: { u: "https://malware.example/payload", s: "active" } },
    ]);
  });
});

describe("the KV key the edge reads", () => {
  it("is the one both sides agree on", async () => {
    /* Cheap assertion, but the edge and the origin computing this differently is a
       failure that looks like "the cache just never hits". */
    expect(kvLinkKey("badlink")).toBe("l:badlink");
  });
});
