import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/skills — Skills of the logged-in user (newest first).
 * Excludes embedding; returns metadata only.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      kind: skills.kind,
      trigger: skills.trigger,
      tags: skills.tags,
      scope: skills.scope,
      status: skills.status,
      version: skills.version,
      lastUsedAt: skills.lastUsedAt,
      successCount: skills.successCount,
      failureCount: skills.failureCount,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(eq(skills.userId, user.id))
    .orderBy(desc(skills.updatedAt)).limit(100);
  return Response.json(rows);
}

type CreateBody = {
  name?: string;
  content?: string;
  kind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger?: string;
  tags?: string[];
};

/**
 * POST /api/skills — Manual skill creation.
 * Accepts name + content, saves with kind/trigger/tags.
 * Embedding is generated from the combined text of name + trigger + tags + content.
 * Returns 409 Conflict if contentHash matches an existing skill.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const name = body.name?.trim();
  const content = body.content?.trim();
  if (!name || !content) {
    return new Response("name and content are required", { status: 400 });
  }
  const kind = body.kind ?? "workflow";
  const trigger = body.trigger?.trim() || "";
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === "string")
    : [];

  // Generate embedding: from combined text of name + trigger + tags + content
  const embedSource = [name, trigger, tags.join(", "), content].filter(Boolean).join("\n");
  const vector = await embedText(embedSource, "document");
  if (vector.length === 0) {
    return new Response("Embedding failed", { status: 503 });
  }
  const contentHash = hashContent(content);

  const [dup] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, user.id), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (dup) return new Response("Skill already exists", { status: 409 });

  const [row] = await db
    .insert(skills)
    .values({
      userId: user.id,
      name,
      content,
      embedding: vector,
      contentHash,
      kind,
      trigger,
      tags,
    })
    .returning({ id: skills.id, name: skills.name, content: skills.content });
  return Response.json(row, { status: 201 });
}
