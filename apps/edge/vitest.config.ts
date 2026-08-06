import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * The Worker's tests run inside workerd, not Node.
 *
 * That is the whole point: `KVNamespace`, `ExecutionContext` and `fetch` behave
 * differently at the edge than any Node shim would, and a hand-written KV mock
 * would be a test double more capable than the thing it doubles — which is
 * exactly how the Phase 1 GSI projection bug got through.
 *
 * `cloudflareTest` is a Vite plugin rather than a `poolOptions.workers` block:
 * pool-workers 0.20 (the first release to support Vitest 4) moved to the plugin
 * API and dropped `defineWorkersConfig`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          /* Obviously-fake stand-in for the real secret, which is set with
             `wrangler secret put` and never appears in a committed file. */
          INTERNAL_API_TOKEN: "test-token-not-a-real-secret-000000",
          ORIGIN_API_BASE: "https://origin.test",
        },
      },
    }),
  ],
  test: {
    name: "edge",
    include: ["src/**/*.test.ts"],
  },
});
