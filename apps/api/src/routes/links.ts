/** Link CRUD. The write path — the read path lives at the edge. */

import {
  assessUrlSafety,
  createLinkRequestSchema,
  isWellFormedSlug,
  linkApiResponseSchema,
  updateLinkRequestSchema,
  urlDedupHash,
  type ErrorCode,
  type LinkApiResponse,
  type LinkRecord,
  type LinkSummary,
  type UrlSafetyIssue,
  type UrlSafetyResult,
} from "@urlgen/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import {
  isExpired,
  resolveOwnerId,
  sendError,
  shortUrlFor,
  toKvLinkValue,
} from "../http/helpers.js";
import type { EdgeCache } from "../repositories/edge-cache.js";
import {
  LinkNotFoundError,
  SlugAllocationError,
  SlugUnavailableError,
  type LinkRepository,
} from "../repositories/link-repository.js";
import type { UrlSafetyChecker } from "../services/safe-browsing.js";

/** Maps a structural safety issue onto the error code the client sees. */
const ISSUE_TO_ERROR: Readonly<Record<UrlSafetyIssue, ErrorCode>> = {
  malformed: "invalid_url",
  "missing-hostname": "invalid_url",
  "embedded-credentials": "invalid_url",
  "unsupported-protocol": "unsupported_protocol",
  "too-long": "url_too_long",
  "non-public-host": "unsafe_url",
  "self-referential": "unsafe_url",
};

const ISSUE_MESSAGE: Readonly<Record<UrlSafetyIssue, string>> = {
  malformed: "The URL could not be parsed",
  "missing-hostname": "The URL has no hostname",
  "embedded-credentials": "The URL must not embed credentials",
  "unsupported-protocol": "Only http and https URLs can be shortened",
  "too-long": "The URL is too long",
  "non-public-host": "That destination is not publicly routable and cannot be shortened",
  "self-referential": "That URL already points at this shortener",
};

export interface LinkRoutesOptions {
  config: Config;
  repository: LinkRepository;
  safetyChecker: UrlSafetyChecker;
  edgeCache: EdgeCache;
}

export function registerLinkRoutes(app: FastifyInstance, options: LinkRoutesOptions): void {
  const { config, repository, safetyChecker, edgeCache } = options;
  const ownHosts = [config.SHORT_DOMAIN];

  app.post("/api/links", async (request, reply) => {
    /* The URL is assessed BEFORE the request schema runs. Both layers can reject a
       `javascript:` URL, but only the assessment knows *why*; letting Zod fail first
       would collapse every URL problem into a generic `invalid_request`. Zod stays
       the authority on the rest of the request shape. */
    const assessment = assessRawUrl(request.body, ownHosts);
    if (assessment !== undefined && !assessment.safe) {
      const issue = assessment.issues[0];
      if (issue !== undefined) {
        return sendError(reply, ISSUE_TO_ERROR[issue], ISSUE_MESSAGE[issue]);
      }
    }

    const parsed = createLinkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid body");
    }
    const { url, customSlug, expiresAt } = parsed.data;

    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
      return sendError(reply, "invalid_request", "expiresAt must be in the future");
    }

    if ((await safetyChecker.check(url)) === "malicious") {
      request.log.warn({ host: assessment?.hostname }, "safe browsing rejected a target url");
      return sendError(reply, "unsafe_url", "That destination was flagged as unsafe");
    }

    const ownerId = resolveOwnerId(request);
    const urlHash = await urlDedupHash(url, ownerId);

    /* Deduplicate before allocating: the same owner shortening the same URL twice
       gets the same slug back rather than a second row and a second slug. */
    const existingSlug = await repository.findSlugByUrlHash(urlHash);
    if (existingSlug !== undefined) {
      const existing = await repository.findBySlug(existingSlug);
      if (existing?.status === "active" && !isExpired(existing)) {
        return reply.code(200).send(toResponse(existing, config.SHORT_DOMAIN, true));
      }
    }

    try {
      const record = await repository.create({
        targetUrl: url,
        ownerId,
        urlHash,
        ...(customSlug !== undefined ? { customSlug } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(assessment?.punycode === true ? { punycode: true } : {}),
      });

      /* Warm the edge on create rather than waiting for the first visitor to take
         a full origin round trip. A shortened link is usually shared immediately
         after it is made, so the first click is the one most worth having fast. */
      await syncEdgeCache(request, "warm", record.slug, () =>
        edgeCache.put(record.slug, toKvLinkValue(record)),
      );

      return reply.code(201).send(toResponse(record, config.SHORT_DOMAIN, false));
    } catch (error) {
      if (error instanceof SlugUnavailableError) {
        return sendError(reply, "slug_taken", "That custom slug is already in use");
      }
      if (error instanceof SlugAllocationError) {
        request.log.error({ err: error }, "slug allocation exhausted its retries");
        return sendError(reply, "internal_error", "Could not allocate a slug");
      }
      throw error;
    }
  });

  app.get<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const record = await loadOwnedLink(repository, request.params.slug, resolveOwnerId(request));
    if (record === undefined) {
      return sendError(reply, "link_not_found", "No such link");
    }
    return reply.send(toResponse(record, config.SHORT_DOMAIN));
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/api/links",
    async (request, reply) => {
      const rawLimit = request.query.limit;
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        return sendError(reply, "invalid_request", "limit must be an integer between 1 and 100");
      }

      const page = await repository.listByOwner(resolveOwnerId(request), {
        ...(limit !== undefined ? { limit } : {}),
        ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
      });

      return reply.send({
        items: page.items
          .filter((item) => item.status !== "deleted")
          .map((item) => toResponse(item, config.SHORT_DOMAIN)),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      });
    },
  );

  app.patch<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const parsed = updateLinkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid body");
    }

    const ownerId = resolveOwnerId(request);
    const existing = await loadOwnedLink(repository, request.params.slug, ownerId);
    if (existing === undefined) {
      return sendError(reply, "link_not_found", "No such link");
    }

    const patch: Parameters<LinkRepository["update"]>[1] = {};

    if (parsed.data.url !== undefined) {
      const assessment = assessUrlSafety(parsed.data.url, { ownHosts });
      if (!assessment.safe) {
        const issue = assessment.issues[0];
        if (issue !== undefined) {
          return sendError(reply, ISSUE_TO_ERROR[issue], ISSUE_MESSAGE[issue]);
        }
      }
      if ((await safetyChecker.check(parsed.data.url)) === "malicious") {
        return sendError(reply, "unsafe_url", "That destination was flagged as unsafe");
      }
      patch.targetUrl = parsed.data.url;
      /* The dedup key must follow the URL, or the index would keep pointing at the
         old destination and a later create would dedup against a stale entry. */
      patch.urlHash = await urlDedupHash(parsed.data.url, ownerId);
    }

    if (parsed.data.expiresAt !== undefined) {
      if (parsed.data.expiresAt !== null && Date.parse(parsed.data.expiresAt) <= Date.now()) {
        return sendError(reply, "invalid_request", "expiresAt must be in the future");
      }
      patch.expiresAt = parsed.data.expiresAt;
    }

    if (parsed.data.status !== undefined) {
      patch.status = parsed.data.status;
    }

    try {
      const updated = await repository.update(request.params.slug, patch);

      /* Overwrite rather than delete. A disabled link overwritten with its new
         status keeps being answered at the edge — a 410 straight from KV, with no
         origin traffic at all, which is exactly what an abused link needs.
         Deleting would turn every hit on it into a cache miss and a round trip. */
      await syncEdgeCache(request, "overwrite", updated.slug, () =>
        edgeCache.put(updated.slug, toKvLinkValue(updated)),
      );

      return reply.send(toResponse(updated, config.SHORT_DOMAIN));
    } catch (error) {
      if (error instanceof LinkNotFoundError) {
        return sendError(reply, "link_not_found", "No such link");
      }
      throw error;
    }
  });

  app.delete<{ Params: { slug: string } }>("/api/links/:slug", async (request, reply) => {
    const existing = await loadOwnedLink(repository, request.params.slug, resolveOwnerId(request));
    if (existing === undefined) {
      /* Idempotent: deleting an already-deleted link is not an error, but we do
         not confirm the existence of another owner's slug either. */
      return reply.code(204).send();
    }

    await repository.softDelete(request.params.slug);

    /* Purge, not overwrite: a deleted slug is never recycled, so nothing at the
       edge is worth keeping. The miss path answers the rare late visitor. */
    await syncEdgeCache(request, "purge", request.params.slug, () =>
      edgeCache.purge(request.params.slug),
    );

    return reply.code(204).send();
  });
}

