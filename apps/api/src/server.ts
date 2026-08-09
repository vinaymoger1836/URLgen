/**
 * Fastify application factory.
 *
 * Kept separate from the process entry point so tests can build a server with an
 * arbitrary config and drive it through `app.inject()` without opening a socket.
 */

import { ERROR_STATUS, apiError } from "@urlgen/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";

import { buildClickPipeline, type ClickPipelineOverrides } from "./analytics/pipeline.js";
import type { Config } from "./config.js";
import {
  DynamoAbuseRepository,
  InMemoryAbuseQueue,
  RedisAbuseQueue,
  type AbuseQueue,
  type AbuseRepository,
} from "./repositories/abuse-repository.js";
import {
  NoopAnalyticsCache,
  RedisAnalyticsCache,
  type AnalyticsCache,
} from "./repositories/analytics-cache.js";
import { createAnalyticsStore, type AnalyticsStore } from "./repositories/analytics-store.js";
import { registerCors } from "./http/cors.js";
import { registerSecurityHeaders } from "./http/security-headers.js";
import { createDocumentClient } from "./repositories/dynamo-client.js";
import { DynamoLinkRepository } from "./repositories/dynamo-link-repository.js";
import {
  CloudflareEdgeCache,
  NoopEdgeCache,
  type EdgeCache,
} from "./repositories/edge-cache.js";
import type { LinkRepository } from "./repositories/link-repository.js";
import {
  InMemoryRateLimiter,
  NoopRateLimiter,
  RedisRateLimiter,
  type RateLimiter,
} from "./repositories/rate-limiter.js";
import { registerAbuseRoutes } from "./routes/abuse.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerLinkRoutes } from "./routes/links.js";
import { SafeBrowsingClient, type UrlSafetyChecker } from "./services/safe-browsing.js";

/**
 * Collaborators the server needs.
 *
 * Injectable so tests can supply an in-memory repository and a stub safety
 * checker; unset entries fall back to the real DynamoDB and Safe Browsing wiring.
 */
export interface ServerDependencies extends ClickPipelineOverrides {
  linkRepository: LinkRepository;
  urlSafetyChecker: UrlSafetyChecker;
  edgeCache: EdgeCache;
  analyticsStore: AnalyticsStore;
  analyticsCache: AnalyticsCache;
  rateLimiter: RateLimiter;
  abuseRepository: AbuseRepository;
  abuseQueue: AbuseQueue;
}

/** Headers that may carry a credential and must never reach the logs. */
const REDACTED_HEADERS = [
  'req.headers["authorization"]',
  'req.headers["cookie"]',
  'req.headers["x-internal-token"]',
  'req.headers["cf-connecting-ip"]',
];

