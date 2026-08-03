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
  "AWS_SECRET_ACCESS_KEY",
  "CLICKHOUSE_PASSWORD",
  "INTERNAL_API_TOKEN",
  "SAFE_BROWSING_API_KEY",
  "VISITOR_HASH_SALT",
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

    SAFE_BROWSING_API_KEY: z.string().min(1).optional(),
    VISITOR_HASH_SALT: z.string().min(16).optional(),
    INTERNAL_API_TOKEN: z.string().min(32).optional(),

    SHORT_DOMAIN: z.string().min(1).default("localhost:8787"),
  })
  .superRefine((env, ctx) => {
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
