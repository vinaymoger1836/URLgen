/**
 * Click ingestion — the origin end of the fire-and-forget path.
 *
 * The Worker has already sent the visitor's 302 by the time this is called, so
 * nothing here is on anyone's critical path. What it must be is *fast to answer*
 * and *impossible to block on*: the Worker holds an outbound connection open until
 * this replies, against the same duration budget the redirect ran under.
 *
 * So the endpoint does the cheap enrichment inline (User-Agent classification,
 * referrer reduction, visitor hashing — all CPU, no I/O) and hands the row to
 * Redis. Everything expensive happens later, in the flusher.
 *
 * ## The IP
 *
 * This is the only place in the system that sees a visitor's address. It arrives
 * in the request body, becomes an HMAC under a salt that rotates nightly, and is
 * gone. It is not logged (Fastify does not log bodies, and the header form is
 * redacted in `server.ts`), not buffered, and has no column to be stored in.
 */

import { clickEventSchema, type ClickEvent } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";

import type { ClickRow } from "../analytics/click-row.js";
import type { Config } from "../config.js";
import { sendError, verifyInternalToken } from "../http/helpers.js";
import type { ClickBuffer } from "../repositories/click-buffer.js";
import { parseUserAgent, referrerHost } from "../services/user-agent.js";
import type { VisitorHasher } from "../services/visitor-hash.js";

export interface IngestRoutesOptions {
  config: Config;
  buffer: ClickBuffer;
  visitorHasher: VisitorHasher;
}

export function registerIngestRoutes(app: FastifyInstance, options: IngestRoutesOptions): void {
  const { config, buffer, visitorHasher } = options;

  app.post("/ingest/click", async (request, reply) => {
    const auth = verifyInternalToken(request, config.INTERNAL_API_TOKEN);
    if (auth === "not-configured") {
      request.log.error("INTERNAL_API_TOKEN is not configured — refusing click ingest");
      return sendError(reply, "upstream_unavailable", "Click ingestion is not configured");
    }
    if (auth === "invalid") {
      /* Unauthenticated writes here would let anyone forge traffic into another
         owner's dashboard, which is a data-integrity problem, not a nuisance. */
      return sendError(reply, "unauthorized", "Invalid internal token");
    }

    const parsed = clickEventSchema.safeParse(request.body);
    if (!parsed.success) {
      /* The two sides share this schema, so a rejection means a version skew, not
         a bad client. Log the field names — never the value, which may be the IP. */
      request.log.warn(
        { fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
        "rejected a malformed click event",
      );
      return sendError(reply, "invalid_request", "Click event failed validation");
    }

    const row = enrich(parsed.data, visitorHasher);

    let outcome: string;
    try {
      outcome = await buffer.push(row);
    } catch (error) {
      /* Redis is down. Say so with a 503 so the Worker's log records it and Phase 6
         can alert on it — silently returning 202 would make a broken pipeline look
         like a link nobody clicked. */
      request.log.error({ err: error, slug: row.slug }, "could not buffer a click");
      return sendError(reply, "upstream_unavailable", "Click buffer is unavailable");
    }

    if (outcome === "dropped") {
      /* Backpressure, not an error: the buffer is full and the alternative is
         letting Redis grow until it takes the origin — and the redirects — down.
         Still a 202, because the Worker cannot do anything useful with a retry. */
      request.log.warn({ slug: row.slug }, "click buffer is full — dropping the click");
    }

    return reply.code(202).send({ status: outcome });
  });
}

/**
 * Turns the edge's raw facts into the row the analytics table stores.
 *
 * Every field is given a value — `""` for the ones Cloudflare could not determine.
 * ClickHouse has no nulls in these columns by design: a `LowCardinality(String)`
 * with an empty value costs one dictionary entry, while a Nullable column costs a
 * separate null map on every read for information a dashboard would render as
 * "unknown" anyway.
 */
function enrich(event: ClickEvent, visitorHasher: VisitorHasher): ClickRow {
  const agent = parseUserAgent(event.userAgent);

  return {
    eventId: event.id,
    slug: event.slug,
    ts: event.ts,
    country: event.country ?? "",
    city: event.city ?? "",
    timezone: event.timezone ?? "",
    colo: event.colo ?? "",
    deviceType: agent.deviceType,
    browser: agent.browser,
    os: agent.os,
    referrerHost: referrerHost(event.referrer),
    /* The last moment the IP exists. `hash` takes it, and nothing downstream of
       this call has any way to get it back. */
    visitorHash: visitorHasher.hash({
      slug: event.slug,
      ip: event.ip,
      userAgent: event.userAgent,
      eventId: event.id,
      ts: event.ts,
    }),
  };
}
