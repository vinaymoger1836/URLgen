import type { KvLinkValue } from "@urlgen/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { CloudflareEdgeCache, EdgeCacheError, NoopEdgeCache } from "./edge-cache.js";

const ACCOUNT = "acct-123";
const NAMESPACE = "ns-456";
const TOKEN = "cf-token-not-a-real-secret";

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
}

let calls: RecordedCall[] = [];

/** Builds a cache whose transport records every call and replies as instructed. */
function cacheWith(reply: () => Response | Promise<Response>): CloudflareEdgeCache {
  /* The client only ever passes a string URL, so narrowing here keeps the double
     honest about what it is actually asked to do. */
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return await reply();
  };

  return new CloudflareEdgeCache({
    accountId: ACCOUNT,
    namespaceId: NAMESPACE,
    apiToken: TOKEN,
    fetchImpl: fetchImpl as typeof fetch,
  });
}

/* A fresh Response per call: a body is a single-use stream, so a shared instance
   would work once and then throw on the second read. */
function ok(status = 200): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [] }), { status });
}

function failure(status: number): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code: 10001 }] }), { status });
}

const value: KvLinkValue = { u: "https://example.com/target", s: "active" };

beforeEach(() => {
  calls = [];
});

describe("CloudflareEdgeCache.put", () => {
  it("writes the compact blob to the namespaced key", async () => {
    await cacheWith(() => ok()).put("abc1234", value);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("PUT");
    expect(call?.url).toContain(`/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/`);
    /* The `l:` prefix has to survive percent-encoding, or the origin would write a
       key the Worker never reads. */
    expect(call?.url).toContain("values/l%3Aabc1234");
    expect(call?.body).toBe(JSON.stringify(value));
  });

  it("sends the API token as a bearer credential", async () => {
    await cacheWith(() => ok()).put("abc1234", value);

    expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("asks for the full backstop TTL when the link never expires", async () => {
    await cacheWith(() => ok()).put("abc1234", value);

    expect(calls[0]?.url).toContain(`expiration_ttl=${(7 * 24 * 60 * 60).toString()}`);
  });

  it("shortens the TTL to a nearer expiry", async () => {
    await cacheWith(() => ok()).put("abc1234", { ...value, e: Date.now() + 3_600_000 });

    /* Allow a second of drift between building the value and reading the clock. */
    expect(calls[0]?.url).toMatch(/expiration_ttl=(3599|3600)\b/);
  });

  it("purges instead of writing when the link expires inside KV's TTL floor", async () => {
    await cacheWith(() => ok()).put("abc1234", { ...value, e: Date.now() + 5000 });

    /* Writing is impossible (KV's floor is 60s) and doing nothing would leave an
       older entry for the same slug alive past the change that invalidated it. */
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).not.toContain("expiration_ttl");
  });

  it("throws with the status when Cloudflare rejects the write", async () => {
    const cache = cacheWith(() => failure(403));

    await expect(cache.put("abc1234", value)).rejects.toThrow(EdgeCacheError);
    await expect(cache.put("abc1234", value)).rejects.toThrow("403");
  });

  it("throws rather than hanging when the transport fails", async () => {
    const cache = cacheWith(() => {
      throw new Error("ECONNRESET");
    });

    await expect(cache.put("abc1234", value)).rejects.toThrow(EdgeCacheError);
  });

  it("does not put the Cloudflare response body into the error message", async () => {
    const cache = cacheWith(
      () => new Response(JSON.stringify({ errors: [{ message: TOKEN }] }), { status: 400 }),
    );

    /* The API echoes request detail on some errors, and this message reaches the
       logs. Only the status is allowed to cross. */
    await expect(cache.put("abc1234", value)).rejects.not.toThrow(TOKEN);
  });
});

describe("CloudflareEdgeCache.purge", () => {
  it("deletes the namespaced key", async () => {
    await cacheWith(() => ok()).purge("abc1234");

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("values/l%3Aabc1234");
    expect(calls[0]?.body).toBeUndefined();
  });

  it("treats a 404 as success, because purging an absent key is the desired state", async () => {
    await expect(cacheWith(() => failure(404)).purge("abc1234")).resolves.toBeUndefined();
  });

  it("still fails on a real error", async () => {
    await expect(cacheWith(() => failure(500)).purge("abc1234")).rejects.toThrow(EdgeCacheError);
  });
});

describe("NoopEdgeCache", () => {
  it("accepts both operations without doing anything", async () => {
    const cache = new NoopEdgeCache();

    await expect(cache.put()).resolves.toBeUndefined();
    await expect(cache.purge()).resolves.toBeUndefined();
  });
});
