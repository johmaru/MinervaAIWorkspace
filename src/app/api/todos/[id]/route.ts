import { getSessionUser } from "@/lib/auth-guards";
import { getTodo, updateTodo, deleteTodo, type TodoStatus, type TodoPriority } from "@/lib/todoStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/todos/[id] — get a single todo (user-scoped).
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const row = await getTodo(user.id, id);
  if (!row) return new Response("Not found", { status: 404 });

  const { embedding: _e, contentHash: _c, model: _m, ...rest } = row;
  return Response.json(rest);
}

type PatchBody = {
  title?: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  dueAt?: string | null;
};

/**
 * PATCH /api/todos/[id] — update a todo.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: PatchBody = {};
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const status =
    body.status === "pending" || body.status === "in_progress" || body.status === "completed"
      ? body.status
      : undefined;
  const priority =
    body.priority === "low" || body.priority === "medium" || body.priority === "high"
      ? body.priority
      : undefined;

  const dueAt =
    body.dueAt === null
      ? null
      : body.dueAt
        ? new Date(body.dueAt)
        : undefined;

  const row = await updateTodo(user.id, id, {
    title: body.title,
    description: body.description,
    status,
    priority,
    dueAt,
  });

  if (!row) return new Response("Not found", { status: 404 });

  const { embedding: _e, contentHash: _c, model: _m, ...rest } = row;
  return Response.json(rest);
}

/**
 * DELETE /api/todos/[id] — physically delete a todo.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const existing = await getTodo(user.id, id);
  if (!existing) return new Response("Not found", { status: 404 });

  await deleteTodo(user.id, id);
  return new Response(null, { status: 204 });
}
