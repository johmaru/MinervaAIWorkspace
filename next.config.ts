import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent SSE streaming (/api/chat) from being buffered by gzip
  // compression, which would drop thinking events. Next.js 16's
  // compression accumulates chunks in an internal buffer, causing
  // event: thinking to be lost. SSE should not be compressed.
  compress: false,
  // For standalone exe distribution: output server.js + required node_modules to .next/standalone.
  output: "standalone",
  // Treat native modules as external packages (load via require instead of bundling).
  // better-sqlite3 is a native addon; including it in the Next.js bundle causes
  // dlopen to fail during the "Collecting page data" phase.
  serverExternalPackages: ["better-sqlite3"],
  // Include native binaries in the trace (required for standalone distribution).
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/better-sqlite3/build/Release/**/*",
      "node_modules/onnxruntime-node/bin/napi-v3/win32/x64/**/*",
      "node_modules/@xenova/transformers/dist/**/*",
      "node_modules/sqlite-vec-windows-x64/**/*",
      "node_modules/sqlite-vec-linux-x64/**/*",
    ],
  },
};

export default nextConfig;
