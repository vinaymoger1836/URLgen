import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /* @urlgen/shared is published as TypeScript source, so Next must compile it. */
  transpilePackages: ["@urlgen/shared"],
};

export default nextConfig;
