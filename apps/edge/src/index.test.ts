import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { kvLinkKey, type KvLinkValue } from "@urlgen/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env.js";
import worker from "./index.js";

interface OriginCall {
  url: string;
  token: string | undefined;
}

let originCalls: OriginCall[] = [];

/**
 * Replaces the global `fetch` the Worker uses to reach the origin.
 *
 * The handler runs per call and builds a fresh `Response` every time — a single
 * shared Response would work once and then throw, because a body is a single-use
 * stream. That exact mistake made a Phase 1 cache test silently assert nothing.
 */
function stubOrigin(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
    const header = new Headers(init?.headers).get("x-internal-token");
    originCalls.push({ url, token: header ?? undefined });
    return await handler(url);
  });
}

/** Fails the test if the Worker reaches for the origin at all. */
function forbidOrigin(): void {
  stubOrigin(() => {
    throw new Error("the origin must not be contacted on this path");
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function get(path: string, workerEnv: Env = env): Promise<Response> {
  return await dispatch(new Request(`https://short.test${path}`), workerEnv);
}

async function dispatch(request: Request, workerEnv: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, ctx);
  /* Resolves the deferred work, so an assertion about the write-back is not a
     race against it. */
  await waitOnExecutionContext(ctx);
  return response;
}

let counter = 0;
function uniqueSlug(): string {
  counter += 1;
  return `wkr${counter.toString().padStart(4, "0")}`;
}

async function seed(value: Partial<KvLinkValue> = {}): Promise<string> {
  const slug = uniqueSlug();
  const blob: KvLinkValue = { u: "https://example.com/target", s: "active", ...value };
  await env.LINKS.put(kvLinkKey(slug), JSON.stringify(blob));
  return slug;
}

beforeEach(() => {
  originCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routing", () => {
  it("answers the root path without touching KV or the origin", async () => {
    forbidOrigin();

    const response = await get("/");

    expect(response.status).toBe(200);
    expect(originCalls).toHaveLength(0);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("rejects %s with 405", async (method) => {
    forbidOrigin();

    const response = await dispatch(new Request("https://short.test/abc1234", { method }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(originCalls).toHaveLength(0);
  });

  it("serves HEAD, because a link checker should not be told the link is broken", async () => {
    forbidOrigin();
    const slug = await seed();

    const response = await dispatch(new Request(`https://short.test/${slug}`, { method: "HEAD" }));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/target");
  });

  it.each([
    ["/wp-login.php", "a bot probe"],
    ["/.env", "a secrets probe"],
    ["/a/b", "a nested path"],
    [`/${"x".repeat(33)}`, "an over-long slug"],
    ["/has%20space", "a slug with an illegal character"],
  ])("rejects %s (%s) without spending a KV read", async (path) => {
    forbidOrigin();

    const response = await get(path);

    expect(response.status).toBe(404);
    expect(originCalls).toHaveLength(0);
  });
});

describe("KV hit", () => {
  it("redirects with 302 and never contacts the origin", async () => {
    forbidOrigin();
    const slug = await seed();

    const response = await get(`/${slug}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/target");
    expect(originCalls).toHaveLength(0);
  });

  it("marks the redirect uncacheable so repeat clicks still reach the edge", async () => {
    forbidOrigin();
    const slug = await seed();

    const response = await get(`/${slug}`);

    /* This is the other half of the 301-vs-302 decision: a cached redirect is a
       click the analytics pipeline never sees. */
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns 410 for a disabled link", async () => {
    forbidOrigin();
    const slug = await seed({ s: "disabled" });

    const response = await get(`/${slug}`);

    expect(response.status).toBe(410);
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns 404 for a deleted link", async () => {
    forbidOrigin();
    const slug = await seed({ s: "deleted" });

    expect((await get(`/${slug}`)).status).toBe(404);
  });

  it("returns 410 for a link whose expiry has passed, without asking the origin", async () => {
    forbidOrigin();
    const slug = await seed({ e: Date.now() - 1000 });

    const response = await get(`/${slug}`);

    expect(response.status).toBe(410);
    expect(originCalls).toHaveLength(0);
  });

  it("still redirects when the expiry is in the future", async () => {
    forbidOrigin();
    const slug = await seed({ e: Date.now() + 3_600_000 });

    expect((await get(`/${slug}`)).status).toBe(302);
  });

  it("falls through to the origin when the cached value is unparseable", async () => {
    const slug = uniqueSlug();
    await env.LINKS.put(kvLinkKey(slug), "}{ not json");
    stubOrigin(() => jsonResponse({ u: "https://example.com/repaired", s: "active" }));

    const response = await get(`/${slug}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/repaired");
    expect(originCalls).toHaveLength(1);
  });

  it("serves a 404 rather than a redirect when the cached target is not http(s)", async () => {
    forbidOrigin();
    const slug = await seed({ u: "javascript:alert(document.domain)" });

    const response = await get(`/${slug}`);

    /* A cache is not a trust boundary. If a bad value ever reaches KV, the edge
       must not become the thing that executes it. */
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("cache miss", () => {
  it("resolves through the origin and redirects", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ u: "https://example.com/fresh", s: "active" }));

    const response = await get(`/${slug}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/fresh");
  });

  it("calls the internal endpoint with the shared token", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ u: "https://example.com/fresh", s: "active" }));

    await get(`/${slug}`);

    expect(originCalls).toHaveLength(1);
    expect(originCalls[0]?.url).toBe(`https://origin.test/internal/resolve/${slug}`);
    expect(originCalls[0]?.token).toBe(env.INTERNAL_API_TOKEN);
  });

  it("writes the resolved value back so the next request is a hit", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ u: "https://example.com/fresh", s: "active" }));

    await get(`/${slug}`);

    await expect(env.LINKS.get(kvLinkKey(slug), "json")).resolves.toEqual({
      u: "https://example.com/fresh",
      s: "active",
    });
  });

  it("serves the second request from KV without a second origin call", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ u: "https://example.com/fresh", s: "active" }));

    await get(`/${slug}`);
    const second = await get(`/${slug}`);

    expect(second.status).toBe(302);
    expect(originCalls).toHaveLength(1);
  });

  it("does not cache a link the origin says is already expired", async () => {
    const slug = uniqueSlug();
    stubOrigin(() =>
      jsonResponse({ u: "https://example.com/old", s: "active", e: Date.now() - 1000 }),
    );

    const response = await get(`/${slug}`);

    expect(response.status).toBe(410);
    await expect(env.LINKS.get(kvLinkKey(slug))).resolves.toBeNull();
  });

  it("does not cache a target the open-redirect guard rejects", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ u: "javascript:alert(1)", s: "active" }));

    const response = await get(`/${slug}`);

    expect(response.status).toBe(404);
    await expect(env.LINKS.get(kvLinkKey(slug))).resolves.toBeNull();
  });

  it("returns 404 and caches nothing when the origin has no such link", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ error: { code: "link_not_found", message: "x" } }, 404));

    const response = await get(`/${slug}`);

    expect(response.status).toBe(404);
    /* Negative results are deliberately not cached — the origin pushes an updated
       blob on edit and disable, so a re-enabled link is never stuck behind a TTL. */
    await expect(env.LINKS.get(kvLinkKey(slug))).resolves.toBeNull();
  });

  it.each([
    ["link_disabled", 410],
    ["link_expired", 410],
  ])("maps an origin %s to %i", async (code, expected) => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ error: { code, message: "x" } }, 410));

    const response = await get(`/${slug}`);

    expect(response.status).toBe(expected);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("origin failure", () => {
  it.each([401, 403, 500, 502, 429])(
    "answers 503 when the origin returns %i",
    async (status) => {
      const slug = uniqueSlug();
      stubOrigin(() => jsonResponse({ error: { code: "internal_error", message: "x" } }, status));

      expect((await get(`/${slug}`)).status).toBe(503);
    },
  );

  it("answers 503 when the origin is unreachable", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => {
      throw new Error("connection refused");
    });

    expect((await get(`/${slug}`)).status).toBe(503);
  });

  it("answers 503 when the origin does not reply in time", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    expect((await get(`/${slug}`)).status).toBe(503);
  });

  it("answers 503 when the origin body is not JSON", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => new Response("<html>gateway</html>", { status: 200 }));

    expect((await get(`/${slug}`)).status).toBe(503);
  });

  it("answers 503 when the origin body does not match the shared schema", async () => {
    const slug = uniqueSlug();
    stubOrigin(() => jsonResponse({ targetUrl: "https://example.com/", status: "active" }));

    /* A shape mismatch means the two services are on different versions. Serving
       a 404 would hide a deploy skew behind what looks like a missing link. */
    expect((await get(`/${slug}`)).status).toBe(503);
  });

  it("answers 503 without calling the origin when the shared token is not bound", async () => {
    const slug = uniqueSlug();
    forbidOrigin();
    const { INTERNAL_API_TOKEN: _unset, ...envWithoutToken } = env;

    const response = await get(`/${slug}`, envWithoutToken);

    expect(response.status).toBe(503);
    expect(originCalls).toHaveLength(0);
  });

  it("still serves a KV hit when the shared token is not bound", async () => {
    forbidOrigin();
    const slug = await seed();
    const { INTERNAL_API_TOKEN: _unset, ...envWithoutToken } = env;

    /* A missing secret degrades the miss path only. Links already at the edge
       keep working, which is the whole point of having an edge cache. */
    expect((await get(`/${slug}`, envWithoutToken)).status).toBe(302);
  });
});
