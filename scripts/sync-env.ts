/**
 * scripts/sync-env.ts
 *
 * .env.example を走査し、.env に存在しないキーを example の値ごと末尾に追記する。
 * 既存キーの値は一切変更しない。
 *
 * 起動前の整合性確保が目的のため、例外は catch せずそのまま throw する
 * （呼び出し元の predev / docker-entrypoint.sh でハンドリング）。
 *
 * パーサーは vitest.setup.ts:10-28 の既存最小パーサーと同アプローチ
 * （# コメントスキップ、KEY=value 抽出、"..." クオート除去）。
 * テスト用 setup は本番 import に向かないため、独立した純関数として持つ。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** .env.example から KEY -> 値文字列 の Map を抽出する。 */
function parseExample(raw: string): Map<string, string> {
  const out = new Map<string, string>();
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
    out.set(key, val);
  }
  return out;
}

/**
 * .env に既にキーが存在するか（`^KEY=` m フラグ）を判定。
 * コメントアウト行（`# KEY=`）はマッチしないため新規扱いとなる（意図的）。
 */
function hasKey(envContent: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}=`, "m").test(envContent);
}

/** sync-env の本体。戻り値は追記したキーのリスト（テスト用）。 */
export function syncEnv(
  examplePath: string,
  envPath: string,
  now: Date = new Date(),
): string[] {
  // example 無しは何もしない（エッジケース）。
  if (!existsSync(examplePath)) {
    console.log("[sync-env] No .env.example found. Skipping.");
    return [];
  }

  const exampleRaw = readFileSync(examplePath, "utf8");
  const exampleMap = parseExample(exampleRaw);

  // .env が無ければ空文字扱い。
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  // 追記候補を収集。
  const additions: Array<{ key: string; value: string }> = [];
  for (const [key, value] of exampleMap) {
    if (!hasKey(envContent, key)) {
      additions.push({ key, value });
    }
  }

  if (additions.length === 0) {
    console.log("[sync-env] .env is up to date.");
    return [];
  }

  // ヘッダコメント + キー群を末尾に追記。
  const header = `\n# Auto-merged from .env.example (${now.toISOString()})\n`;
  const body = additions
    .map((a) => `${a.key}=${a.value}`)
    .join("\n");
  const tail = envContent.endsWith("\n") || envContent === "" ? "" : "\n";
  const next = envContent + tail + header + body + "\n";
  writeFileSync(envPath, next, "utf8");

  const keys = additions.map((a) => a.key);
  console.log(`[sync-env] Added ${keys.length} key(s): ${keys.join(", ")}`);
  return keys;
}

// 直接実行された場合のみ走る。import では実行されない。
// `process.argv[1]` とこのファイルのパスを比較して Node/Bun 両方で動作
// （Bun 固有の `import.meta.main` は @types/node に無いため使わない）。
// `import.meta.url` は ESM 実行時のみ定義される。CJS バンドル等で未定義の
// 場合は安全にフォールバックし、ガードを false 扱いにする。
const scriptUrl = import.meta.url;
const isMain =
  typeof scriptUrl === "string" &&
  scriptUrl.length > 0 &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(scriptUrl);

if (isMain) {
  const cwd = process.cwd();
  syncEnv(resolve(cwd, ".env.example"), resolve(cwd, ".env"));
}
