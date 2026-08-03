/**
 * In-memory `LinkRepository` for tests.
 *
 * Mirrors the DynamoDB implementation's *observable* semantics — slug uniqueness
 * enforced at write time, owner-scoped dedup lookup, soft delete, newest-first
 * listing — so route tests exercise real behaviour without a database. It is not
 * a DynamoDB emulator: conditional-write races and index consistency are covered
 * by the integration tests instead.
 */

import { generateSlug, type LinkRecord } from "@urlgen/shared";

import {
  LinkNotFoundError,
  SlugAllocationError,
  SlugUnavailableError,
  type CreateLinkInput,
  type LinkPage,
  type LinkRepository,
  type ListLinksOptions,
  type UpdateLinkPatch,
} from "./link-repository.js";

export interface InMemoryLinkRepositoryOptions {
  slugAttempts?: number;
  generateSlugFn?: () => string;
  now?: () => Date;
}

export class InMemoryLinkRepository implements LinkRepository {
  readonly #records = new Map<string, LinkRecord>();
  readonly #slugAttempts: number;
  readonly #generateSlug: () => string;
  readonly #now: () => Date;

  public constructor(options: InMemoryLinkRepositoryOptions = {}) {
    this.#slugAttempts = options.slugAttempts ?? 5;
    this.#generateSlug = options.generateSlugFn ?? (() => generateSlug());
    this.#now = options.now ?? (() => new Date());
  }

  public create(input: CreateLinkInput): Promise<LinkRecord> {
    if (input.customSlug !== undefined) {
      if (this.#records.has(input.customSlug)) {
        return Promise.reject(new SlugUnavailableError(input.customSlug));
      }
      return Promise.resolve(this.#store(input, input.customSlug));
    }

    for (let attempt = 0; attempt < this.#slugAttempts; attempt += 1) {
      const slug = this.#generateSlug();
      if (!this.#records.has(slug)) {
        return Promise.resolve(this.#store(input, slug));
      }
    }
    return Promise.reject(new SlugAllocationError(this.#slugAttempts));
  }

  public findBySlug(slug: string): Promise<LinkRecord | undefined> {
    return Promise.resolve(this.#records.get(slug));
  }

  public findSlugByUrlHash(urlHash: string): Promise<string | undefined> {
    for (const record of this.#records.values()) {
      if (record.urlHash === urlHash) {
        return Promise.resolve(record.slug);
      }
    }
    return Promise.resolve(undefined);
  }

  public update(slug: string, patch: UpdateLinkPatch): Promise<LinkRecord> {
    const existing = this.#records.get(slug);
    if (existing === undefined) {
      return Promise.reject(new LinkNotFoundError(slug));
    }

    const updated: LinkRecord = {
      ...existing,
      updatedAt: this.#now().toISOString(),
      ...(patch.targetUrl !== undefined ? { targetUrl: patch.targetUrl } : {}),
      ...(patch.urlHash !== undefined ? { urlHash: patch.urlHash } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.expiresAt !== undefined && patch.expiresAt !== null
        ? { expiresAt: patch.expiresAt }
        : {}),
    };

    if (patch.expiresAt === null) {
      delete updated.expiresAt;
    }

    this.#records.set(slug, updated);
    return Promise.resolve(updated);
  }

  public async softDelete(slug: string): Promise<void> {
    await this.update(slug, { status: "deleted" });
  }

  public listByOwner(ownerId: string, options: ListLinksOptions = {}): Promise<LinkPage> {
    const owned = [...this.#records.values()]
      .filter((record) => record.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const limit = options.limit ?? 25;
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const page = owned.slice(start, start + limit);
    const nextIndex = start + page.length;

    /*
     * Drops `urlHash` to mirror the owner index's INCLUDE projection. Returning
     * whole records here would let a caller depend on a field DynamoDB never
     * sends back — which is exactly how that bug reached the integration tests.
     */
    const items = page.map(({ urlHash: _urlHash, ...summary }) => summary);

    return Promise.resolve({
      items,
      ...(nextIndex < owned.length ? { cursor: String(nextIndex) } : {}),
    });
  }

  /** Test helper: seed a record directly. */
  public seed(record: LinkRecord): void {
    this.#records.set(record.slug, record);
  }

  public get size(): number {
    return this.#records.size;
  }

  #store(input: CreateLinkInput, slug: string): LinkRecord {
    const timestamp = this.#now().toISOString();
    const record: LinkRecord = {
      slug,
      targetUrl: input.targetUrl,
      ownerId: input.ownerId,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      urlHash: input.urlHash,
      clickCount: 0,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.punycode === true ? { punycode: true } : {}),
    };
    this.#records.set(slug, record);
    return record;
  }
}
