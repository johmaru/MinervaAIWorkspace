import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * cwd から親方向へ遡って既存の .env を探す。
 * Next.js standalone サーバーは process.chdir で /app/.next/standalone に
 * 移動するため、cwd 直下だとイメージレイヤ内の一時ファイルに書き込んでしまう。
 * 見つからなければ cwd 直下を返す（ローカル dev や新規作成時のフォールバック）。
 */
export function resolveEnvPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break; // ルート到達
    dir = parent;
  }
  return resolve(process.cwd(), ".env");
}

/**
 * .env 値のエスケープ。
 * 全ての値をダブルクォートで囲み、内部の " / \ / 改行をバックスラッシュエスケープする。
 * 改行は \n にエスケープしてインジェクションを防止。
 * # / = / スペース等も dotenv に誤解釈されないようクォート内に入る。
 * dotenv パーサは "..." 内の \n を改行として解釈するため安全。
 */
export function escapeEnvValue(value: string): string {
  if (value === "") return '""';
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * .env ファイルを読み込み、指定キーの値を更新する。
 * 値は escapeEnvValue でエスケープされる。
 * 戻り値: 更新後の .env 文字列。
 */
export function updateEnvContent(
  envContent: string,
  updates: Record<string, string>,
): string {
  let content = envContent;
  for (const [key, rawValue] of Object.entries(updates)) {
    const value = escapeEnvValue(rawValue);
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  return content;
}

/**
 * .env を読み込み、指定キーを更新して書き込む。
 * resolveEnvPath で .env のパスを解決する。
 */
export function writeEnvUpdates(updates: Record<string, string>): string {
  const envPath = resolveEnvPath();
  let envContent = "";
  try {
    envContent = readFileSync(envPath, "utf8");
  } catch {
    envContent = "";
  }
  const newContent = updateEnvContent(envContent, updates);
  writeFileSync(envPath, newContent);
  return envPath;
}
