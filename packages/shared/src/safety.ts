/**
 * Target-URL safety classification.
 *
 * SCOPE — read this before extending it. URLGen never fetches a target URL
 * server-side, so this is not classic SSRF defence. The risk being addressed is
 * that a shortener is a *laundering* tool: it hides `http://169.254.169.254/...`
 * or `http://192.168.1.1/admin` behind a trustworthy-looking domain, so a victim
 * (or a victim's browser, inside a corporate network) follows a link they would
 * never have clicked in full. Blocking non-routable destinations removes that.
 *
 * All checks run against `url.hostname` AFTER WHATWG parsing, which does a lot of
 * normalization for us: `2130706433`, `0x7f000001`, `0177.0.0.1` and `127.1` all
 * arrive here as `127.0.0.1`, and Unicode hostnames arrive as punycode. Two things
 * it does NOT flatten, and which are handled explicitly below:
 *   - IPv4-mapped IPv6 stays hexadecimal: `[::ffff:127.0.0.1]` -> `[::ffff:7f00:1]`
 *   - a fully-qualified trailing dot survives: `LOCALHOST.` -> `localhost.`
 */

import { ALLOWED_PROTOCOLS, MAX_URL_LENGTH, parseUrl } from "./url.js";

/** What kind of network address a hostname refers to. Only `public` is shortenable. */
export type HostClassification =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "carrier-grade-nat"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "local-hostname";

export type UrlSafetyIssue =
  | "malformed"
  | "too-long"
  | "unsupported-protocol"
  | "embedded-credentials"
  | "missing-hostname"
  | "non-public-host"
  | "self-referential";

export interface UrlSafetyResult {
  /** True only when there are no issues at all. */
  safe: boolean;
  issues: readonly UrlSafetyIssue[];
  /** Present when the URL parsed far enough to have a host. */
  hostname?: string;
  classification?: HostClassification;
  /**
   * Punycode/IDN hostnames are reported, not rejected. A homograph attack
   * (`аpple.com` with a Cyrillic а) arrives here as `xn--pple-43d.com`, but so
   * does every legitimate internationalized domain. Deciding between them needs
   * script-mixing analysis on the decoded label; until then this is surfaced for
   * abuse review rather than used to block real IDN sites.
   */
  punycode: boolean;
}

/** Suffixes that always denote a private or machine-local namespace. */
const LOCAL_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa", ".lan"] as const;

const LOCAL_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

export interface UrlSafetyOptions {
  /**
   * Hosts belonging to this shortener. Shortening one of our own links creates a
   * redirect loop and is a cheap way to build an amplification chain.
   */
  ownHosts?: readonly string[];
}

/** Classifies a target URL and lists every reason it may not be shortened. */
export function assessUrlSafety(raw: string, options: UrlSafetyOptions = {}): UrlSafetyResult {
  const issues: UrlSafetyIssue[] = [];

  if (raw.length > MAX_URL_LENGTH) {
    issues.push("too-long");
  }

  const url = parseUrl(raw);
  if (!url) {
    return { safe: false, issues: [...issues, "malformed"], punycode: false };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    issues.push("unsupported-protocol");
  }
  if (url.username !== "" || url.password !== "") {
    issues.push("embedded-credentials");
  }
  if (url.hostname === "") {
    return { safe: false, issues: [...issues, "missing-hostname"], punycode: false };
  }

  const hostname = normalizeHost(url.hostname);
  const classification = classifyHost(hostname);
  const punycode = isPunycodeHost(hostname);

  if (classification !== "public") {
    issues.push("non-public-host");
  }

  const ownHosts = (options.ownHosts ?? []).map((host) => normalizeHost(stripPort(host)));
  if (ownHosts.includes(hostname)) {
    issues.push("self-referential");
  }

  return { safe: issues.length === 0, issues, hostname, classification, punycode };
}

/** Lowercases and drops the fully-qualified trailing dot and IPv6 brackets. */
export function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  while (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

/** True when any label is punycode-encoded, i.e. the host was internationalized. */
export function isPunycodeHost(host: string): boolean {
  return normalizeHost(host)
    .split(".")
    .some((label) => label.startsWith("xn--"));
}

/** Determines whether a hostname is publicly routable, and if not, why. */
export function classifyHost(host: string): HostClassification {
  const hostname = normalizeHost(host);

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    return classifyIpv4(ipv4);
  }

  const ipv6 = parseIpv6(hostname);
  if (ipv6) {
    return classifyIpv6(ipv6);
  }

  if (LOCAL_HOSTNAMES.has(hostname)) {
    return "local-hostname";
  }
  if (LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return "local-hostname";
  }
  /* A bare single label ("intranet", "wiki") only resolves via a local search
     domain, so it is never a valid public destination. */
  if (!hostname.includes(".")) {
    return "local-hostname";
  }

  return "public";
}

