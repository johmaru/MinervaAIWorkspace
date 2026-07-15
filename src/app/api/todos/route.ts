import { getSessionUser } from "@/lib/auth-guards";
import { listTodos, createTodo, type TodoStatus, type TodoPriority } from "@/lib/todoStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/todos — list the logged-in user's todos, optionally filtered by status.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "pending" || statusParam === "in_progress" || statusParam === "completed"
      ? (statusParam as TodoStatus)
      : undefined;

  const rows = await listTodos(user.id, status);
  // Strip embedding from response (not needed by the client)
  const stripped = rows.map(({ embedding: _e, contentHash: _c, model: _m, ...rest }) => rest);
  return Response.json(stripped);
}

type CreateBody = {
  title?: string;
  description?: string;
  priority?: TodoPriority;
  dueAt?: string | null;
  threadId?: string | null;
};

/**
 * POST /api/todos — create a todo.
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

  const title = body.title?.trim();
  if (!title) return new Response("title is required", { status: 400 });

  const priority: TodoPriority =
    body.priority === "low" || body.priority === "medium" || body.priority === "high"
      ? body.priority
      : "medium";

  const dueAt = body.dueAt ? new Date(body.dueAt) : null;

  const row = await createTodo(user.id, {
    title,
    description: body.description,
    priority,
    dueAt: dueAt ?? undefined,
    threadId: body.threadId ?? null,
  });

  // Strip embedding from response
  const { embedding: _e, contentHash: _c, model: _m, ...rest } = row;
  return Response.json(rest, { status: 201 });
}
