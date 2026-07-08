/**
 * Cloudflare Tunnel process management.
 *
 * Supports two execution environments:
 *   - Docker Compose: start/stop the cloudflared container via docker compose --profile tunnel up/down
 *   - Standalone exe: start/stop the cloudflared binary as a child process
 *
 * In the exe environment, the cloudflared binary is downloaded to data/cloudflared/.
 * Security conditions:
 *   - Pinned version (CLOUDFLARED_VERSION)
 *   - SHA256 hash verification (CLOUDFLARED_HASHES) — values confirmed by local computation
 *   - HTTPS only (GitHub Releases)
 *   - No auto-update (explicit version upgrades only)
 *
 * Supported platforms: Windows x64, Linux x64 only.
 * macOS is unsupported because .tgz extraction is required (extraction logic would be needed to add it in the future).
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
import { logger } from "@/lib/logger";

const execAsync = promisify(exec);

// Pinned version + SHA256 hashes (per platform)
// Version upgrades require a developer to update these values and rebuild
// Hashes are confirmed by downloading each binary and computing locally
// Source: https://github.com/cloudflare/cloudflared/releases/tag/2024.12.2
const CLOUDFLARED_VERSION = "2024.12.2";
const CLOUDFLARED_HASHES: Record<string, string> = {
  "cloudflared-windows-amd64.exe":
    "c2f4a3c3ea4c62eed562ede027d586a6044d35517e335e642f4e9783e651e4a3",
  "cloudflared-linux-amd64":
    "5237675a5e806120729acc78c5be02f9db5f406717699587abfa72b49b39fe40",
};

const MAX_REDIRECTS = 5;

/** Binary filename per platform */
function getBinaryName(): string {
  const plat = platform();
  if (plat === "win32") return "cloudflared-windows-amd64.exe";
  if (plat === "linux") return "cloudflared-linux-amd64";
  throw new Error(
    `Unsupported platform: ${plat}. macOS support requires .tgz extraction (not implemented).`,
  );
}

/** Download directory for the cloudflared binary */
function getCloudflaredDir(): string {
  // In the exe environment, based on the directory of process.execPath
  // When running directly with node/bun, based on process.cwd()
  const isCompiled =
    process.execPath.endsWith("umanschat.exe") ||
    process.execPath.endsWith("umanschat");
  const appRoot = isCompiled ? dirname(process.execPath) : process.cwd();
  return join(appRoot, "data", "cloudflared");
}

/** Determines whether running in a Docker environment */
export function isDockerEnv(): boolean {
  return existsSync("/var/run/docker.sock");
}

/** Checks if the cloudflared binary exists (for exe environment) */
export function isCloudflaredInstalled(): boolean {
  if (isDockerEnv()) return true; // Docker environment uses the container image
  const binaryPath = join(getCloudflaredDir(), getBinaryName());
  return existsSync(binaryPath);
}

/** Computes the SHA256 hash of a file */
export function sha256File(filePath: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex")));
  stream.on("error", reject);
  return promise;
}