/**
 * Runs an edge cache operation without letting it fail the request.
 *
 * The source of truth has already changed by the time this runs, so failing here
 * would tell the owner their edit did not happen when it did — and they would
 * retry into a no-op. A stale edge entry is the lesser problem, it is bounded by
 * the KV backstop TTL, and it is the kind of thing an operator needs an alert
 * for rather than an error the caller can do anything about.
 */
async function syncEdgeCache(
  request: FastifyRequest,
  operation: "warm" | "overwrite" | "purge",
  slug: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    request.log.error({ err: error, slug, operation }, "edge cache sync failed");
  }
}

/**
 * Assesses the `url` field of an unvalidated request body.
 *
 * Runs before schema parsing so URL problems get their specific error code rather
 * than being flattened into a generic validation failure. Returns `undefined` when
 * the body has no string `url` — that is the schema's problem to report, not ours.
 */
function assessRawUrl(body: unknown, ownHosts: readonly string[]): UrlSafetyResult | undefined {
  if (typeof body !== "object" || body === null || !("url" in body)) {
    return undefined;
  }
  const { url } = body as { url?: unknown };
  return typeof url === "string" ? assessUrlSafety(url, { ownHosts }) : undefined;
}

/**
 * Loads a link only if the caller owns it.
 *
 * Returns `undefined` for both "no such slug" and "someone else's slug" so the API
 * cannot be used to probe which slugs exist.
 */
async function loadOwnedLink(
  repository: LinkRepository,
  slug: string,
  ownerId: string,
): Promise<LinkRecord | undefined> {
  if (!isWellFormedSlug(slug)) {
    return undefined;
  }
  const record = await repository.findBySlug(slug);
  if (record?.ownerId !== ownerId || record.status === "deleted") {
    return undefined;
  }
  return record;
}

/**
 * Strips internal bookkeeping and adds what only the API knows.
 *
 * Takes a summary too, because a listing is served from a projected index and
 * never has `urlHash` to begin with. Parsing rather than destructuring means the
 * strip is enforced by the schema: any future internal field is dropped unless it
 * is explicitly added to the response shape — and the dashboard parses the same
 * schema on the way in, so a change on either side has to be made on both.
 */
function toResponse(
  record: LinkRecord | LinkSummary,
  shortDomain: string,
  deduplicated?: boolean,
): LinkApiResponse {
  return linkApiResponseSchema.parse({
    ...record,
    shortUrl: shortUrlFor(shortDomain, record.slug),
    ...(deduplicated !== undefined ? { deduplicated } : {}),
  });
}