function classifyIpv4(octets: readonly [number, number, number, number]): HostClassification {
  const [a, b] = octets;

  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  /* 169.254.0.0/16 — link-local, and the address every cloud metadata service
     lives on (169.254.169.254). The single most valuable range to block. */
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  /* Documentation (TEST-NET-1/2/3) and benchmarking ranges are not routable. */
  if (a === 192 && b === 0 && octets[2] === 2) return "reserved";
  if (a === 198 && b === 51 && octets[2] === 100) return "reserved";
  if (a === 203 && b === 0 && octets[2] === 113) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 192 && b === 0 && octets[2] === 0) return "reserved";

  return "public";
}

function classifyIpv6(groups: readonly number[]): HostClassification {
  const [g0 = 0] = groups;

  /* IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses must be judged by
     the embedded IPv4 address, or ::ffff:127.0.0.1 would sail through as public. */
  const mapped = embeddedIpv4(groups);
  if (mapped) {
    return classifyIpv4(mapped);
  }

  if (groups.every((group) => group === 0)) return "unspecified";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
  if ((g0 & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if (g0 === 0x2001 && groups[1] === 0x0db8) return "reserved"; // 2001:db8::/32 docs

  return "public";
}

/** Extracts the IPv4 address embedded in ::ffff:a.b.c.d or ::a.b.c.d, if present. */
function embeddedIpv4(groups: readonly number[]): [number, number, number, number] | undefined {
  const leading = groups.slice(0, 5);
  if (!leading.every((group) => group === 0)) {
    return undefined;
  }

  const marker = groups[5];
  const high = groups[6];
  const low = groups[7];
  if (high === undefined || low === undefined) {
    return undefined;
  }
  /* 0xffff marks IPv4-mapped; 0x0000 is the deprecated IPv4-compatible form.
     ::1 is loopback, not an embedded address, so exclude the all-but-last-zero case. */
  if (marker !== 0xffff && !(marker === 0 && (high !== 0 || low > 1))) {
    return undefined;
  }

  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/** Parses dotted-decimal IPv4. Input is assumed already normalized by the URL parser. */
export function parseIpv4(input: string): [number, number, number, number] | undefined {
  const parts = input.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const value = Number(part);
    if (value > 255) {
      return undefined;
    }
    octets.push(value);
  }

  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return undefined;
  }
  return [a, b, c, d];
}

/** Parses an IPv6 literal (without brackets) into eight 16-bit groups. */
export function parseIpv6(input: string): number[] | undefined {
  let text = input.toLowerCase();
  if (!text.includes(":")) {
    return undefined;
  }

  /* Drop a zone identifier (fe80::1%eth0) — it never affects classification. */
  const zoneIndex = text.indexOf("%");
  if (zoneIndex !== -1) {
    text = text.slice(0, zoneIndex);
  }

  /* A trailing dotted-quad contributes the final two groups. */
  let suffix: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4 = parseIpv4(tail);
    if (!ipv4) {
      return undefined;
    }
    suffix = [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
    text = text.slice(0, lastColon);
  }

  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }

  const head = parseGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (head === undefined || rest === undefined) {
    return undefined;
  }

  const known = head.length + rest.length + suffix.length;
  if (halves.length === 2) {
    if (known > 7) {
      return undefined;
    }
    const zeros = new Array<number>(8 - known).fill(0);
    return [...head, ...zeros, ...rest, ...suffix];
  }

  const groups = [...head, ...suffix];
  return groups.length === 8 ? groups : undefined;
}

function parseGroups(text: string): number[] | undefined {
  if (text === "") {
    return [];
  }

  const groups: number[] = [];
  for (const group of text.split(":")) {
    if (group === "" || group.length > 4 || !/^[0-9a-f]+$/.test(group)) {
      return undefined;
    }
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

function stripPort(host: string): string {
  const normalized = host.trim();
  /* Leave IPv6 literals alone — they are full of colons. */
  if (normalized.includes("]") || normalized.split(":").length > 2) {
    return normalized;
  }
  const colon = normalized.lastIndexOf(":");
  return colon === -1 ? normalized : normalized.slice(0, colon);
}