/** Downloads via HTTPS (handles 3xx redirects) */
export function httpsDownload(
  url: string,
  dest: string,
  redirects = 0,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const file = createWriteStream(dest);

  const req = request(url, { headers: { "User-Agent": "UmansChat-Updater" } }, (res) => {
    // Handle 3xx redirects: GitHub Releases redirects 302 → CDN
    if (
      res.statusCode &&
      res.statusCode >= 300 &&
      res.statusCode < 400 &&
      res.headers.location
    ) {
      res.resume(); // Discard the response body
      file.close();
      if (redirects >= MAX_REDIRECTS) {
        reject(new Error(`Redirect limit (${MAX_REDIRECTS}) exceeded`));
        return;
      }
      const nextUrl = res.headers.location;
      // Only allow HTTPS (reject redirects to http://)
      if (!nextUrl.startsWith("https://")) {
        reject(new Error(`Non-HTTPS redirect rejected: ${nextUrl}`));
        return;
      }
      httpsDownload(nextUrl, dest, redirects + 1)
        .then(resolve)
        .catch(reject);
      return;
    }

    if (res.statusCode !== 200) {
      reject(new Error(`Download failed: HTTP ${res.statusCode}`));
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

/** Downloads the cloudflared binary + verifies SHA256 (for exe environment) */
export async function downloadCloudflared(): Promise<string> {
  if (isDockerEnv()) {
    throw new Error("Binary download not needed in Docker environment");
  }

  const dir = getCloudflaredDir();
  const binaryName = getBinaryName();
  const binaryPath = join(dir, binaryName);
  const expectedHash = CLOUDFLARED_HASHES[binaryName];

  if (!expectedHash) {
    throw new Error(`SHA256 hash undefined: ${binaryName}`);
  }

  // Skip if already downloaded and hash-verified
  if (existsSync(binaryPath)) {
    const actualHash = await sha256File(binaryPath);
    if (actualHash === expectedHash) {
      return binaryPath;
    }
    logger.warn("tunnel", "Hash mismatch, re-downloading");
  }

  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${binaryName}`;

  await httpsDownload(url, binaryPath);

  // SHA256 verification
  const actualHash = await sha256File(binaryPath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA256 verification failed: expected ${expectedHash.slice(0, 16)}..., actual ${actualHash.slice(0, 16)}...`,
    );
  }

  logger.info("tunnel", "cloudflared download complete + hash verification passed");
  return binaryPath;
}

/** Docker environment: start the cloudflared container */
async function startDockerTunnel(token: string): Promise<void> {
  // --force-recreate ensures the container with the old TUNNEL_TOKEN env var is recreated.
  // This guarantees the new token is reflected when saving→starting from the GUI.
  await execAsync(
    `docker compose --profile tunnel up -d --force-recreate cloudflared`,
    {
      cwd: process.cwd(),
      timeout: 60_000,
      env: { ...process.env, TUNNEL_TOKEN: token },
    },
  );
}

/** Docker environment: stop the cloudflared container */
async function stopDockerTunnel(): Promise<void> {
  await execAsync(`docker compose --profile tunnel stop cloudflared`, {
    cwd: process.cwd(),
    timeout: 60_000,
  });
}

/** exe environment: cloudflared child process */
let cloudflaredProcess: ChildProcess | null = null;

/** exe environment: start the cloudflared child process */
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
    logger.info("tunnel", "cloudflared exited", { code });
    cloudflaredProcess = null;
  });
}

/** exe environment: stop the cloudflared child process */
function stopExeTunnel(): void {
  if (cloudflaredProcess) {
    cloudflaredProcess.kill("SIGTERM");
    cloudflaredProcess = null;
  }
}

/** Tunnel running state */
export interface TunnelStatus {
  running: boolean;
  hasToken: boolean;
  authUrl: string;
}

/** Checks whether the tunnel is running */
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
          // Ignore JSON parse failure
        }
      }
      return false;
    } catch {
      return false;
    }
  }
  // exe environment: check if the process exists
  return cloudflaredProcess !== null && !cloudflaredProcess.killed;
}

/** Gets the tunnel status */
export async function getTunnelStatus(): Promise<TunnelStatus> {
  return {
    running: await isTunnelRunning(),
    hasToken: !!process.env.TUNNEL_TOKEN,
    authUrl: process.env.AUTH_URL || "http://localhost:3001",
  };
}

/** Starts the tunnel. If force=true, stops the existing process/container before restarting */
export async function startTunnel(
  token: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (!token) throw new Error("TUNNEL_TOKEN is not set");

  // If already running:
  //   force=false (default) → do nothing
  //   force=true → stop then restart (ensures token changes take effect)
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

/** Stops the tunnel */
export async function stopTunnel(): Promise<void> {
  if (!(await isTunnelRunning())) return; // Already stopped

  if (isDockerEnv()) {
    await stopDockerTunnel();
  } else {
    stopExeTunnel();
  }
}
