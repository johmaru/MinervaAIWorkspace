import { desc, eq } from "drizzle-orm";
import { defaultModel } from "@/lib/llm";
import { db } from "@/db";
import { threads } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/threads — スレッド一覧（新着順）。本文は含まずメタのみ。
 */
export async function GET() {
  const rows = await db
    .select({
      id: threads.id,
      title: threads.title,
      folderId: threads.folderId,
      createdAt: threads.createdAt,
      updatedAt: threads.updatedAt,
    })
    .from(threads)
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
};

/**
 * POST /api/threads — 新規スレッド作成。
 */
export async function POST(req: Request) {
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
      systemPrompt: body.systemPrompt,
      model: body.model ?? defaultModel(),
      folderId: body.folderId ?? null,
      responseMode: body.responseMode === "dual" ? "dual" : "single",
      dualModelA: body.dualModelA ?? null,
      dualModelB: body.dualModelB ?? null,
      dualStrategy: body.dualStrategy === "debate" ? "debate" : "cross_review",
      dualDebateRounds: clampDebateRounds(body.dualDebateRounds),
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
};

/**
 * PATCH /api/threads — 指定 id のスレッドを部分更新。
 * クエリ文字列 ?id=... で指定（一覧ページと同居するルートのため）。
 */
export async function PATCH(req: Request) {
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

  const [row] = await db
    .update(threads)
    .set(values)
    .where(eq(threads.id, id))
    .returning();
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}

function clampDebateRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 2;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}
