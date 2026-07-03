import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vitest は Next.js のように .env を自動読み込みしない。
// 実 API (api.code.umans.ai) を叩く Route Handler テストが
// LLM_BASE_URL / LLM_API_KEY / LLM_MODEL を必要とするため、
// プロジェクトルートの .env を最小のパーサで process.env に注入する。
// 既に env に設定されている値は上書きしない（CI 側で差し替え可能にするため）。
try {
  const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
} catch {
  // .env が無い場合はスキップ（CI で env 直書きの場合など）
}

// ホストからテスト実行時、Docker 内部サービス名をホスト到達可能なポートへ上書き。
// Docker 内 (本番) は docker-compose.yml の environment で上書きされるため影響なし。
if (process.env.EMBEDDER_URL?.includes("embedder:")) {
  process.env.EMBEDDER_URL = "http://localhost:8001";
}
if (process.env.SEARXNG_URL?.includes("searxng:")) {
  process.env.SEARXNG_URL = "http://localhost:8081";
}
