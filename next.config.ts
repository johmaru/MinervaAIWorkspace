import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent SSE streaming (/api/chat) from being buffered by gzip
  // compression, which would drop thinking events. Next.js 16's
  // compression accumulates chunks in an internal buffer, causing
  // event: thinking to be lost. SSE should not be compressed.
  compress: false,
  // For standalone exe distribution: output server.js + required node_modules to .next/standalone.
  output: "standalone",
  // Treat native / heavy modules as external (load via require instead of bundling).
  // better-sqlite3 is a native addon; including it in the Next.js bundle causes
  // dlopen to fail during the "Collecting page data" phase.
  // @cursor/sdk ships webpack chunks that reference sibling *.js.LICENSE.txt files;
  // Turbopack treats those as modules and fails the production build unless externalized.
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "@cursor/sdk"],
  // Include native binaries in the trace (required for standalone distribution).
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/better-sqlite3/build/Release/**/*",
      "node_modules/onnxruntime-node/bin/napi-v3/win32/x64/**/*",
      "node_modules/@xenova/transformers/dist/**/*",
      "node_modules/sqlite-vec-windows-x64/**/*",
      "node_modules/sqlite-vec-linux-x64/**/*",
      "node_modules/@cursor/sdk/**/*",
      "node_modules/@cursor/sdk-linux-x64/**/*",
      "node_modules/@cursor/sdk-win32-x64/**/*",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