export function buildServer(
  config: Config,
  overrides: Partial<ServerDependencies> = {},
): FastifyInstance {
  const app = Fastify({
    logger: buildLoggerOptions(config),
    /*
     * Trust exactly the proxies that were configured, and nothing when none were.
     *
     * `trustProxy: true` — what this was until Phase 5 — believes `X-Forwarded-For`
     * from whoever sent it. Combined with per-IP rate limiting that is not a
     * hardening measure but a bypass: any client that can reach the origin
     * directly sets the header to a fresh address per request and every per-IP
     * limit in the system becomes decorative. An empty list means `request.ip` is
     * the socket peer, which cannot be forged.
     */
    trustProxy: config.TRUSTED_PROXIES.length > 0 ? config.TRUSTED_PROXIES : false,
    /* Link creation payloads are tiny; refuse anything that clearly is not one. */
    bodyLimit: 16 * 1024,
  });

  registerCors(app, config.CORS_ORIGINS);
  registerSecurityHeaders(app, { production: config.NODE_ENV === "production" });

  app.get("/health", () => ({
    status: "ok",
    environment: config.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  const repository =
    overrides.linkRepository ??
    new DynamoLinkRepository({
      client: createDocumentClient(config),
      tableName: config.DYNAMODB_TABLE,
    });

  const safetyChecker =
    overrides.urlSafetyChecker ??
    new SafeBrowsingClient({
      ...(config.SAFE_BROWSING_API_KEY !== undefined
        ? { apiKey: config.SAFE_BROWSING_API_KEY }
        : {}),
      onError: (error) => {
        app.log.warn({ err: error }, "safe browsing lookup failed — allowing the url");
      },
    });

  const edgeCache = overrides.edgeCache ?? buildEdgeCache(config, app);

  const clicks = buildClickPipeline(
    {
      log: app.log,
      onShutdown: (hook) => {
        app.addHook("onClose", hook);
      },
    },
    config,
    overrides,
  );

  const analyticsStore = overrides.analyticsStore ?? buildAnalyticsStore(config, app);
  const analyticsCache = overrides.analyticsCache ?? buildAnalyticsCache(clicks.redis);
  const rateLimiter = overrides.rateLimiter ?? buildRateLimiter(config, clicks.redis, app);
  const abuseRepository =
    overrides.abuseRepository ??
    new DynamoAbuseRepository({
      client: createDocumentClient(config),
      tableName: config.DYNAMODB_TABLE,
    });
  const abuseQueue = overrides.abuseQueue ?? buildAbuseQueue(clicks.redis);

  registerLinkRoutes(app, { config, repository, safetyChecker, edgeCache, rateLimiter });
  registerInternalRoutes(app, { config, repository });
  registerAnalyticsRoutes(app, {
    config,
    repository,
    store: analyticsStore,
    cache: analyticsCache,
  });
  registerIngestRoutes(app, {
    config,
    buffer: clicks.buffer,
    visitorHasher: clicks.visitorHasher,
  });
  registerAbuseRoutes(app, {
    config,
    reports: abuseRepository,
    queue: abuseQueue,
    rateLimiter,
  });
  registerAdminRoutes(app, {
    config,
    repository,
    reports: abuseRepository,
    queue: abuseQueue,
    edgeCache,
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(ERROR_STATUS.not_found)
      .send(apiError("not_found", `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      void reply
        .code(ERROR_STATUS.invalid_request)
        .send(apiError("invalid_request", "Request failed validation"));
      return;
    }

    const status = statusCodeOf(error);
    if (status >= 500) {
      /* Log the detail, return none of it — internals stay internal. */
      request.log.error({ err: error }, "unhandled error");
      void reply
        .code(ERROR_STATUS.internal_error)
        .send(apiError("internal_error", "Something went wrong"));
      return;
    }

    const message = error instanceof Error ? error.message : "Request failed";
    void reply.code(status).send(apiError("invalid_request", message));
  });

  return app;
}

/**
 * The analytics store, closed with the server.
 *
 * A separate ClickHouse client from the flusher's: this one is read-only, has a
 * larger connection pool because a dashboard load fans out into three concurrent
 * queries, and must not be able to exhaust the pool the write path depends on.
 * Nothing connects until the first query, so building it costs a test nothing.
 */
function buildAnalyticsStore(config: Config, app: FastifyInstance): AnalyticsStore {
  const store = createAnalyticsStore({
    url: config.CLICKHOUSE_URL,
    username: config.CLICKHOUSE_USER,
    password: config.CLICKHOUSE_PASSWORD,
    database: config.CLICKHOUSE_DATABASE,
  });

  app.addHook("onClose", async () => {
    await store.close();
  });

  return store;
}

/** Shares the click pipeline's connection, or does without one. */
function buildAnalyticsCache(redis: Redis | undefined): AnalyticsCache {
  return redis === undefined ? new NoopAnalyticsCache() : new RedisAnalyticsCache(redis);
}

/**
 * Picks a limiter, and is loud about the one case that is not what it looks like.
 *
 * `RATE_LIMIT_ENABLED=false` is a deliberate operator choice, so it gets a warning
 * and nothing more. Having no Redis is different: it only happens when the click
 * buffer was injected, which outside a test means the process was assembled in a
 * way nobody designed. The in-memory limiter is correct for one process and wrong
 * for several, so it says so rather than quietly multiplying every limit by the
 * replica count.
 */
function buildRateLimiter(
  config: Config,
  redis: Redis | undefined,
  app: FastifyInstance,
): RateLimiter {
  if (!config.RATE_LIMIT_ENABLED) {
    app.log.warn("RATE_LIMIT_ENABLED=false — link creation and abuse reports are not rate limited");
    return new NoopRateLimiter();
  }

  if (redis === undefined) {
    app.log.warn(
      "no redis connection — falling back to an in-process rate limiter, which only limits this replica",
    );
    return new InMemoryRateLimiter();
  }

  return new RedisRateLimiter({ redis });
}

/** The review queue lives in Redis; without one it is per-process and ephemeral. */
function buildAbuseQueue(redis: Redis | undefined): AbuseQueue {
  return redis === undefined ? new InMemoryAbuseQueue() : new RedisAbuseQueue({ redis });
}

/**
 * Chooses a real edge cache or the no-op, and says which out loud.
 *
 * A silent no-op is the failure mode worth guarding against: everything would
 * look healthy while every edit quietly failed to reach the edge.
 */
function buildEdgeCache(config: Config, app: FastifyInstance): EdgeCache {
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID, CLOUDFLARE_API_TOKEN } = config;

  if (
    CLOUDFLARE_ACCOUNT_ID === undefined ||
    CLOUDFLARE_KV_NAMESPACE_ID === undefined ||
    CLOUDFLARE_API_TOKEN === undefined
  ) {
    app.log.warn(
      "CLOUDFLARE_* not configured — edge cache invalidation is disabled; edits will not reach Workers KV",
    );
    return new NoopEdgeCache();
  }

  return new CloudflareEdgeCache({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    namespaceId: CLOUDFLARE_KV_NAMESPACE_ID,
    apiToken: CLOUDFLARE_API_TOKEN,
  });
}

/**
 * Fastify types a thrown value as `unknown` because a handler can throw anything,
 * not just an `Error`. Narrow rather than assert — a plain `throw "boom"` in a
 * route must still produce a well-formed 500, not a crash inside the error handler.
 */
function statusCodeOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const { statusCode } = error as { statusCode?: unknown };
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) {
      return statusCode;
    }
  }
  return 500;
}

/**
 * Returns a non-optional type on purpose: under `exactOptionalPropertyTypes`, a
 * `| undefined` here makes the `Fastify()` call fall through to its HTTP/2
 * overload, and every downstream type quietly goes wrong.
 */
function buildLoggerOptions(config: Config): NonNullable<FastifyServerOptions["logger"]> {
  if (config.NODE_ENV === "test") {
    return false;
  }

  const base = {
    level: config.LOG_LEVEL,
    redact: { paths: REDACTED_HEADERS, remove: true },
  };

  if (config.NODE_ENV === "development") {
    return {
      ...base,
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
      },
    };
  }

  return base;
}
