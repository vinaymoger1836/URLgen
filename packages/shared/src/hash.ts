/**
 * Hashing helpers built on Web Crypto (`crypto.subtle`), which exists in Node 18+,
 * Cloudflare Workers and browsers alike — so the same code runs at the edge and at
 * the origin. `node:crypto` would not load in a Worker.
 */

import { canonicalizeUrl } from "./url.js";

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

/**
 * The deduplication key for a link.
 *
 * Scoped by owner on purpose: a global dedup would hand user A the slug that user
 * B created for the same URL, leaking B's link (and its analytics) to A.
 *
 * The two parts are joined with a newline, a character that cannot appear in a
 * canonical URL, so `(ownerId, url)` pairs cannot be made to collide by crafting
 * an owner id that runs into the URL.
 */
export async function urlDedupHash(rawUrl: string, ownerId: string): Promise<string> {
  return sha256Hex(`${ownerId}\n${canonicalizeUrl(rawUrl)}`);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
