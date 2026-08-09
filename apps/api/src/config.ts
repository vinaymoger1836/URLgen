/**
 * Environment configuration.
 *
 * This is the only place in the API that reads `process.env`. Everything else
 * takes a `Config`, which keeps secrets out of arbitrary modules and makes the
 * whole surface testable without mutating global state.
 *
 * The process fails fast on startup rather than discovering a missing secret on
 * the first request that needs it.
 */

import { ALLOWED_PROTOCOLS, parseUrl } from "@urlgen/shared";
import { z } from "zod";

/** Keys whose values must never be logged, echoed in an error, or serialized. */
const SECRET_KEYS = [
  "ADMIN_API_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "CLICKHOUSE_PASSWORD",
  "CLOUDFLARE_API_TOKEN",
  "INTERNAL_API_TOKEN",
  "SAFE_BROWSING_API_KEY",
  "VISITOR_HASH_SALT",
] as const;

/**
 * Cache invalidation needs all three or none.
 *
 * Two out of three is the dangerous state: the origin would look configured,
 * every write would fail, and the edge would keep serving a target the owner
 * thinks they already changed.
 */
const CLOUDFLARE_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
] as const;

/**
 * An http(s) endpoint.
 *
 * The protocol check is not redundant: `new URL("localhost:8000")` parses
 * happily, treating `localhost:` as the scheme and `8000` as the path. Requiring
 * http/https is what actually rejects a host:port string written without a scheme.
 */
const httpEndpoint = (label: string) =>
  z.string().refine((value) => {
    const url = parseUrl(value);
    return url !== undefined && ALLOWED_PROTOCOLS.includes(url.protocol);
  }, `${label} must be an absolute http(s) URL`);

/**
 * A boolean written the way a `.env` file or a Dockerfile writes one.
 *
 * Deliberately strict: `Boolean("false")` is `true`, and a flag that silently
 * means the opposite of what the file says is the worst kind of config bug.
 */
const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/**
 * An origin, in the sense the `Origin` header uses: scheme, host, optional port,
 * and nothing else. A trailing path is the giveaway that someone pasted a URL —
 * and it would never match the header, so every request would be silently refused.
 */
