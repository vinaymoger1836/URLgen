/**
 * Storage contract for links.
 *
 * The interface exists so routes never import the AWS SDK: they deal in domain
 * objects and the typed errors below, which keeps `ConditionalCheckFailedException`
 * and other vendor details from leaking into HTTP handling.
 */

import type { LinkRecord, LinkStatus, LinkSummary } from "@urlgen/shared";

export interface CreateLinkInput {
  targetUrl: string;
  ownerId: string;
  urlHash: string;
  /** When absent, a random slug is allocated. */
  customSlug?: string;
  expiresAt?: string;
  punycode?: boolean;
}

export interface UpdateLinkPatch {
  targetUrl?: string;
  /** `null` clears the expiry; `undefined` leaves it untouched. */
  expiresAt?: string | null;
  status?: LinkStatus;
  urlHash?: string;
}

export interface ListLinksOptions {
  limit?: number;
  /** Opaque pagination cursor returned by a previous call. */
  cursor?: string;
}

export interface LinkPage {
  /**
   * Summaries, not full records: the listing is served from a projected index
   * that does not carry `urlHash`. Typing it as `LinkRecord` would promise a
   * field the storage layer cannot deliver.
   */
  items: LinkSummary[];
  cursor?: string;
}

export interface LinkRepository {
  create(input: CreateLinkInput): Promise<LinkRecord>;
  findBySlug(slug: string): Promise<LinkRecord | undefined>;
  /** Returns the slug of an existing identical link for this owner, if any. */
  findSlugByUrlHash(urlHash: string): Promise<string | undefined>;
  update(slug: string, patch: UpdateLinkPatch): Promise<LinkRecord>;
  /** Soft delete — the row survives so the slug is never recycled. */
  softDelete(slug: string): Promise<void>;
  listByOwner(ownerId: string, options?: ListLinksOptions): Promise<LinkPage>;
}

/** A custom slug was requested but is already in use. */
export class SlugUnavailableError extends Error {
  public readonly slug: string;

  public constructor(slug: string) {
    super(`Slug is already in use: ${slug}`);
    this.name = "SlugUnavailableError";
    this.slug = slug;
  }
}

/**
 * Random slug generation collided on every attempt.
 *
 * With a 7-character base62 keyspace this is effectively impossible until the
 * table holds billions of rows, so in practice it means the keyspace is
 * exhausted or something is badly wrong — worth an alert, not a silent retry.
 */
export class SlugAllocationError extends Error {
  public readonly attempts: number;

  public constructor(attempts: number) {
    super(`Could not allocate an unused slug after ${String(attempts)} attempts`);
    this.name = "SlugAllocationError";
    this.attempts = attempts;
  }
}

export class LinkNotFoundError extends Error {
  public readonly slug: string;

  public constructor(slug: string) {
    super(`No link found for slug: ${slug}`);
    this.name = "LinkNotFoundError";
    this.slug = slug;
  }
}
