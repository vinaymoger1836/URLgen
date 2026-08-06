/**
 * The origin's handle on the edge cache tier.
 *
 * Workers KV is written from two places: the Worker itself on a cache-miss
 * write-back, and from here whenever the source of truth changes. The second one
 * is what makes cache invalidation explicit rather than a matter of waiting for a
 * TTL — a disabled link has to stop redirecting now, not within a week.
 *
 * The Worker cannot do this itself: it only runs when someone visits a link, and
 * the whole problem is that after an edit nobody should be redirected at all.
 */

import { kvBackstopTtlSeconds, kvLinkKey, type KvLinkValue } from "@urlgen/shared";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * The edit path is not the redirect path, so it can afford to wait — but not for
 * long. A slow Cloudflare API must not hold a dashboard request open.
 */
const DEFAULT_TIMEOUT_MS = 3000;

export interface EdgeCache {
  /** Overwrites the cached blob for a slug so the edge serves the new state. */
  put(slug: string, value: KvLinkValue): Promise<void>;
  /** Removes the cached blob for a slug. Succeeds whether or not it was there. */
  purge(slug: string): Promise<void>;
}

/** Raised when the Cloudflare API refuses or fails a cache operation. */
export class EdgeCacheError extends Error {
  public readonly status: number | undefined;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = "EdgeCacheError";
    this.status = status;
  }
}

export interface CloudflareEdgeCacheOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Writes Workers KV through Cloudflare's REST API. */
export class CloudflareEdgeCache implements EdgeCache {
  readonly #accountId: string;
  readonly #namespaceId: string;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(options: CloudflareEdgeCacheOptions) {
    this.#accountId = options.accountId;
    this.#namespaceId = options.namespaceId;
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async put(slug: string, value: KvLinkValue): Promise<void> {
    const ttl = kvBackstopTtlSeconds(value, Date.now());
    if (ttl === undefined) {
      /* About to expire anyway. Purge instead of writing, so an older entry for
         the same slug cannot outlive the change that made it wrong. */
      await this.purge(slug);
      return;
    }

    const url = `${this.#keyUrl(slug)}?expiration_ttl=${ttl.toString()}`;
    await this.#send("PUT", url, JSON.stringify(value));
  }

  public async purge(slug: string): Promise<void> {
    await this.#send("DELETE", this.#keyUrl(slug), undefined, [404]);
  }

  #keyUrl(slug: string): string {
    const key = encodeURIComponent(kvLinkKey(slug));
    return `${CLOUDFLARE_API_BASE}/accounts/${this.#accountId}/storage/kv/namespaces/${this.#namespaceId}/values/${key}`;
  }

  async #send(
    method: string,
    url: string,
    body?: string,
    tolerate: readonly number[] = [],
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiToken}`,
          ...(body !== undefined ? { "content-type": "text/plain" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      throw new EdgeCacheError(`Cloudflare KV request failed: ${detail}`);
    }

    if (response.ok || tolerate.includes(response.status)) {
      return;
    }

    /* The body can name the failing field, but it can also echo request details.
       Only the status crosses into our logs. */
    throw new EdgeCacheError(`Cloudflare KV returned ${response.status.toString()}`, response.status);
  }
}

/**
 * The no-op used when Cloudflare credentials are not configured.
 *
 * Local development has no KV namespace and does not need one — `wrangler dev`
 * simulates its own. Making this an explicit implementation rather than an
 * `if (configured)` at each call site keeps the routes free of the question.
 */
export class NoopEdgeCache implements EdgeCache {
  public put(): Promise<void> {
    return Promise.resolve();
  }

  public purge(): Promise<void> {
    return Promise.resolve();
  }
}
