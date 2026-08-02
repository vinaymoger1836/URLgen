import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, redactConfig } from "./config.js";

const PRODUCTION_ENV = {
  NODE_ENV: "production",
  INTERNAL_API_TOKEN: "x".repeat(40),
  VISITOR_HASH_SALT: "y".repeat(24),
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("applies defaults so a bare development environment starts", () => {
    const config = loadConfig({});

    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(3001);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DYNAMODB_TABLE).toBe("urlgen-links");
    expect(config.REDIS_URL).toBe("redis://127.0.0.1:6379");
  });

  it("coerces PORT from a string, because every environment variable is a string", () => {
    expect(loadConfig({ PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects a PORT that is not a usable port number", () => {
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "3001.5" })).toThrow(ConfigError);
  });

  it("rejects an unknown NODE_ENV rather than silently treating it as development", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(ConfigError);
  });

  it("requires endpoint overrides to be absolute URLs", () => {
    expect(() => loadConfig({ DYNAMODB_ENDPOINT: "localhost:8000" })).toThrow(ConfigError);
    expect(loadConfig({ DYNAMODB_ENDPOINT: "http://localhost:8000" }).DYNAMODB_ENDPOINT).toBe(
      "http://localhost:8000",
    );
  });

  it("accepts a complete production environment", () => {
    const config = loadConfig(PRODUCTION_ENV);
    expect(config.NODE_ENV).toBe("production");
  });

  it("requires production secrets, which are optional locally", () => {
    expect(loadConfig({ NODE_ENV: "development" }).INTERNAL_API_TOKEN).toBeUndefined();

    try {
      loadConfig({ NODE_ENV: "production" });
      expect.unreachable("production config without secrets should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("INTERNAL_API_TOKEN");
      expect(issues).toContain("VISITOR_HASH_SALT");
    }
  });

  it("reports every field problem at once instead of one restart per variable", () => {
    try {
      loadConfig({ PORT: "nope", DYNAMODB_ENDPOINT: "bad", NODE_ENV: "nonsense" });
      expect.unreachable("invalid config should throw");
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues).toHaveLength(3);
      expect(issues.join("\n")).toContain("PORT");
      expect(issues.join("\n")).toContain("DYNAMODB_ENDPOINT");
      expect(issues.join("\n")).toContain("NODE_ENV");
    }
  });

  it("defers the production-secret check until field validation passes", () => {
    /* Zod does not run object-level refinements when a field already failed, so a
       broken PORT masks the missing-secret errors. Documented rather than worked
       around: the first run still fails loudly, and fixing PORT surfaces the rest. */
    try {
      loadConfig({ NODE_ENV: "production", PORT: "nope" });
      expect.unreachable("invalid config should throw");
    } catch (error) {
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("PORT");
      expect(issues).not.toContain("INTERNAL_API_TOKEN");
    }
  });

  it("never echoes a rejected secret value into the error message", () => {
    const leaked = "this-token-is-too-short";

    try {
      loadConfig({ NODE_ENV: "production", INTERNAL_API_TOKEN: leaked });
      expect.unreachable("short token should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("INTERNAL_API_TOKEN");
      expect((error as ConfigError).message).not.toContain(leaked);
    }
  });
});

describe("redactConfig", () => {
  it("masks secrets while keeping ordinary settings readable", () => {
    const safe = redactConfig(loadConfig(PRODUCTION_ENV));

    expect(safe.INTERNAL_API_TOKEN).toBe("<redacted>");
    expect(safe.VISITOR_HASH_SALT).toBe("<redacted>");
    expect(safe.PORT).toBe(3001);
    expect(safe.DYNAMODB_TABLE).toBe("urlgen-links");
  });

  it("distinguishes an unset secret from a redacted one", () => {
    const safe = redactConfig(loadConfig({}));
    expect(safe.SAFE_BROWSING_API_KEY).toBe("<unset>");
  });

  it("leaks no secret value under JSON serialization, which is how it reaches the logs", () => {
    const serialized = JSON.stringify(redactConfig(loadConfig(PRODUCTION_ENV)));

    expect(serialized).not.toContain("x".repeat(40));
    expect(serialized).not.toContain("y".repeat(24));
  });
});
