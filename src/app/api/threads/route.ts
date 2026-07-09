import { and, desc, eq } from "drizzle-orm";
import { defaultModel } from "@/lib/llm";
import { db } from "@/db";
import { threads } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/threads — Thread list (newest first). Metadata only, no body.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: threads.id,
      title: threads.title,
      folderId: threads.folderId,
      createdAt: threads.createdAt,
      updatedAt: threads.updatedAt,
    })
    .from(threads)
    .where(eq(threads.userId, user.id))
    .orderBy(desc(threads.updatedAt));
  return Response.json(rows);
}

type CreateBody = {
  title?: string;
  systemPrompt?: string;
  model?: string;
  folderId?: string | null;
  responseMode?: "single" | "dual";
  dualModelA?: string | null;
  dualModelB?: string | null;
  dualStrategy?: "cross_review" | "debate";
  dualDebateRounds?: number;
  globalInstructionId?: string | null;
};

/**
 * POST /api/threads — Create a new thread.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: CreateBody = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = (await req.json()) as CreateBody;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
  }
  const [row] = await db
    .insert(threads)
    .values({
      title: body.title?.trim() || "New chat",
      userId: user.id,
      systemPrompt: body.systemPrompt,
      model: body.model ?? defaultModel(),
      folderId: body.folderId ?? null,
      responseMode: body.responseMode === "dual" ? "dual" : "single",
      dualModelA: body.dualModelA ?? null,
      dualModelB: body.dualModelB ?? null,
      dualStrategy: body.dualStrategy === "debate" ? "debate" : "cross_review",
      dualDebateRounds: clampDebateRounds(body.dualDebateRounds),
      globalInstructionId: body.globalInstructionId ?? null,
    })
    .returning();
  return Response.json(row, { status: 201 });
}

type PatchBody = {
  title?: string;
  systemPrompt?: string | null;
  model?: string;
  folderId?: string | null;
  responseMode?: "single" | "dual";
  dualModelA?: string | null;
  dualModelB?: string | null;
  dualStrategy?: "cross_review" | "debate";
  dualDebateRounds?: number;
  mcpServerIds?: string[];
  connectionIds?: string[];
  globalInstructionId?: string | null;
  currentLeafId?: string | null;
};

/**
 * PATCH /api/threads — Partially update a thread by id.
 * Specified via query string ?id=... (because it shares a route with the list page).
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

  const values: Partial<typeof threads.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.title === "string") values.title = body.title.trim();
  if (body.systemPrompt !== undefined) values.systemPrompt = body.systemPrompt;
  if (typeof body.model === "string") values.model = body.model;
  if (body.folderId !== undefined) values.folderId = body.folderId;
  if (body.responseMode === "single" || body.responseMode === "dual") values.responseMode = body.responseMode;
  if (body.dualModelA !== undefined) values.dualModelA = body.dualModelA || null;
  if (body.dualModelB !== undefined) values.dualModelB = body.dualModelB || null;
  if (body.dualStrategy === "cross_review" || body.dualStrategy === "debate") values.dualStrategy = body.dualStrategy;
  if (body.dualDebateRounds !== undefined) values.dualDebateRounds = clampDebateRounds(body.dualDebateRounds);
  if (Array.isArray(body.mcpServerIds)) values.mcpServerIds = body.mcpServerIds;

  if (Array.isArray(body.connectionIds)) values.connectionIds = body.connectionIds;
  if (body.globalInstructionId !== undefined) values.globalInstructionId = body.globalInstructionId || null;
  if (body.currentLeafId !== undefined) values.currentLeafId = body.currentLeafId;
  const [row] = await db
    .update(threads)
    .set(values)
    .where(and(eq(threads.id, id), eq(threads.userId, user.id)))
    .returning();
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}

function clampDebateRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 2;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}
