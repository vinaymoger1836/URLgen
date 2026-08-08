import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Node environment, not jsdom.
 *
 * What is tested here is the layer under the components — bucket labels in a named
 * timezone, share arithmetic, axis thinning. Those are the parts that can be
 * silently wrong in a way a reader would believe; rendering React to assert that a
 * div exists would cost a browser environment and prove less.
 */
export default defineConfig({
  test: {
    name: "web",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
