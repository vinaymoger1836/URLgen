import { describe, expect, it } from "vitest";

import { sha256Hex, urlDedupHash } from "./hash.js";

describe("sha256Hex", () => {
  it("matches the published SHA-256 test vectors", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes UTF-8 rather than code units", async () => {
    await expect(sha256Hex("héllo")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("urlDedupHash", () => {
  it("collapses URLs that differ only by tracking params, order or fragment", async () => {
    const baseline = await urlDedupHash("https://example.com/p?a=1&b=2", "user-1");

    await expect(urlDedupHash("https://example.com/p?b=2&a=1", "user-1")).resolves.toBe(baseline);
    await expect(
      urlDedupHash("https://example.com/p?a=1&b=2&utm_source=nl", "user-1"),
    ).resolves.toBe(baseline);
    await expect(urlDedupHash("https://example.com/p?a=1&b=2#top", "user-1")).resolves.toBe(
      baseline,
    );
    await expect(urlDedupHash("HTTPS://EXAMPLE.COM/p?a=1&b=2", "user-1")).resolves.toBe(baseline);
  });

  it("keeps genuinely different URLs apart", async () => {
    const a = await urlDedupHash("https://example.com/p?a=1", "user-1");
    const b = await urlDedupHash("https://example.com/p?a=2", "user-1");
    expect(a).not.toBe(b);
  });

  it("is scoped per owner so one user's link is never handed to another", async () => {
    const forUserOne = await urlDedupHash("https://example.com/p", "user-1");
    const forUserTwo = await urlDedupHash("https://example.com/p", "user-2");
    expect(forUserOne).not.toBe(forUserTwo);
  });

  it("rejects unparseable URLs rather than hashing garbage", async () => {
    await expect(urlDedupHash("not a url", "user-1")).rejects.toThrow(TypeError);
  });
});
