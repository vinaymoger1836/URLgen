import { defineConfig } from "vitest/config";

/**
 * Root test runner. Each workspace package that has tests contributes a project,
 * so a single `pnpm test` covers the whole monorepo.
 *
 * Phase 2 adds `apps/edge` as its own project using `@cloudflare/vitest-pool-workers`,
 * which needs a different pool and cannot share this Node environment.
 */
export default defineConfig({
  test: {
    projects: ["packages/shared", "apps/api"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["**/dist/**", "**/*.config.*", "**/*.test.ts"],
    },
  },
});
