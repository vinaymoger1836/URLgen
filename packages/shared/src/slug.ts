/**
 * Slug shape rules and the reserved-word blocklist.
 *
 * The edge worker applies `isWellFormedSlug` before it ever touches KV, so
 * garbage paths are rejected without spending a read against the daily quota.
 */

export const MIN_CUSTOM_SLUG_LENGTH = 3;
export const MAX_CUSTOM_SLUG_LENGTH = 32;

/** Base62 plus `-` and `_`, which are URL-safe and read cleanly in a short link. */
const SLUG_PATTERN = /^[0-9A-Za-z_-]+$/;

/**
 * Paths the platform needs for itself. A custom slug may not take one of these,
 * otherwise a link would shadow a real route (or a route would shadow the link).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "_next",
  "about",
  "admin",
  "analytics",
  "api",
  "assets",
  "auth",
  "blog",
  "contact",
  "dashboard",
  "docs",
  "edit",
  "favicon.ico",
  "health",
  "help",
  "internal",
  "links",
  "login",
  "logout",
  "new",
  "pricing",
  "privacy",
  "public",
  "robots.txt",
  "settings",
  "signup",
  "sitemap.xml",
  "static",
  "stats",
  "status",
  "support",
  "terms",
  "www",
]);

export type SlugRejectionReason =
  "too-short" | "too-long" | "invalid-characters" | "reserved" | "leading-or-trailing-separator";

export type SlugValidation = { valid: true } | { valid: false; reason: SlugRejectionReason };

/** True when the string could be a slug at all — a cheap pre-check for the hot path. */
export function isWellFormedSlug(candidate: string): boolean {
  return (
    candidate.length >= 1 &&
    candidate.length <= MAX_CUSTOM_SLUG_LENGTH &&
    SLUG_PATTERN.test(candidate)
  );
}

/** True when a slug collides with a platform-reserved path. Case-insensitive. */
export function isReservedSlug(candidate: string): boolean {
  return RESERVED_SLUGS.has(candidate.toLowerCase());
}

/** Validates a user-supplied custom slug, returning the specific reason on failure. */
export function validateCustomSlug(candidate: string): SlugValidation {
  if (candidate.length < MIN_CUSTOM_SLUG_LENGTH) {
    return { valid: false, reason: "too-short" };
  }
  if (candidate.length > MAX_CUSTOM_SLUG_LENGTH) {
    return { valid: false, reason: "too-long" };
  }
  if (!SLUG_PATTERN.test(candidate)) {
    return { valid: false, reason: "invalid-characters" };
  }
  if (/^[-_]|[-_]$/.test(candidate)) {
    return { valid: false, reason: "leading-or-trailing-separator" };
  }
  if (isReservedSlug(candidate)) {
    return { valid: false, reason: "reserved" };
  }
  return { valid: true };
}
