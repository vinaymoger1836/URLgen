/**
 * URL canonicalization for deduplication.
 *
 * IMPORTANT: the canonical form is the input to the dedup hash ONLY. The URL we
 * store and redirect to is always the user's original string. That separation is
 * deliberate — canonicalization sorts query parameters and drops tracking ones,
 * which is exactly right for "is this the same link?" and exactly wrong for
 * "where should this redirect?", because a minority of sites are order-sensitive
 * or read their own tracking params.
 */

export const MAX_URL_LENGTH = 2048;

export const ALLOWED_PROTOCOLS: readonly string[] = ["http:", "https:"];

/**
 * Analytics/campaign parameters that identify the traffic source rather than the
 * resource. Two links differing only by these point at the same page.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "twclid",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_name",
  "utm_source",
  "utm_source_platform",
  "utm_term",
  "vero_conv",
  "vero_id",
  "wbraid",
  "yclid",
]);

/** True when a query parameter only identifies a campaign, not the resource. */
export function isTrackingParam(name: string): boolean {
  return TRACKING_PARAMS.has(name.toLowerCase());
}

/** Parses a URL, returning undefined instead of throwing on malformed input. */
export function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw.trim());
  } catch {
    return undefined;
  }
}

/**
 * Produces the canonical form of a URL used as the deduplication key.
 *
 * Normalizes: scheme/host case, default ports, fragments, embedded credentials,
 * tracking parameters, and query parameter order.
 *
 * Deliberately does NOT normalize: `www.` prefixes, trailing slashes on non-root
 * paths, or `index.html` suffixes — each of those can address a different
 * resource on a real server, so collapsing them would merge distinct links.
 *
 * @throws {TypeError} if the input is not a parseable absolute URL.
 */
export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw.trim());

  url.hash = "";
  url.username = "";
  url.password = "";

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const retained = Array.from(url.searchParams.entries())
    .filter(([name]) => !isTrackingParam(name))
    .sort(([aName, aValue], [bName, bValue]) =>
      aName === bName ? compare(aValue, bValue) : compare(aName, bName),
    );

  const sorted = new URLSearchParams();
  for (const [name, value] of retained) {
    sorted.append(name, value);
  }
  const query = sorted.toString();
  url.search = query.length > 0 ? `?${query}` : "";

  return url.toString();
}

/** Byte-order comparison — locale-independent so the dedup key is stable everywhere. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
