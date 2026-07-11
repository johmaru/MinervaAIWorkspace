/**
 * /api/update — Check for and download app updates (exe distribution only).
 *
 * GET:  Checks GitHub Releases latest, returns version info + download URL.
 * POST: Downloads the release zip, extracts to staging, writes marker file
 *       for the launcher to pick up and apply.
 *
 * Design:
 *   - Only meaningful in the exe distribution (isExeEnv() guards).
 *   - Docker/dev environments get isExe: false, updateAvailable: false.
 *   - Auth required (getSessionUser) — same pattern as /api/tunnel.
 */
// @vitest-environment node
import { getSessionUser } from "@/lib/auth-guards";
import { checkForUpdate, downloadUpdate } from "@/lib/updater";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/update — Check for updates */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  try {
    const info = await checkForUpdate();
    return Response.json(info);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/update — Download and prepare update
 *
 * Security: The client-sent version/downloadUrl are NOT trusted. We re-fetch
 * the latest release server-side via checkForUpdate() and validate that the
 * client's version matches the server-known latest version. The downloadUrl
 * comes from the server-verified GitHub release, not the client.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: { version?: string };
  try {
    body = (await req.json()) as { version?: string };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.version) {
    return Response.json(
      { error: "version is required" },
      { status: 400 },
    );
  }

  try {
    // Re-verify the update server-side: never trust client-provided URLs
    const info = await checkForUpdate();
    if (!info.isExe) {
      return Response.json(
        { error: "Auto-update is not available in this environment" },
        { status: 400 },
      );
    }
    if (!info.updateAvailable || !info.downloadUrl) {
      return Response.json(
        { error: "No update available" },
        { status: 400 },
      );
    }
    // The client-requested version must match what the server knows is latest
    if (body.version !== info.latestVersion) {
      return Response.json(
        { error: "Version mismatch: requested version does not match latest release" },
        { status: 400 },
      );
    }

    // Use the server-verified downloadUrl, not the client-provided one
    const result = await downloadUpdate(info.downloadUrl, info.latestVersion);
    return Response.json({ success: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
