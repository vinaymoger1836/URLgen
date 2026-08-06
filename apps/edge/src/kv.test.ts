import { env } from "cloudflare:test";
import { kvLinkKey, type KvLinkValue } from "@urlgen/shared";
import { describe, expect, it } from "vitest";

import { backstopTtlSeconds, readCachedLink, writeBackLink } from "./kv.js";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const WEEK_SECONDS = 7 * 24 * 60 * 60;

let counter = 0;
/** A slug no other test in this file is using, so writes cannot leak between cases. */
function uniqueSlug(): string {
  counter += 1;
  return `kvt${counter.toString().padStart(4, "0")}`;
}

describe("backstopTtlSeconds", () => {
  it("gives a never-expiring link the full backstop", () => {
    expect(backstopTtlSeconds({ u: "https://example.com/", s: "active" }, NOW)).toBe(WEEK_SECONDS);
  });

  it("shortens the TTL to the link's own expiry when that comes first", () => {
    const value: KvLinkValue = { u: "https://example.com/", s: "active", e: NOW + 3600_000 };
    expect(backstopTtlSeconds(value, NOW)).toBe(3600);
  });

  it("keeps the backstop when the expiry is further out than a week", () => {
    const value: KvLinkValue = { u: "https://example.com/", s: "active", e: NOW + 30 * 86_400_000 };
    expect(backstopTtlSeconds(value, NOW)).toBe(WEEK_SECONDS);
  });

  it("declines to cache a link expiring inside KV's 60s TTL floor", () => {
    /* KV rejects an expirationTtl under 60 seconds, and spending one of the day's
       1000 writes on an entry that is about to be wrong is worse than a miss. */
    const value: KvLinkValue = { u: "https://example.com/", s: "active", e: NOW + 59_000 };
    expect(backstopTtlSeconds(value, NOW)).toBeUndefined();
  });

  it("declines to cache an already-expired link", () => {
    const value: KvLinkValue = { u: "https://example.com/", s: "active", e: NOW - 1 };
    expect(backstopTtlSeconds(value, NOW)).toBeUndefined();
  });
});

describe("readCachedLink", () => {
  it("returns undefined for a key that was never written", () => {
    return expect(readCachedLink(env, uniqueSlug())).resolves.toBeUndefined();
  });

  it("round-trips a value written by writeBackLink", async () => {
    const slug = uniqueSlug();
    const value: KvLinkValue = { u: "https://example.com/x", s: "active", e: NOW + 86_400_000 };

    await writeBackLink(env, slug, value);

    await expect(readCachedLink(env, slug)).resolves.toEqual(value);
  });

  it("treats a value that is not valid JSON as a miss", async () => {
    const slug = uniqueSlug();
    await env.LINKS.put(kvLinkKey(slug), "{not json");

    /* Falling through to the origin repairs the entry on the next request. The
       alternative — surfacing an error — would serve a broken link for as long as
       the bad value lived. */
    await expect(readCachedLink(env, slug)).resolves.toBeUndefined();
  });

  it("treats a value that does not match the schema as a miss", async () => {
    const slug = uniqueSlug();
    await env.LINKS.put(kvLinkKey(slug), JSON.stringify({ u: "https://example.com/", s: "banana" }));

    await expect(readCachedLink(env, slug)).resolves.toBeUndefined();
  });

  it("rejects a blob whose expiry is not an integer timestamp", async () => {
    const slug = uniqueSlug();
    await env.LINKS.put(
      kvLinkKey(slug),
      JSON.stringify({ u: "https://example.com/", s: "active", e: "soon" }),
    );

    await expect(readCachedLink(env, slug)).resolves.toBeUndefined();
  });
});

describe("writeBackLink", () => {
  it("does not write an entry that is about to expire", async () => {
    const slug = uniqueSlug();

    await writeBackLink(env, slug, { u: "https://example.com/", s: "active", e: Date.now() + 5000 });

    await expect(env.LINKS.get(kvLinkKey(slug))).resolves.toBeNull();
  });

  it("stores the blob under the shared key prefix, not the bare slug", async () => {
    const slug = uniqueSlug();

    await writeBackLink(env, slug, { u: "https://example.com/", s: "active" });

    /* The origin's invalidation path builds the same key from @urlgen/shared. A
       prefix mismatch would mean edits silently never reached the edge. */
    await expect(env.LINKS.get(kvLinkKey(slug))).resolves.not.toBeNull();
    await expect(env.LINKS.get(slug)).resolves.toBeNull();
  });
});