function isOrigin(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== undefined &&
    ALLOWED_PROTOCOLS.includes(url.protocol) &&
    url.hostname !== "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    /* `new URL` normalizes away a missing path, so compare against what the browser
       will actually send. */
    value.replace(/\/$/, "") === url.origin
  );
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    HOST: z.string().min(1).default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    AWS_REGION: z.string().min(1).default("ap-south-1"),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    DYNAMODB_TABLE: z.string().min(1).default("urlgen-links"),
    /** Set to a local endpoint to talk to DynamoDB Local instead of AWS. */
    DYNAMODB_ENDPOINT: httpEndpoint("DYNAMODB_ENDPOINT").optional(),

    REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
    CLICKHOUSE_URL: httpEndpoint("CLICKHOUSE_URL").default("http://127.0.0.1:8123"),
    CLICKHOUSE_USER: z.string().min(1).default("default"),
    CLICKHOUSE_PASSWORD: z.string().default(""),
    CLICKHOUSE_DATABASE: z.string().min(1).default("urlgen"),

    /* Click pipeline. Defaults are sized for the free tier: the buffer cap is what
       a t3.micro's Redis can hold without the OOM killer taking the whole box, and
       the batch size keeps ClickHouse inserts in the thousands-of-rows range it
       wants rather than the one-row-per-insert it hates. */
    CLICK_BUFFER_MAX: z.coerce.number().int().min(100).max(5_000_000).default(100_000),
    CLICK_FLUSH_BATCH_SIZE: z.coerce.number().int().min(1).max(100_000).default(1_000),
    CLICK_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
    /* Exactly one process should flush. Off by default in the API so a multi-replica
       deploy does not start N flushers; `pnpm consumer` turns it on for the one that
       should. Local dev sets it in `.env` to keep everything in a single process. */
    CLICK_CONSUMER_ENABLED: booleanFlag.default(false),

    /* Analytics query cache. Also the tick the request clock is floored to, so an
       answer is at most one tick plus this stale — well inside the flusher's own
       latency, which is what actually bounds how fresh a click can be. Zero turns
       storage off without changing any other behaviour. */
    ANALYTICS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(300).default(15),

    /* Rate limiting. The per-IP window is short and tight because a burst from one
       address is what abuse looks like; the per-owner window is long and loose
       because a legitimate owner shortening a batch of links should not trip it in
       the first minute and then be locked out for the rest of the hour. Both must
       pass, so the effective limit is whichever runs out first. */
    RATE_LIMIT_ENABLED: booleanFlag.default(true),
    RATE_LIMIT_CREATE_PER_IP: z.coerce.number().int().min(1).max(100_000).default(20),
    RATE_LIMIT_CREATE_PER_IP_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(60),
    RATE_LIMIT_CREATE_PER_OWNER: z.coerce.number().int().min(1).max(100_000).default(100),
    RATE_LIMIT_CREATE_PER_OWNER_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(3_600),
    RATE_LIMIT_REPORT_PER_IP: z.coerce.number().int().min(1).max(100_000).default(10),
    RATE_LIMIT_REPORT_PER_IP_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86_400)
      .default(300),

    /*
     * Proxies whose `X-Forwarded-For` may be believed, as IPs or CIDRs.
     *
     * Unset means trust nothing, and that is the safe default: with blanket proxy
     * trust, any client that can reach the origin directly picks its own client IP
     * by setting a header, and every per-IP limit below becomes decorative. In
     * production this is the list of Cloudflare's ranges — or, better, the origin
     * is only reachable through Cloudflare at all and this stays empty.
     */
    TRUSTED_PROXIES: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined
          ? []
          : value
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
      ),

    SAFE_BROWSING_API_KEY: z.string().min(1).optional(),
    VISITOR_HASH_SALT: z.string().min(16).optional(),
    INTERNAL_API_TOKEN: z.string().min(32).optional(),
    /* Authenticates the abuse-review endpoints. Absent means they are not mounted
       at all — an admin surface with no credential configured is worse than no
       admin surface, because it looks like it is protected. */
    ADMIN_API_TOKEN: z.string().min(32).optional(),

    /* Edge cache invalidation. Absent locally: `wrangler dev` simulates its own
       KV namespace, so there is nothing at api.cloudflare.com to invalidate. */
    CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
    CLOUDFLARE_KV_NAMESPACE_ID: z.string().min(1).optional(),
    CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),

    SHORT_DOMAIN: z.string().min(1).default("localhost:8787"),

    /* Origins the dashboard may be served from. Comma-separated, exact matches
       only — no wildcards and no pattern matching, because every CORS bypass
       starts as a pattern that matched more than it was meant to. */
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      )
      .refine(
        (origins) => origins.every(isOrigin),
        "CORS_ORIGINS must be a comma-separated list of scheme://host[:port] origins",
      )
      /* Canonicalized after validation, because the comparison against the `Origin`
         header is an exact string match: `https://x.test/` passes the check above
         and would then never match anything a browser sends. */
      .transform((origins) => origins.map((origin) => parseUrl(origin)?.origin ?? origin)),
  })
  .superRefine((env, ctx) => {
    const cloudflareSet = CLOUDFLARE_KEYS.filter((key) => env[key] !== undefined);
    if (cloudflareSet.length > 0 && cloudflareSet.length < CLOUDFLARE_KEYS.length) {
      for (const key of CLOUDFLARE_KEYS) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when any other CLOUDFLARE_* variable is set`,
          });
        }
      }
    }

    if (env.NODE_ENV !== "production") {
      return;
    }
    // Locally these can fall back to defaults; in production a missing secret is
    // a deployment error and must stop the process.
    for (const key of ["INTERNAL_API_TOKEN", "VISITOR_HASH_SALT"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when NODE_ENV=production`,
        });
      }
    }
  });

export type Config = z.infer<typeof envSchema>;

/** Thrown when the environment is unusable. Carries key names only — never values. */
export class ConfigError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Parses and validates the environment.
 *
 * @throws {ConfigError} listing every problem at once, so a misconfigured deploy
 * is fixed in a single pass instead of one restart per missing variable.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(withoutBlanks(source));

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join(".");
      return key.length > 0 ? `${key}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(issues);
  }

  return result.data;
}

/**
 * Treats a blank value as an unset variable.
 *
 * A `.env` file has no way to say "absent" — the convention is to leave the value
 * empty, and `.env.example` ships blank AWS credential lines on purpose because
 * DynamoDB Local needs none. Without this, merely loading that template would turn
 * every optional secret into a hard validation failure. Blanks are dropped rather
 * than coerced so `.optional()` and `.default()` still mean what they say, and a
 * blank required secret in production still fails — with "is required" instead of
 * a confusing length complaint.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * A copy of the config that is safe to log: every secret is replaced by a marker
 * showing only whether it was set.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...config };

  /* Iterate the secret list, not the config's own keys: Zod omits absent optional
     keys entirely, so an unset secret would otherwise never be visited — and would
     silently pass through as "not a secret" if it were later populated. */
  for (const key of SECRET_KEYS) {
    safe[key] = config[key] === undefined ? "<unset>" : "<redacted>";
  }

  return safe;
}
