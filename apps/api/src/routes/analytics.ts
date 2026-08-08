/**
 * The dashboard's read API.
 *
 * Two endpoints: everything about one link, and click totals for the caller's whole
 * link list. Both are owner-scoped, and the scoping is done against DynamoDB — the
 * source of truth for who owns what — before ClickHouse is touched at all. Analytics
 * is where an IDOR is most tempting to write, because the click rows themselves
 * carry no owner: the only thing standing between a guessed slug and someone else's
 * traffic numbers is this check, so it is the same one the link routes use and it
 * returns the same 404 for "no such link" as for "not yours".
 */

import {
  analyticsQuerySchema,
  analyticsResponseSchema,
  analyticsTotalsResponseSchema,
  isWellFormedSlug,
  resolveAnalyticsWindow,
  type AnalyticsResponse,
  type AnalyticsTotalsResponse,
  type AnalyticsWindow,
} from "@urlgen/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { fillSeries } from "../analytics/series.js";
import type { Config } from "../config.js";
import { resolveOwnerId, sendError } from "../http/helpers.js";
import {
  analyticsCacheKey,
  analyticsTotalsCacheKey,
  quantizeClock,
  type AnalyticsCache,
} from "../repositories/analytics-cache.js";
import type { AnalyticsStore } from "../repositories/analytics-store.js";
import type { LinkRepository } from "../repositories/link-repository.js";

/** How many of an owner's links one totals call will cover. */
const TOTALS_LINK_LIMIT = 100;

export interface AnalyticsRoutesOptions {
  config: Config;
  repository: LinkRepository;
  store: AnalyticsStore;
  cache: AnalyticsCache;
  /** Injectable so tests can pin the quantized window. */
  now?: () => number;
}

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  options: AnalyticsRoutesOptions,
): void {
  const { config, repository, store, cache } = options;
  const clock = options.now ?? Date.now;
  const ttlSeconds = config.ANALYTICS_CACHE_TTL_SECONDS;

  app.get<{ Params: { slug: string }; Querystring: Record<string, string> }>(
    "/api/analytics/:slug",
    async (request, reply) => {
      const query = analyticsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendError(
          reply,
          "invalid_request",
          query.error.issues[0]?.message ?? "Invalid query",
        );
      }

      const { slug } = request.params;
      if (!isWellFormedSlug(slug)) {
        return sendError(reply, "link_not_found", "No such link");
      }

      const record = await repository.findBySlug(slug);
      if (record?.ownerId !== resolveOwnerId(request) || record.status === "deleted") {
        /* Identical to a genuinely missing slug, so the endpoint cannot be used to
           discover which slugs exist or who owns them. */
        return sendError(reply, "link_not_found", "No such link");
      }

      const window = resolveAnalyticsWindow(query.data, quantizeClock(clock(), ttlSeconds));
      const key = analyticsCacheKey(slug, window);

      const cached = await readCache(request, cache, key);
      if (cached !== undefined) {
        return sendJson(reply, cached);
      }

      let body: AnalyticsResponse;
      try {
        const data = await store.fetch(slug, window);
        body = analyticsResponseSchema.parse({
          slug,
          window: describeWindow(window),
          granularity: window.granularity,
          totals: data.totals,
          series: fillSeries(data.series, window).map((point) => ({
            ts: new Date(point.tsMs).toISOString(),
            clicks: point.clicks,
            visitors: point.visitors,
          })),
          breakdowns: data.breakdowns,
          generatedAt: new Date(window.toMs).toISOString(),
        } satisfies AnalyticsResponse);
      } catch (error) {
        request.log.error({ err: error, slug }, "analytics query failed");
        return sendError(reply, "upstream_unavailable", "Analytics is temporarily unavailable");
      }

      const payload = JSON.stringify(body);
      await writeCache(request, cache, key, payload, ttlSeconds);
      return sendJson(reply, payload);
    },
  );

  app.get<{ Querystring: Record<string, string> }>("/api/analytics", async (request, reply) => {
    const query = analyticsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, "invalid_request", query.error.issues[0]?.message ?? "Invalid query");
    }

    const ownerId = resolveOwnerId(request);
    const window = resolveAnalyticsWindow(query.data, quantizeClock(clock(), ttlSeconds));
    const key = analyticsTotalsCacheKey(ownerId, window);

    const cached = await readCache(request, cache, key);
    if (cached !== undefined) {
      return sendJson(reply, cached);
    }

    const page = await repository.listByOwner(ownerId, { limit: TOTALS_LINK_LIMIT });
    const slugs = page.items
      .filter((item) => item.status !== "deleted")
      .map((item) => item.slug);

    let body: AnalyticsTotalsResponse;
    try {
      const totals = await store.totalsBySlug(slugs, window);
      body = analyticsTotalsResponseSchema.parse({
        window: describeWindow(window),
        /* Every requested slug appears, with zeroes where there was no traffic: the
           dashboard renders one row per link and would otherwise have to invent the
           missing ones itself. */
        items: slugs.map((slug) => ({
          slug,
          clicks: totals.get(slug)?.clicks ?? 0,
          visitors: totals.get(slug)?.visitors ?? 0,
        })),
      } satisfies AnalyticsTotalsResponse);
    } catch (error) {
      request.log.error({ err: error, ownerId }, "analytics totals query failed");
      return sendError(reply, "upstream_unavailable", "Analytics is temporarily unavailable");
    }

    const payload = JSON.stringify(body);
    await writeCache(request, cache, key, payload, ttlSeconds);
    return sendJson(reply, payload);
  });
}

/** The part of the resolved window the client is told about. */
function describeWindow(window: AnalyticsWindow): AnalyticsResponse["window"] {
  return {
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
    timeZone: window.timeZone,
    /* Surfaced so the dashboard can say a long range is aggregated from UTC-bucketed
       rollups rather than presenting it as exact to the minute. */
    source: window.source,
  };
}

/**
 * Sends a body that is already JSON.
 *
 * A cache hit is served exactly as it was stored — no parse, no re-serialize, and
 * no chance of the two paths producing different bytes.
 */
function sendJson(reply: FastifyReply, payload: string): FastifyReply {
  return reply.type("application/json; charset=utf-8").send(payload);
}

/**
 * A cache read that cannot fail the request.
 *
 * Redis being down means slower analytics, not broken analytics — the store can
 * answer without it. Failing here would take the dashboard down for a dependency
 * that exists purely to make it faster.
 */
async function readCache(
  request: FastifyRequest,
  cache: AnalyticsCache,
  key: string,
): Promise<string | undefined> {
  try {
    return await cache.get(key);
  } catch (error) {
    request.log.warn({ err: error }, "analytics cache read failed");
    return undefined;
  }
}

async function writeCache(
  request: FastifyRequest,
  cache: AnalyticsCache,
  key: string,
  payload: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await cache.set(key, payload, ttlSeconds);
  } catch (error) {
    request.log.warn({ err: error }, "analytics cache write failed");
  }
}
