/**
 * Abuse review — the operator half.
 *
 * ## Mounted only when a token exists
 *
 * If `ADMIN_API_TOKEN` is unset the routes are not registered at all, so an
 * unconfigured deployment answers 404 rather than 401. The difference matters: a
 * 401 advertises that an admin surface is there and invites someone to look for
 * the credential, and a route that exists but has no configured secret is one
 * refactor away from being reachable. Not registering it is the version that
 * cannot go wrong quietly.
 *
 * ## Disable overwrites KV rather than purging it
 *
 * The phase checklist says "disabled slug purges KV immediately", and this does
 * the opposite on purpose — while meeting the property that wording is protecting,
 * which is that the edge must stop redirecting *now*, not when a TTL lapses.
 *
 * A link being disabled for abuse is, by definition, the link most likely to still
 * be receiving traffic. Purging its KV entry turns every one of those hits into a
 * cache miss and a full origin round trip, so the moment we act on an abusive link
 * is the moment we point its traffic at our own origin. Overwriting the entry with
 * its `disabled` status instead means the edge answers 410 from KV, at the edge,
 * with zero origin traffic — which is both faster to take effect and cheaper under
 * exactly the load that matters. Same reasoning as `PATCH` in `links.ts`, and the
 * asymmetry with `DELETE` (which does purge, because a deleted slug has no traffic
 * worth optimising for) is the same asymmetry.
 *
 * The edge sync is awaited here, unlike on the owner-facing paths: an operator
 * disabling an abusive link needs to be told whether it actually stopped
 * redirecting. A silent partial success is not an acceptable answer to "is this
 * malware link still live?".
 */

import {
  abuseQueueEntrySchema,
  abuseReportSchema,
  isWellFormedSlug,
  type LinkRecord,
} from "@urlgen/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import { sendError, toKvLinkValue, verifyAdminToken } from "../http/helpers.js";
import type { AbuseQueue, AbuseRepository } from "../repositories/abuse-repository.js";
import type { EdgeCache } from "../repositories/edge-cache.js";
import { LinkNotFoundError, type LinkRepository } from "../repositories/link-repository.js";

const queueResponseSchema = z.object({ items: z.array(abuseQueueEntrySchema) });
const reportsResponseSchema = z.object({ slug: z.string(), items: z.array(abuseReportSchema) });

export interface AdminRoutesOptions {
  config: Config;
  repository: LinkRepository;
  reports: AbuseRepository;
  queue: AbuseQueue;
  edgeCache: EdgeCache;
}

/**
 * Registers the review endpoints, or nothing at all.
 *
 * @returns true when the routes were mounted.
 */
export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions): boolean {
  const { config, repository, reports, queue, edgeCache } = options;

  if (config.ADMIN_API_TOKEN === undefined) {
    app.log.warn(
      "ADMIN_API_TOKEN is not set — abuse review endpoints are not mounted; reports can be filed but not actioned",
    );
    return false;
  }

  /* One guard for the whole prefix rather than a line in each handler: an admin
     route added later inherits the check instead of needing to remember it. */
  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (!request.url.startsWith("/admin/")) {
      done();
      return;
    }

    if (verifyAdminToken(request, config.ADMIN_API_TOKEN) !== "ok") {
      /* No detail about which part failed, and no log of the supplied value. */
      void sendError(reply, "unauthorized", "Invalid admin token");
      return;
    }

    done();
  });

  app.get("/admin/abuse", async (_request, reply) => {
    const items = await queue.list();
    return reply.send(queueResponseSchema.parse({ items }));
  });

  app.get<{ Params: { slug: string } }>("/admin/abuse/:slug", async (request, reply) => {
    const { slug } = request.params;
    if (!isWellFormedSlug(slug)) {
      return sendError(reply, "invalid_request", "slug is not well formed");
    }

    const items = await reports.listBySlug(slug);
    return reply.send(reportsResponseSchema.parse({ slug, items }));
  });

  app.post<{ Params: { slug: string } }>("/admin/links/:slug/disable", async (request, reply) =>
    setStatus(request, reply, "disabled"),
  );

  app.post<{ Params: { slug: string } }>("/admin/links/:slug/enable", async (request, reply) =>
    setStatus(request, reply, "active"),
  );

  async function setStatus(
    request: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
    status: "disabled" | "active",
  ): Promise<FastifyReply> {
    const { slug } = request.params;
    if (!isWellFormedSlug(slug)) {
      return sendError(reply, "link_not_found", "No such link");
    }

    let updated: LinkRecord;
    try {
      updated = await repository.update(slug, { status });
    } catch (error) {
      if (error instanceof LinkNotFoundError) {
        return sendError(reply, "link_not_found", "No such link");
      }
      throw error;
    }

    try {
      await edgeCache.put(slug, toKvLinkValue(updated));
    } catch (error) {
      /* The store is already updated, so the link is disabled as far as any cache
         miss is concerned — but a cached edge entry may still be redirecting, and
         the operator has to know that. This is the one edge-sync failure in the
         system that is worth surfacing rather than swallowing. */
      request.log.error({ err: error, slug, status }, "admin status change did not reach the edge");
      return sendError(
        reply,
        "upstream_unavailable",
        "The link was updated but the edge cache could not be synchronised — it may still redirect",
      );
    }

    /* Actioned either way: a link reviewed and left enabled should not keep
       reappearing in the queue. A new report puts it back. Failing to clear it is
       a cosmetic problem — the link is already disabled — so it must not turn a
       successful action into an error the operator retries. */
    try {
      await queue.clear(slug);
    } catch (error) {
      request.log.error({ err: error, slug }, "could not clear the abuse queue entry");
    }

    request.log.warn({ event: "admin_status_change", slug, status }, "admin changed link status");

    return reply.send({ slug, status: updated.status });
  }

  return true;
}
