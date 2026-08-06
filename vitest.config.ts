import { defineConfig } from "vitest/config";

/**
 * Root test runner. Each workspace package that has tests contributes a project,
 * so a single `pnpm test` covers the whole monorepo.
 *
 * `apps/edge` brings its own pool — `@cloudflare/vitest-pool-workers` runs those
 * tests inside workerd rather than this Node environment, which is why it has to
 * be a separate project rather than another directory in the same one.
 */
export default defineConfig({
  test: {
    projects: ["packages/shared", "apps/api", "apps/edge"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["**/dist/**", "**/*.config.*", "**/*.test.ts"],
    },
  },
});
