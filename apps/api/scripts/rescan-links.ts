/**
 * Re-checks existing links against Safe Browsing.
 *
 * Runs to completion and exits — it is a scheduled job, not a service. That is
 * deliberate: a sweep that lives inside the API would be one more thing competing
 * for the request path's Redis and DynamoDB capacity on a box where both are the
 * scarce resource, and it would run once per replica.
 *
 *   pnpm rescan
 *
 * Exits non-zero when the sweep could not run at all, so a scheduler can alert on
 * it. Individual link failures are counted, logged and do not fail the run — a
 * single unreachable destination is not a reason to skip the rest.
 */

import { pino } from "pino";

import { ConfigError, loadConfig } from "../src/config.js";
import { createDocumentClient } from "../src/repositories/dynamo-client.js";
import { DynamoLinkRepository } from "../src/repositories/dynamo-link-repository.js";
import { CloudflareEdgeCache, NoopEdgeCache } from "../src/repositories/edge-cache.js";
import { SafeBrowsingClient } from "../src/services/safe-browsing.js";
import { rescanLinks } from "../src/services/rescan.js";

async function main(): Promise<void> {
  const config = (() => {
    try {
      return loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  })();

  const log = pino({
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss Z" } } }
      : {}),
  });

  if (config.SAFE_BROWSING_API_KEY === undefined) {
    /* Without a key every verdict is `unknown`, so the sweep would walk the whole
       table, write a fresh `unknown` onto every row, and disable nothing. That is
       not a degraded run, it is a pointless one that also spends write capacity. */
    log.error("SAFE_BROWSING_API_KEY is not set — nothing to re-scan against");
    process.exit(1);
  }

  const edgeCache =
    config.CLOUDFLARE_ACCOUNT_ID !== undefined &&
    config.CLOUDFLARE_KV_NAMESPACE_ID !== undefined &&
    config.CLOUDFLARE_API_TOKEN !== undefined
      ? new CloudflareEdgeCache({
          accountId: config.CLOUDFLARE_ACCOUNT_ID,
          namespaceId: config.CLOUDFLARE_KV_NAMESPACE_ID,
          apiToken: config.CLOUDFLARE_API_TOKEN,
        })
      : new NoopEdgeCache();

  if (edgeCache instanceof NoopEdgeCache) {
    log.warn(
      "CLOUDFLARE_* not configured — a link disabled by this sweep will not be purged from the edge until its backstop TTL lapses",
    );
  }

  const summary = await rescanLinks({
    repository: new DynamoLinkRepository({
      client: createDocumentClient(config),
      tableName: config.DYNAMODB_TABLE,
    }),
    checker: new SafeBrowsingClient({
      apiKey: config.SAFE_BROWSING_API_KEY,
      onError: (error) => {
        log.warn({ err: error }, "safe browsing lookup failed — leaving the link alone");
      },
    }),
    edgeCache,
    logger: log,
  });

  /* Non-zero when links were disabled, so a scheduler surfaces the run rather
     than burying an incident in a log nobody reads. Errors alone do not fail the
     run — they are already counted in the summary. */
  process.exit(summary.disabled > 0 ? 2 : 0);
}

void main();
