import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // vite-tsconfig-paths プラグイン不要（Vite ネイティブで tsconfig paths を解決）。
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    // Route Handler / lib のテストは各ファイル先頭の
    // `// @vitest-environment node` コメントで node 環境に切替（Vitest 4 で
    // environmentMatchGlobs は削除されたため）。
    setupFiles: ["./vitest.setup.ts"],
    // 実 API を叩くテストは時間がかかるため余裕を持たせる。
    testTimeout: 30_000,
    // watch せず1回実行して終わる（CI / 一発検証向け）。
    // `bun run test -- --watch` で watch 可能。
    // sharp / @xenova/transformers の native module は forks pool で
    // worker クラッシュを起こすため threads pool を使う。
    pool: "threads",
  },
});