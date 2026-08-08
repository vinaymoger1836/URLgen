import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /* @urlgen/shared is published as TypeScript source, so Next must compile it. */
  transpilePackages: ["@urlgen/shared"],
  experimental: {
    /**
     * ⚠️ This is why `dev` and `build` both pass `--webpack`.
     *
     * The whole repo is `moduleResolution: NodeNext`, where a relative import must
     * name the extension of the file it *emits* — so `@urlgen/shared` imports
     * `./analytics.js` while shipping `./analytics.ts`. TypeScript, tsx, esbuild
     * and webpack all rewrite that; **Turbopack does not**, and it ignores this
     * option, so every shared import fails to resolve under the default bundler.
     *
     * The alternative is compiling `@urlgen/shared` to a `dist/` and pointing its
     * exports there — which would stop the API and the Worker running straight
     * from source and put a build step in front of every shared-schema edit. One
     * slower dev server on one app is the cheaper side of that trade.
     *
     * Revisit when Turbopack supports the rewrite; the fix is deleting this block
     * and the two `--webpack` flags.
     */
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
};

export default nextConfig;
