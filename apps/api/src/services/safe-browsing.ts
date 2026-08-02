/**
 * Google Safe Browsing v4 lookup, performed once at link-creation time.
 *
 * FAIL-OPEN, deliberately. A missing API key, a timeout, a non-200, or an
 * unparseable body all yield `unknown`, and `unknown` is allowed through. The
 * alternative — refusing to create links when Google is unreachable — would make
 * Google's availability our availability, in exchange for blocking a threat that
 * arrives through a different door anyway (URLs go bad *after* creation, which is
 * why Phase 5 re-scans existing links). Only an explicit threat match blocks.
 *
 * The check runs on create, never on redirect: the redirect path may not make a
 * network call, and a verdict that was true at creation is the one we acted on.
 */

const ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";

const THREAT_TYPES = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
  "POTENTIALLY_HARMFUL_APPLICATION",
] as const;

export type SafeBrowsingVerdict = "safe" | "malicious" | "unknown";

export interface UrlSafetyChecker {
  check(url: string): Promise<SafeBrowsingVerdict>;
}

export interface SafeBrowsingOptions {
  apiKey?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  onError?: (error: unknown) => void;
}

interface CacheEntry {
  verdict: SafeBrowsingVerdict;
  expiresAt: number;
}

export class SafeBrowsingClient implements UrlSafetyChecker {
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #maxCacheEntries: number;
  readonly #onError: (error: unknown) => void;
  readonly #cache = new Map<string, CacheEntry>();

  public constructor(options: SafeBrowsingOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 2_000;
    this.#cacheTtlMs = options.cacheTtlMs ?? 6 * 60 * 60 * 1000;
    this.#maxCacheEntries = options.maxCacheEntries ?? 5_000;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** True when a key is configured; false means every verdict will be `unknown`. */
  public get enabled(): boolean {
    return this.#apiKey !== undefined && this.#apiKey !== "";
  }

  public async check(url: string): Promise<SafeBrowsingVerdict> {
    if (!this.enabled) {
      return "unknown";
    }

    const cached = this.#readCache(url);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const verdict = await this.#lookup(url);
      this.#writeCache(url, verdict);
      return verdict;
    } catch (error) {
      this.#onError(error);
      /* Not cached: a transient failure must not pin `unknown` for hours. */
      return "unknown";
    }
  }

  async #lookup(url: string): Promise<SafeBrowsingVerdict> {
    const response = await this.#fetch(`${ENDPOINT}?key=${encodeURIComponent(this.#apiKey ?? "")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "urlgen", clientVersion: "0.1.0" },
        threatInfo: {
          threatTypes: THREAT_TYPES,
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: [{ url }],
        },
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Safe Browsing responded ${String(response.status)}`);
    }

    const body: unknown = await response.json();
    return hasThreatMatch(body) ? "malicious" : "safe";
  }

  #readCache(url: string): SafeBrowsingVerdict | undefined {
    const entry = this.#cache.get(url);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.#cache.delete(url);
      return undefined;
    }
    return entry.verdict;
  }

  #writeCache(url: string, verdict: SafeBrowsingVerdict): void {
    /* Bounded to keep a long-lived process from growing without limit. Oldest
       insertion is evicted first — Map preserves insertion order. */
    if (this.#cache.size >= this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) {
        this.#cache.delete(oldest.value);
      }
    }
    this.#cache.set(url, { verdict, expiresAt: Date.now() + this.#cacheTtlMs });
  }
}

/** Safe Browsing returns `{}` for a clean URL and `{ matches: [...] }` for a hit. */
function hasThreatMatch(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("matches" in body)) {
    return false;
  }
  const { matches } = body as { matches?: unknown };
  return Array.isArray(matches) && matches.length > 0;
}

/** A checker that approves everything — used when no API key is configured. */
export const permissiveUrlSafetyChecker: UrlSafetyChecker = {
  check: () => Promise.resolve("unknown"),
};
