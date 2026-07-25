import { getSessionUser } from "@/lib/auth-guards";
import { listWorkspaceEntries } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspace/list?path=...
 * Returns workspace directory entries as JSON for the KB file picker UI.
 * Path traversal protection via resolveWorkspacePath.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? ".";

  try {
    const entries = await listWorkspaceEntries(path, user.id);
    return Response.json(entries);
  } catch {
    return new Response("Directory not found or access denied", { status: 404 });
  }
}
