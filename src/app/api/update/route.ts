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

/** POST /api/update — Download and prepare update */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: { downloadUrl?: string; version?: string };
  try {
    body = (await req.json()) as { downloadUrl?: string; version?: string };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.downloadUrl || !body.version) {
    return Response.json(
      { error: "downloadUrl and version are required" },
      { status: 400 },
    );
  }

  try {
    const result = await downloadUpdate(body.downloadUrl, body.version);
    return Response.json({ success: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
