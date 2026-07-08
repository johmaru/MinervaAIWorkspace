# Pattern: API Route Handler

How to add or modify an API route handler in `src/app/api/`.

## Structure

Every API route in UmansChat follows the same shape:

```typescript
// src/app/api/<resource>/route.ts
// @vitest-environment node  // ← required for API route tests

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth-guards";
import { db } from "@/db";
import { threads } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// All routes are Node.js runtime, force-dynamic (no caching)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // 1. Auth — always first
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 2. User-scoped query — always filter by userId
  const rows = await db
    .select()
    .from(threads)
    .where(eq(threads.userId, user.id));

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  // 1. Auth
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 2. Parse body
  const body = await req.json();

  // 3. Validate (throw on bad input, don't silently fix)
  if (!body.title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  // 4. Insert — always include userId
  const [created] = await db
    .insert(threads)
    .values({ ...body, userId: user.id })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
```

## Dynamic route (`[id]/route.ts`)

```typescript
// src/app/api/<resource>/[id]/route.ts
// @vitest-environment node

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }  // ← params is a Promise in Next.js 15+
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;  // ← must await

  // DELETE/PATCH always combine id AND userId — never trust id alone
  await db
    .delete(threads)
    .where(and(eq(threads.id, id), eq(threads.userId, user.id)));

  return new NextResponse(null, { status: 204 });
}
```

## ✅ Good patterns

### Auth + user scoping on every route

```typescript
const user = await getSessionUser();
if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
// Every query: .where(eq(table.userId, user.id))
```

### Validate input explicitly

```typescript
if (!body.title || typeof body.title !== "string") {
  return NextResponse.json({ error: "title must be a string" }, { status: 400 });
}
```

### Combine id + userId on mutations

```typescript
.where(and(eq(threads.id, id), eq(threads.userId, user.id)))
```

## ❌ Bad patterns

### Missing auth guard

```typescript
// ❌ No getSessionUser() — anyone can access this route
export async function GET(req: NextRequest) {
  const rows = await db.select().from(threads);
  return NextResponse.json(rows);
}
```

### Missing user scoping

```typescript
// ❌ No userId filter — returns ALL users' data
const rows = await db.select().from(threads).where(eq(threads.id, id));
```

### Trusting id alone on DELETE/PATCH

```typescript
// ❌ Only filters by id — any user can delete any other user's data
await db.delete(threads).where(eq(threads.id, id));
```

### Using edge runtime

```typescript
// ❌ better-sqlite3 requires Node.js — edge runtime will crash
export const runtime = "edge";
```

### Forgetting `force-dynamic`

```typescript
// ❌ Without this, Next.js may cache the response and serve stale data
// export const dynamic = "force-dynamic";  ← missing
```

### Not awaiting params (Next.js 15+)

```typescript
// ❌ params is a Promise — destructuring without await gives wrong types
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;  // ← TypeScript error in Next.js 15+
}
```

## Test pattern

```typescript
// src/app/api/<resource>/route.test.ts
// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

import { getSessionUser } from "@/lib/auth-guards";
import { GET, POST } from "./route";

beforeEach(() => {
  vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "test@test.com" } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/<resource>", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/resource"));
    expect(res.status).toBe(401);
  });

  it("returns user-scoped resources", async () => {
    const res = await GET(new NextRequest("http://localhost/api/resource"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});
```

See also: [API Routes Reference](../api-routes.md), [Testing Guide](../testing.md)
