// @vitest-environment node
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { httpsDownload, isDockerEnv } from "@/lib/tunnel";

const GITHUB_REPO = "johmaru/UmansChat-Unofficial";
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

let cachedRelease: { data: GitHubRelease; timestamp: number } | null = null;

interface GitHubRelease {
  tag_name: string;
  body: string | null;
  assets: { name: string; browser_download_url: string }[];
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl: string | null;
  releaseNotes: string | null;
  isExe: boolean;
}

export interface DownloadResult {
  stagingDir: string;
  version: string;
}

/** Detect exe environment: not Docker AND umanschat.exe exists in cwd */
export function isExeEnv(): boolean {
  if (isDockerEnv()) return false;
  return existsSync(join(process.cwd(), "umanschat.exe"));
}

/** Read current version from package.json in process.cwd() */
export function getAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Compare semver strings: returns 1 if a > b, -1 if a < b, 0 if equal */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((s) => parseInt(s, 10));
  const pb = b.replace(/^v/, "").split(".").map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** Fetch latest release from GitHub API (cached 1h) */
async function fetchLatestRelease(): Promise<GitHubRelease> {
  if (cachedRelease && Date.now() - cachedRelease.timestamp < CACHE_TTL) {
    return cachedRelease.data;
  }
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { "User-Agent": "UmansChat-Updater" } },
  );
  if (res.status === 404) throw new Error("No releases found");
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const data = (await res.json()) as GitHubRelease;
  cachedRelease = { data, timestamp: Date.now() };
  return data;
}

/** Check for updates. Returns update info or throws on API failure. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = getAppVersion();
  const exe = isExeEnv();

  if (!exe) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      downloadUrl: null,
      releaseNotes: null,
      isExe: false,
    };
  }

  const release = await fetchLatestRelease();
  const latestVersion = release.tag_name.replace(/^v/, "");
  const zipAsset = release.assets.find((a) =>
    a.name.match(/UmansChat-.*-windows-x64\.zip$/),
  );

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    downloadUrl: zipAsset?.browser_download_url ?? null,
    releaseNotes: release.body,
    isExe: true,
  };
}

/** Download zip, extract to staging, write marker file. Returns staging dir. */
export async function downloadUpdate(
  downloadUrl: string,
  version: string,
): Promise<DownloadResult> {
  if (!isExeEnv()) {
    throw new Error("Auto-update is not available in this environment");
  }

  const updatesDir = join(process.cwd(), "data", "updates");
  const zipPath = join(updatesDir, `UmansChat-${version}-windows-x64.zip`);
  const stagingDir = join(updatesDir, "staging");

  // Download
  mkdirSync(updatesDir, { recursive: true });
  await httpsDownload(downloadUrl, zipPath);

  // Extract using PowerShell Expand-Archive (available on all Windows 10+ systems
  // with PowerShell 5.1+, which is preinstalled on all target machines).
  // tar.exe is not guaranteed on older Windows 10 builds; PowerShell is the
  // safe single choice. The API route runs in node.exe (not Bun), so child_process
  // works normally.
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });
  execSync(
    `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stagingDir}' -Force"`,
    { stdio: "pipe" },
  );

  // Write marker file for the launcher to pick up
  const markerPath = join(process.cwd(), "data", ".update-pending");
  writeFileSync(markerPath, JSON.stringify({ stagingDir, version, zipPath }));

  return { stagingDir, version };
}
