# Pattern: Writing Tests

How to write tests in UmansChat. Every new feature and bug fix MUST include tests.

## File placement

Co-locate test files **next to the source**:

```
src/lib/memory.ts          → src/lib/memory.test.ts
src/app/api/threads/route.ts → src/app/api/threads/route.test.ts
src/components/Sidebar.tsx → src/components/Sidebar.test.tsx
src/hooks/useChat.ts       → src/hooks/useChat.test.ts
```

Do **not** create a `__tests__/` or `tests/` directory.

## Test environment

### Default: jsdom (components, hooks)

No annotation needed:

```typescript
// src/components/Sidebar.test.tsx
import { describe, it, expect } from "vitest";
// jsdom is the default environment
```

### Node environment (lib, API routes)

Add `// @vitest-environment node` as the **first line**:

```typescript
// src/lib/memory.test.ts
// @vitest-environment node    ← MUST be the first line
import { describe, it, expect } from "vitest";
```

```typescript
// src/app/api/threads/route.test.ts
// @vitest-environment node    ← MUST be the first line
import { describe, it, expect } from "vitest";
```

This is the Vitest 4 mechanism (replaces the removed `environmentMatchGlobs`).

## ✅ Good patterns

### Test behavior, not implementation

```typescript
// ✅ Good — tests what the function does, not how it does it
it("returns top-5 memories above similarity threshold", async () => {
  // Setup: insert memories with known embeddings
  await insertMemory({ content: "User likes Python", embedding: [0.9, ...] });
  await insertMemory({ content: "User knows Rust", embedding: [0.1, ...] });

  const results = await findRelevantMemories("What programming language?", user.id);
  expect(results).toHaveLength(1);
  expect(results[0].content).toBe("User likes Python");
});
```

```typescript
// ❌ Bad — tests internal state, breaks on refactor
it("calls cosineSimilarity with correct arguments", () => {
  const spy = vi.spyOn(math, "cosineSimilarity");
  findRelevantMemories("test", user.id);
  expect(spy).toHaveBeenCalledWith(expect.any(Array), expect.any(Array));
});
```

### Test edge cases and error handling

```typescript
// ✅ Good — covers edge values, error paths, invariants
describe("POST /api/threads", () => {
  it("returns 400 when title is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when title is empty string", async () => {
    const res = await POST(makeRequest({ title: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 201 with created thread", async () => {
    const res = await POST(makeRequest({ title: "New thread" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.title).toBe("New thread");
  });
});
```

### DB tests use real SQLite

```typescript
// ✅ Good — real database, setup + teardown
// @vitest-environment node
import { db } from "@/db";
import { threads, messages } from "@/db/schema";
import { eq } from "drizzle-orm";

afterAll(async () => {
  // Clean up all test data
  await db.delete(messages);
  await db.delete(threads);
});

it("persists message to database", async () => {
  const [thread] = await db.insert(threads).values({
    title: "Test",
    userId: "test-user",
  }).returning();

  const [msg] = await db.insert(messages).values({
    threadId: thread.id,
    role: "user",
    content: "Hello",
    parentId: null,
  }).returning();

  expect(msg.id).toBeDefined();
  expect(msg.content).toBe("Hello");

  // Cleanup
  await db.delete(messages).where(eq(messages.id, msg.id));
  await db.delete(threads).where(eq(threads.id, thread.id));
});
```

```typescript
// ❌ Bad — mocking the database
vi.mock("@/db", () => ({
  db: { insert: vi.fn(), select: vi.fn() }
}));
```

### Mock external APIs with itReal() pattern

```typescript
// ✅ Good — gate behind helper, skip with clear reason
const itReal = process.env.LLM_API_KEY ? it : it.skip;

describe("LLM client", () => {
  itReal("returns a response from the real API", async () => {
    const result = await generateChatCompletion({
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(result.content).toBeDefined();
  });
});

// For tests that DON'T need the real API, mock it:
vi.mock("@/lib/llm", () => ({
  generateChatCompletion: vi.fn().mockResolvedValue({ content: "mocked" }),
}));
```

### Clean up in afterEach

```typescript
// ✅ Good — clean up all side effects
afterEach(() => {
  cleanup();                    // React Testing Library
  vi.restoreAllMocks();        // Restore mocked functions
  vi.unstubAllGlobals();        // Restore stubbed globals
  // Restore env vars if stubbed
  vi.unstubAllEnvs();
});
```

### Mock auth via getSessionUser

```typescript
// ✅ Good — mock auth, use real DB
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

import { getSessionUser } from "@/lib/auth-guards";

beforeEach(() => {
  vi.mocked(getSessionUser).mockResolvedValue({
    id: "test-user",
    email: "test@test.com",
  } as never);
});
```

## ❌ Bad patterns

### Weakening assertions to pass

```typescript
// ❌ Bad — removing assertion to make test pass
it("filters by userId", async () => {
  const results = await getThreads("user-1");
  // Originally: expect(results).toHaveLength(3)
  // Changed to: (removed to make it pass)
});
```

```typescript
// ✅ Fix the code, don't weaken the test
it("filters by userId", async () => {
  const results = await getThreads("user-1");
  expect(results).toHaveLength(3);
  expect(results.every(r => r.userId === "user-1")).toBe(true);
});
```

### Testing obvious plumbing

```typescript
// ❌ Bad — restating the code, no value
it("calls db.select", () => {
  const spy = vi.spyOn(db, "select");
  getThreads("user-1");
  expect(spy).toHaveBeenCalled();
});
// This tells you nothing about behavior — just that the function runs.
```

### Not testing error paths

```typescript
// ❌ Bad — only tests the happy path
it("creates a thread", async () => {
  const res = await POST(makeRequest({ title: "Test" }));
  expect(res.status).toBe(201);
});
// Missing: what if title is missing? What if user is not authenticated?
```

## Running tests

```bash
bun run test          # single run
bun run test:watch    # watch mode
bun run test -- --reporter=verbose   # verbose output
```

## Pool configuration

Vitest uses `threads` pool (not `forks`). This is because `sharp` and
`@xenova/transformers` native modules crash with the `forks` pool.
Config: `vitest.config.mts`.

## Before claiming done

1. `bun run test` — zero failures
2. `bun run typecheck` — zero errors
3. `bun run lint` — zero errors
4. All new code has co-located tests
5. No assertions weakened or deleted

See also: [Testing Guide](../testing.md)
