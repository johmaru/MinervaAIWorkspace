// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpsDownload, isDockerEnv } from "@/lib/tunnel";
import { getDataDir } from "@/lib/user-data";

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

/** Semver validation: MAJOR.MINOR.PATCH (no v-prefix, no pre-release tags) */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

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

/** Validate that a version string is safe (strict semver: digits.digits.digits) */
export function isValidVersion(version: string): boolean {
  return SEMVER_RE.test(version);
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

  // Validate version: strict semver to prevent path traversal and shell injection
  if (!isValidVersion(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }

  // Validate download URL: must be from GitHub releases
  const parsedUrl = new URL(downloadUrl);
  if (!parsedUrl.protocol.startsWith("https")) {
    throw new Error("Download URL must use HTTPS");
  }
  const allowedHosts = ["github.com", "objects.githubusercontent.com"];
  if (!allowedHosts.includes(parsedUrl.hostname)) {
    throw new Error(`Download URL host not allowed: ${parsedUrl.hostname}`);
  }

  const dataDir = getDataDir();
  const updatesDir = join(dataDir, "updates");
  const zipPath = join(updatesDir, `UmansChat-${version}-windows-x64.zip`);
  const stagingDir = join(updatesDir, "staging");

  // Download
  mkdirSync(updatesDir, { recursive: true });
  await httpsDownload(downloadUrl, zipPath);
  // Verify SHA256 checksum (mandatory): download .sha256 from the same release
  const sha256Url = downloadUrl.replace(/\.zip$/, ".sha256");
  let expectedHash: string;
  try {
    const shaResponse = await fetch(sha256Url, { redirect: "follow" });
    if (!shaResponse.ok) {
      throw new Error(`Checksum file not found (HTTP ${shaResponse.status})`);
    }
    const shaText = await shaResponse.text();
    expectedHash = shaText.trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      throw new Error(`Invalid checksum format: ${expectedHash}`);
    }
  } catch (err) {
    rmSync(zipPath, { force: true });
    throw new Error(`SHA256 verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { createHash } = await import("node:crypto");
  const fileBuffer = readFileSync(zipPath);
  const actualHash = createHash("sha256").update(fileBuffer).digest("hex");
  if (actualHash !== expectedHash) {
    rmSync(zipPath, { force: true });
    throw new Error(`SHA256 mismatch: expected ${expectedHash}, got ${actualHash}`);
  }

  // Extract using PowerShell Expand-Archive (available on all Windows 10+ systems
  // with PowerShell 5.1+, which is preinstalled on all target machines).
  // tar.exe is not guaranteed on older Windows 10 builds; PowerShell is the
  // safe single choice. The API route runs in node.exe (not Bun), so child_process
  // works normally.
  // Security: use execFileSync (no shell) with arg-array to prevent shell injection.
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });
  execFileSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stagingDir}' -Force`,
  ], { stdio: "pipe" });

  // Write marker file for the launcher to pick up
  const markerPath = join(dataDir, ".update-pending");
  writeFileSync(markerPath, JSON.stringify({ stagingDir, version, zipPath }));

  return { stagingDir, version };
}
