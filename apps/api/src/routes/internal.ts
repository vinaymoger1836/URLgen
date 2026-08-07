/**
 * The edge worker's cache-miss path.
 *
 * Returns the compact KV blob (`kvLinkValueSchema`) rather than the full record,
 * so the Worker can write the response straight into KV without reshaping it —
 * and so nothing internal (owner, dedup hash) is exposed at the edge.
 *
 * Not under `/api` on purpose: this is a service-to-service endpoint and should be
 * firewalled or routed separately from the public surface.
 */

import { isWellFormedSlug } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";
import { isExpired, sendError, toKvLinkValue, verifyInternalToken } from "../http/helpers.js";
import type { LinkRepository } from "../repositories/link-repository.js";

export interface InternalRoutesOptions {
  config: Config;
  repository: LinkRepository;
}

export function registerInternalRoutes(app: FastifyInstance, options: InternalRoutesOptions): void {
  const { config, repository } = options;

  app.get<{ Params: { slug: string } }>("/internal/resolve/:slug", async (request, reply) => {
    const auth = verifyInternalToken(request, config.INTERNAL_API_TOKEN);
    if (auth === "not-configured") {
      /* Refuse rather than serve unauthenticated: an unset token in production is
         a deployment fault, and this endpoint bypasses all public rate limiting. */
      request.log.error("INTERNAL_API_TOKEN is not configured — refusing internal resolve");
      return sendError(reply, "upstream_unavailable", "Internal resolution is not configured");
    }
    if (auth === "invalid") {
      return sendError(reply, "unauthorized", "Invalid internal token");
    }

    const { slug } = request.params;
    if (!isWellFormedSlug(slug)) {
      return sendError(reply, "link_not_found", "No such link");
    }

    const record = await repository.findBySlug(slug);
    if (record === undefined || record.status === "deleted") {
      return sendError(reply, "link_not_found", "No such link");
    }
    if (record.status === "disabled") {
      return sendError(reply, "link_disabled", "This link has been disabled");
    }
    if (isExpired(record)) {
      return sendError(reply, "link_expired", "This link has expired");
    }

    return reply.header("cache-control", "no-store").code(200).send(toKvLinkValue(record));
  });
}
