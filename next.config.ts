import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SSE ストリーミング（/api/chat）が gzip 圧縮によって
  // バッファリングされ thinking イベントが欠落するのを防ぐ。
  // Next.js 16 の compression はチャンクを内部バッファに溜めるため、
  // event: thinking が失われる。SSE は圧縮すべきではない。
  compress: false,
  // スタンドアロン exe 配布用: server.js + 必要な node_modules を .next/standalone に出力。
  output: "standalone",
  // ネイティブモジュールを外部パッケージとして扱う（バンドルせず require で読み込む）。
  // better-sqlite3 はネイティブアドオンのため、Next.js のバンドルに含めると
  // Collecting page data フェーズで dlopen が失敗する。
  serverExternalPackages: ["better-sqlite3"],
  // ネイティブバイナリをトレースに含める（standalone 配布で必須）。
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/better-sqlite3/build/Release/**/*",
      "node_modules/onnxruntime-node/bin/napi-v3/win32/x64/**/*",
      "node_modules/@xenova/transformers/dist/**/*",
    ],
  },
};

export default nextConfig;
