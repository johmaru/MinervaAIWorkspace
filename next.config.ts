import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SSE ストリーミング（/api/chat）が gzip 圧縮によって
  // バッファリングされ thinking イベントが欠落するのを防ぐ。
  // Next.js 16 の compression はチャンクを内部バッファに溜めるため、
  // event: thinking が失われる。SSE は圧縮すべきではない。
  compress: false,
};

export default nextConfig;
