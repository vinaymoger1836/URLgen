import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * The Worker's tests run inside workerd, not Node.
 *
 * That is the whole point: `KVNamespace`, `ExecutionContext` and `fetch` behave
 * differently at the edge than any Node shim would, and a mock of KV would be a
 * test double more capable than the thing it doubles — which is exactly how the
 * Phase 1 GSI projection bug got through.
 */
export default defineWorkersConfig({
  test: {
    name: "edge",
    include: ["src/**/*.test.ts"],
    poolOptions: {
      workers: {
        /* Isolated storage rolls back KV writes between tests, so one test's
           write-back cannot become another's cache hit. */
        isolatedStorage: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            /* Obviously-fake stand-in for the real secret, which is set with
               `wrangler secret put` and never appears in a committed file. */
            INTERNAL_API_TOKEN: "test-token-not-a-real-secret-000000",
            ORIGIN_API_BASE: "https://origin.test",
          },
        },
      },
    },
  },
});
