/**
 * Cloudflare Tunnel プロセス管理。
 *
 * 2つの実行環境に対応:
 *   - Docker Compose: docker compose --profile tunnel up/down で cloudflared コンテナを起動/停止
 *   - スタンドアロン exe: cloudflared バイナリを子プロセスとして起動/停止
 *
 * exe 環境では cloudflared バイナリを data/cloudflared/ にダウンロードする。
 * セキュリティ条件:
 *   - バージョン固定 (CLOUDFLARED_VERSION)
 *   - SHA256 ハッシュ検証 (CLOUDFLARED_HASHES) — ローカル計算で確認済みの値
 *   - HTTPS のみ (GitHub Releases)
 *   - 自動更新なし (明示的バージョンアップのみ)
 *
 * 対応プラットフォーム: Windows x64, Linux x64 のみ。
 * macOS は .tgz 展開が必要なため未対応（将来的に追加する場合は展開ロジックが必要）。
 */

import { spawn, exec, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  createReadStream,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:https";
import { platform } from "node:os";

const execAsync = promisify(exec);

// 固定バージョン + SHA256 ハッシュ（プラットフォーム別）
// バージョンアップは開発者がこの値を更新して再ビルドする
// ハッシュは各バイナリをダウンロードしてローカル計算で確認済み
// 出典: https://github.com/cloudflare/cloudflared/releases/tag/2024.12.2
const CLOUDFLARED_VERSION = "2024.12.2";
const CLOUDFLARED_HASHES: Record<string, string> = {
  "cloudflared-windows-amd64.exe":
    "c2f4a3c3ea4c62eed562ede027d586a6044d35517e335e642f4e9783e651e4a3",
  "cloudflared-linux-amd64":
    "5237675a5e806120729acc78c5be02f9db5f406717699587abfa72b49b39fe40",
};

const MAX_REDIRECTS = 5;

/** プラットフォーム別のバイナリファイル名 */
function getBinaryName(): string {
  const plat = platform();
  if (plat === "win32") return "cloudflared-windows-amd64.exe";
  if (plat === "linux") return "cloudflared-linux-amd64";
  throw new Error(
    `Unsupported platform: ${plat}. macOS support requires .tgz extraction (not implemented).`,
  );
}

/** cloudflared バイナリのダウンロード先ディレクトリ */
function getCloudflaredDir(): string {
  // exe 環境では process.execPath のディレクトリ基準
  // node/bun で直接実行の場合は process.cwd()
  const isCompiled =
    process.execPath.endsWith("umanschat.exe") ||
    process.execPath.endsWith("umanschat");
  const appRoot = isCompiled ? dirname(process.execPath) : process.cwd();
  return join(appRoot, "data", "cloudflared");
}

/** Docker 環境かどうかを判定 */
export function isDockerEnv(): boolean {
  return existsSync("/var/run/docker.sock");
}

/** cloudflared バイナリが存在するか確認 (exe 環境用) */
export function isCloudflaredInstalled(): boolean {
  if (isDockerEnv()) return true; // Docker 環境ではコンテナイメージを使用
  const binaryPath = join(getCloudflaredDir(), getBinaryName());
  return existsSync(binaryPath);
}

/** SHA256 ハッシュを計算 */
function sha256File(filePath: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex")));
  stream.on("error", reject);
  return promise;
}

/** HTTPS でダウンロード（3xx リダイレクト対応） */
function httpsDownload(
  url: string,
  dest: string,
  redirects = 0,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const file = createWriteStream(dest);

  const req = request(url, (res) => {
    // 3xx リダイレクト対応: GitHub Releases は 302 → CDN へリダイレクトする
    if (
      res.statusCode &&
      res.statusCode >= 300 &&
      res.statusCode < 400 &&
      res.headers.location
    ) {
      res.resume(); // レスポンスボディを破棄
      file.close();
      if (redirects >= MAX_REDIRECTS) {
        reject(new Error(`リダイレクト回数が上限(${MAX_REDIRECTS})を超えました`));
        return;
      }
      const nextUrl = res.headers.location;
      // HTTPS のみ許可（http:// へのリダイレクトは拒否）
      if (!nextUrl.startsWith("https://")) {
        reject(new Error(`非HTTPSリダイレクトを拒否: ${nextUrl}`));
        return;
      }
      httpsDownload(nextUrl, dest, redirects + 1)
        .then(resolve)
        .catch(reject);
      return;
    }

    if (res.statusCode !== 200) {
      reject(new Error(`ダウンロード失敗: HTTP ${res.statusCode}`));
      return;
    }
    res.pipe(file);
    file.on("finish", () => {
      file.close();
      resolve();
    });
    file.on("error", reject);
  });

  req.on("error", reject);
  req.end();

  return promise;
}

/** cloudflared バイナリをダウンロード + SHA256 検証 (exe 環境用) */
export async function downloadCloudflared(): Promise<string> {
  if (isDockerEnv()) {
    throw new Error("Docker 環境ではバイナリダウンロード不要");
  }

  const dir = getCloudflaredDir();
  const binaryName = getBinaryName();
  const binaryPath = join(dir, binaryName);
  const expectedHash = CLOUDFLARED_HASHES[binaryName];

  if (!expectedHash) {
    throw new Error(`SHA256 ハッシュ未定義: ${binaryName}`);
  }

  // 既にダウンロード済み + ハッシュ検証済みならスキップ
  if (existsSync(binaryPath)) {
    const actualHash = await sha256File(binaryPath);
    if (actualHash === expectedHash) {
      return binaryPath;
    }
    console.warn("[tunnel] ハッシュ不一致、再ダウンロードします");
  }

  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${binaryName}`;

  await httpsDownload(url, binaryPath);

  // SHA256 検証
  const actualHash = await sha256File(binaryPath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA256 検証失敗: 期待値 ${expectedHash.slice(0, 16)}...、実際 ${actualHash.slice(0, 16)}...`,
    );
  }

  console.log("[tunnel] cloudflared ダウンロード完了 + ハッシュ検証成功");
  return binaryPath;
}

