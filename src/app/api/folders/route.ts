import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MemoryScope = "folder" | "global";
function isValidScope(v: unknown): v is MemoryScope {
  return v === "folder" || v === "global";
}

/**
 * GET /api/folders — List folders (newest first).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db.select().from(folders).where(eq(folders.userId, user.id)).orderBy(desc(folders.updatedAt));
  return Response.json(rows);
}

type FolderBody = {
  name?: string;
  instruction?: string | null;
  memoryScope?: unknown;
};

/**
 * POST /api/folders — Create a new folder.
 * Defaults: name="New folder", instruction=null, memoryScope="global".
 * Invalid memoryScope falls back to "global".
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: FolderBody = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = (await req.json()) as FolderBody;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
  }

  const [row] = await db
    .insert(folders)
    .values({
      name: body.name?.trim() || "New folder",
      instruction:
        typeof body.instruction === "string"
          ? body.instruction.trim() || null
          : null,
      memoryScope: isValidScope(body.memoryScope) ? body.memoryScope : "global",
      userId: user.id,
    })
    .returning();
  return Response.json(row, { status: 201 });
}

type PatchBody = {
  name?: string;
  instruction?: string | null;
  memoryScope?: unknown;
};

/**
 * PATCH /api/folders?id=... — Partially update a folder.
 * Updates only the specified fields. updatedAt is always updated.
 * Invalid memoryScope returns 400. Blank name is normalized to "New folder".
 */
export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response("id is required", { status: 400 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (body.memoryScope !== undefined && !isValidScope(body.memoryScope)) {
    return new Response("invalid memoryScope", { status: 400 });
  }

  const values: Partial<typeof folders.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.name === "string") values.name = body.name.trim() || "New folder";
  if (body.instruction !== undefined) {
    values.instruction =
      body.instruction === null
        ? null
        : typeof body.instruction === "string"
          ? body.instruction.trim() || null
          : body.instruction;
  }
  if (body.memoryScope !== undefined) {
    values.memoryScope = body.memoryScope as MemoryScope;
  }

  const [row] = await db
    .update(folders)
    .set(values)
    .where(and(eq(folders.id, id), eq(folders.userId, user.id)))
    .returning();
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
