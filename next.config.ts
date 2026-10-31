import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A separate dist dir lets a verification build run beside the user's own server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // linkedom/readability/undici are server-only and load faster unbundled.
  serverExternalPackages: ["linkedom", "@mozilla/readability", "undici"],
};

export default nextConfig;
