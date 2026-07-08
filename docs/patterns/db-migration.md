# Pattern: Database Migration

How to add or modify database tables in UmansChat.

## Golden rules

1. **Never edit an existing migration file.** Always generate a new one.
2. **Never delete a migration file.** They are the history of the schema.
3. **Always generate from the schema** — edit `src/db/schema.ts`, then generate.
4. **Test with real SQLite** — don't mock the database.

## Workflow

### 1. Edit the schema

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const newTable = sqliteTable("new_table", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
```

### 2. Generate the migration

```bash
bunx drizzle-kit generate
```

This creates a new file in `drizzle/` (e.g., `0007_add_new_table.sql`) with the
SQL diff, and updates `drizzle/meta/_journal.json`.

### 3. Apply the migration

```bash
bunx drizzle-kit migrate
```

For local dev, the `predev` hook also runs migrations automatically:

```bash
bun run dev   # runs migrations before starting the dev server
```

### 4. Write the store/query logic

```typescript
// src/lib/newStore.ts
import { db } from "@/db";
import { newTable } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function getNewTable(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(newTable)
    .where(and(eq(newTable.id, id), eq(newTable.userId, userId)));
  return row;
}

export async function createNewTable(userId: string, data: { name: string }) {
  const [created] = await db
    .insert(newTable)
    .values({ ...data, userId })
    .returning();
  return created;
}
```

### 5. Write tests

```typescript
// src/lib/newStore.test.ts
// @vitest-environment node

import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/db";
import { newTable, threads } from "@/db/schema";
import { createNewTable, getNewTable } from "./newStore";

afterAll(async () => {
  await db.delete(newTable);
  await db.delete(threads);
});

describe("newStore", () => {
  it("creates and retrieves by id + userId", async () => {
    const created = await createNewTable("user-1", { name: "Test" });
    const retrieved = await getNewTable("user-1", created.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("Test");
  });

  it("returns nothing for wrong userId", async () => {
    const created = await createNewTable("user-1", { name: "Test" });
    const retrieved = await getNewTable("user-2", created.id);
    expect(retrieved).toBeUndefined();
  });
});
```

## ✅ Good patterns

### Add column with default

```typescript
// ✅ Good — new column has a safe default
export const threads = sqliteTable("threads", {
  // ... existing columns
  newFlag: integer("new_flag", { mode: "boolean" }).notNull().default(false),
});
```

### Index on foreign key

```typescript
// ✅ Good — index on FK column for query performance
import { index } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    // ...
  },
  (table) => ({
    threadIdx: index("messages_thread_id_idx").on(table.threadId),
  })
);
```

### User-scoped table

```typescript
// ✅ Good — userId column for user isolation
export const customResources = sqliteTable("custom_resources", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull(),  // ← required for user isolation
  name: text("name").notNull(),
});
```

## ❌ Bad patterns

### Editing existing migration

```bash
# ❌ Never do this — edit 0005_strong_zaran.sql to add a column
# Instead:
# 1. Edit src/db/schema.ts
# 2. Run: bunx drizzle-kit generate
# 3. A NEW migration file is created
```

### Breaking change without migration

```typescript
// ❌ Bad — changed column type in schema.ts but didn't generate migration
// The app will crash at runtime: schema doesn't match DB
```

### Missing user isolation

```typescript
// ❌ Bad — table without userId column
export const globalSettings = sqliteTable("global_settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  // ← no userId: all users share the same settings (unless intentional)
});
```

### Mocking the database in tests

```typescript
// ❌ Bad — mocked DB doesn't test real SQL behavior
vi.mock("@/db", () => ({
  db: { insert: vi.fn().mockReturnValue({ returning: vi.fn() }) }
}));
```

```typescript
// ✅ Good — real SQLite, setup + teardown
// @vitest-environment node
import { db } from "@/db";
```

## Embedding dimension migration

When changing `EMBED_MODEL` to one with a different dimension:

1. User changes the model in the Settings GUI (or `.env`).
2. The settings route detects the dimension change.
3. User confirms the migration warning.
4. The route recreates the vector columns (including HNSW indexes).
5. **All existing embeddings are lost** — they must be re-generated.

This is handled automatically by the settings API route. Do NOT add manual
dimension migration code — use the existing mechanism.

See: [Embeddings & Vector Search](../embeddings.md), [Settings & Environment](../settings-env.md)

## Migration file structure

```
drizzle/
├── 0000_initial.sql
├── 0001_add_xxx.sql
├── ...
├── 0006_puzzling_bullseye.sql
└── meta/
    ├── _journal.json          ← tracks migration order
    ├── 0000_snapshot.json
    ├── 0001_snapshot.json
    └── ...
```

Each migration is a plain SQL file. Snapshots are Drizzle's internal state —
do not edit them manually.

See also: [Database & Schema](../database.md), [Testing Guide](../testing.md)