/** Docker 環境: cloudflared コンテナを起動 */
async function startDockerTunnel(token: string): Promise<void> {
  // --force-recreate で古い TUNNEL_TOKEN 環境変数を持つコンテナを確実に再作成する。
  // これにより GUI でトークンを保存→起動した際に新しいトークンが確実に反映される。
  await execAsync(
    `docker compose --profile tunnel up -d --force-recreate cloudflared`,
    {
      cwd: process.cwd(),
      timeout: 60_000,
      env: { ...process.env, TUNNEL_TOKEN: token },
    },
  );
}

/** Docker 環境: cloudflared コンテナを停止 */
async function stopDockerTunnel(): Promise<void> {
  await execAsync(`docker compose --profile tunnel stop cloudflared`, {
    cwd: process.cwd(),
    timeout: 60_000,
  });
}

/** exe 環境: cloudflared 子プロセス */
let cloudflaredProcess: ChildProcess | null = null;

/** exe 環境: cloudflared 子プロセスを起動 */
async function startExeTunnel(token: string): Promise<void> {
  const binaryPath = await downloadCloudflared();
  cloudflaredProcess = spawn(
    binaryPath,
    ["tunnel", "run", "--token", token],
    {
      stdio: "ignore",
      detached: false,
    },
  );
  cloudflaredProcess.on("exit", (code) => {
    console.log(`[tunnel] cloudflared exited with code ${code}`);
    cloudflaredProcess = null;
  });
}

/** exe 環境: cloudflared 子プロセスを停止 */
function stopExeTunnel(): void {
  if (cloudflaredProcess) {
    cloudflaredProcess.kill("SIGTERM");
    cloudflaredProcess = null;
  }
}

/** トンネルの実行状態 */
export interface TunnelStatus {
  running: boolean;
  hasToken: boolean;
  authUrl: string;
}

/** トンネルが実行中かどうかを確認 */
export async function isTunnelRunning(): Promise<boolean> {
  if (isDockerEnv()) {
    try {
      const { stdout } = await execAsync(
        `docker compose --profile tunnel ps cloudflared --format json`,
        { cwd: process.cwd(), timeout: 10_000 },
      );
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.State === "running") return true;
        } catch {
          // JSON パース失敗は無視
        }
      }
      return false;
    } catch {
      return false;
    }
  }
  // exe 環境: プロセスが存在するか
  return cloudflaredProcess !== null && !cloudflaredProcess.killed;
}

/** トンネル状態を取得 */
export async function getTunnelStatus(): Promise<TunnelStatus> {
  return {
    running: await isTunnelRunning(),
    hasToken: !!process.env.TUNNEL_TOKEN,
    authUrl: process.env.AUTH_URL || "http://localhost:3001",
  };
}

/** トンネルを起動。force=true の場合は既存プロセス/コンテナを停止してから再起動 */
export async function startTunnel(
  token: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (!token) throw new Error("TUNNEL_TOKEN が設定されていません");

  // 既に起動中の場合:
  //   force=false (デフォルト) → 何もしない
  //   force=true → 停止してから再起動（トークン変更を確実に反映）
  if (await isTunnelRunning()) {
    if (!opts?.force) return;
    await stopTunnel();
  }

  if (isDockerEnv()) {
    await startDockerTunnel(token);
  } else {
    await startExeTunnel(token);
  }
}

/** トンネルを停止 */
export async function stopTunnel(): Promise<void> {
  if (!(await isTunnelRunning())) return; // 既に停止中

  if (isDockerEnv()) {
    await stopDockerTunnel();
  } else {
    stopExeTunnel();
  }
}
