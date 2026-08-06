/**
 * Fastify application factory.
 *
 * Kept separate from the process entry point so tests can build a server with an
 * arbitrary config and drive it through `app.inject()` without opening a socket.
 */

import { ERROR_STATUS, apiError } from "@urlgen/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";

import type { Config } from "./config.js";
import { createDocumentClient } from "./repositories/dynamo-client.js";
import { DynamoLinkRepository } from "./repositories/dynamo-link-repository.js";
import {
  CloudflareEdgeCache,
  NoopEdgeCache,
  type EdgeCache,
} from "./repositories/edge-cache.js";
import type { LinkRepository } from "./repositories/link-repository.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerLinkRoutes } from "./routes/links.js";
import { SafeBrowsingClient, type UrlSafetyChecker } from "./services/safe-browsing.js";

/**
 * Collaborators the server needs.
 *
 * Injectable so tests can supply an in-memory repository and a stub safety
 * checker; unset entries fall back to the real DynamoDB and Safe Browsing wiring.
 */
export interface ServerDependencies {
  linkRepository: LinkRepository;
  urlSafetyChecker: UrlSafetyChecker;
  edgeCache: EdgeCache;
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
    /* Cloudflare terminates the client connection, so the real client details
       arrive in forwarded headers. */
    trustProxy: true,
    /* Link creation payloads are tiny; refuse anything that clearly is not one. */
    bodyLimit: 16 * 1024,
  });

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

  registerLinkRoutes(app, { config, repository, safetyChecker, edgeCache });
  registerInternalRoutes(app, { config, repository });

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
