# User Traits — Persistent User Profile System

**Date:** 2026-07-10
**Status:** Draft

## Problem

The existing `memories` system extracts durable facts about the user ("20歳らしい", "ラテン語が好き", "よく〜だろと言う") as `kind: "fact"`, but retrieves them via cosine similarity (`> 0.3`) and a recency-weighted top-5 ranking. When the user asks an unrelated question (e.g. a coding question), these profile attributes lose the similarity race and are **not injected**. The assistant loses user context on every turn that isn't semantically close to the trait.

The personalization system (`buildPersonalizationMessage`) is always-injected but covers only style/tone sliders — it does not store user-specific facts.

`global_instructions` is always-injected and could hold a free-text profile, but it is manual-only, has no auto-extraction, and mixes user identity with system instructions.

## Goal

Store **persistent user traits** — stable attributes about the user that should be available in every conversation regardless of topic — and inject them into every chat turn.

### Trait examples

- Demographic: "20歳らしい"
- Interest: "ラテン語が好きらしい"
- Speech pattern: "よく「〜だろ」という表現を使う"
- Preference: "簡潔な回答を好む"

## Why a separate table (not extending `memories`)

Extending `memories` with `kind: "profile"` was considered and rejected. The `memories` table has three structural constraints that make it unsuitable for user-global persistent data:

1. **Cascade delete.** `threadId` is NOT NULL with `onDelete: "cascade"` (schema.ts:346-348). Deleting a conversation physically deletes its memories. A profile trait extracted in a thread the user later deletes would be lost permanently.

2. **Thread/folder scoping.** `generateMemories` fetches existing memories for dedup/replace via `scopeCondition` (memory.ts:290-310, 365-370), which is folder-or-thread scoped. The duplicate check (line 432-442) and contradiction candidates (line 449-457) are also scope-bound. In folder-scoped mode, profile traits from folder A are invisible when chatting in folder B — the LLM cannot dedup, replace, or merge, and will create duplicate profile entries across folders.

3. **No direct `userId`.** `memories` has no `userId` column; user scoping is derived via `innerJoin(threads)`. Profile traits are inherently user-global, not thread-scoped. Retrofitting user-global semantics onto a thread-scoped table requires ~4 query-path rewrites and a nullable `threadId` + `userId` column addition (real DDL).

A separate `user_traits` table with a direct `userId` FK sidesteps all three problems.

## Why not a vector DB

The codebase architecture explicitly states "no vector DB, no vector extension dependency" (architecture.md:46-47). Embeddings are JSON arrays in `text` columns with pure-JS cosine similarity. Profile traits are few (tens, not thousands) and should be **always injected**, not similarity-filtered. Vector search adds complexity for no benefit at this scale.

## Design

### New table: `user_traits`

```sql
CREATE TABLE user_traits (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,  -- "demographic" | "interest" | "speech_pattern" | "preference"
  content         TEXT NOT NULL,
  embedding       TEXT NOT NULL,   -- JSON array (same format as memories.embedding)
  content_hash    TEXT NOT NULL,   -- SHA-256, same dedup pattern as memories
  model           TEXT NOT NULL,  -- embed model name (same as memories.model)
  confidence      REAL NOT NULL DEFAULT 0.5,
  evidence_count  INTEGER NOT NULL DEFAULT 1,
  suppressed_at   TIMESTAMP,      -- soft-delete (user or contradiction)
  source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  source_message_ids TEXT (JSON array),
  created_at      TIMESTAMP NOT NULL,
  updated_at      TIMESTAMP NOT NULL
);
```

**Key design decisions:**

- **`userId` direct FK** — user-global scope, no thread join needed. `onDelete: "cascade"` ensures traits are cleaned up when a user is deleted.
- **`sourceThreadId` nullable with `ON DELETE SET NULL`** — the trait survives thread deletion. The thread reference is for traceability only, not ownership.
- **`category`** — structured classification for potential UI grouping and dedup within category.
- **`confidence` (0.0–1.0)** — starts at 0.5 for a single observation, increases with repeated evidence. Affects injection ordering.
- **`evidenceCount`** — how many times this trait was observed. Drives confidence updates.
- **`suppressedAt`** — soft-delete for user-initiated deletion or contradiction invalidation. Same pattern as `memories.suppressedAt`.
- **`embedding` + `contentHash`** — reuses the proven pattern from `memories`. Embeddings are **not** used for retrieval (traits are always injected, not similarity-searched). They are used for: (1) **Dedup** — `contentHash` catches exact duplicates; `cosineSimilarity > 0.85` catches semantic duplicates ("ラテン語が好き" vs "ラテン語を好む") that `contentHash` misses. (2) **Contradiction candidate selection** — `cosineSimilarity > 0.75` against same-category active traits selects candidates for `checkContradiction()`, identical to the `memories` pattern (memory.ts:449-461). Without embeddings, every new trait would require LLM contradiction checks against all active traits — up to 30 LLM calls per trait per turn.

### Extraction — shared LLM call, no extra cost

Profile trait extraction happens **inside the existing `generateMemories` LLM call** — zero additional LLM cost per turn.

**Prompt change:** The extraction system prompt (`memory.ts:34-52`) gains a third classification:

```
Classify each memory as:
- "fact": topics discussed, decisions made, environment info, subjects explored
- "working": current task, temporary context, recent decisions, ongoing discussion topic
- "profile": stable user attributes — age, gender, occupation, interests, languages,
  speech patterns, communication preferences, recurring self-descriptions.
  These are things that are true about the user across all conversations.
```

**Output schema:** The JSON array elements gain `"kind": "fact"|"working"|"profile"`. `profile` entries additionally include `"category": "demographic"|"interest"|"speech_pattern"|"preference"`.

**Routing in `generateMemories`:** After `parseExtraction()`, extracted items are split:
- `kind === "profile"` → routed to `processProfileTraits()` (new function in `memory.ts`)
- `kind === "fact"|"working"` → existing memory processing (unchanged)

### `processProfileTraits(userId, traits, llm, model)`

For each extracted profile trait:

1. **Dedup by contentHash + cosine similarity.** Compute `contentHash` (SHA-256) of the new trait content. Query active `user_traits` for the same `userId` and `category`. First check exact duplicate via `contentHash` match (skip if found). Then compute `cosineSimilarity` against each existing trait's embedding in the same category. If similarity > 0.85, treat as the same trait (semantic duplicate — e.g. "ラテン語が好き" vs "ラテン語を好む").

2. **Increment confidence.** If a match is found:
   - `evidenceCount += 1`
   - `confidence = Math.min(1.0, confidence + 0.15)`
   - `updatedAt = now`
   - If the new content is richer (longer, more specific), update `content`.

3. **Contradiction detection.** If a new trait in the same `category` has cosine similarity > 0.75 but ≤ 0.85 against an existing trait (semantically close but not a duplicate — e.g. "20歳" vs "25歳"), call `checkContradiction()` (existing function in `memory.ts:189-216`). This mirrors the `memories` pattern (memory.ts:449-461): embeddings select candidates, LLM confirms contradiction. If contradiction:
   - Soft-delete the old trait (`suppressedAt = now`)
   - Insert the new trait

4. **Insert new.** If no match and no contradiction, insert with `confidence = 0.5`, `evidenceCount = 1`.

### Retrieval — always inject

**New function: `findProfileTraits(userId)` in `traitStore.ts`**

```typescript
export async function findProfileTraits(
  userId: string,
  limit = 30,
): Promise<ProfileTrait[]>
```

Queries active (`suppressedAt IS NULL`) `user_traits` for the user, ordered by `confidence DESC, updatedAt DESC`, limited to 30 rows.

### Injection — in `buildMemoryContext`

`buildMemoryContext` (`memoryStore.ts:303-353`) gains a parallel `findProfileTraits(userId)` call alongside `findRelevantMemories` and `fetchRecentThreadTitles`:

```typescript
const [found, recentTitles, profileTraits] = await Promise.all([
  findRelevantMemories(content, thread.folderId, userId),
  fetchRecentThreadTitles(userId, currentThreadId),
  findProfileTraits(userId),
]);
```

The profile traits are prepended as a new section in the system message:

```
## User Traits
Stable attributes about the user. Apply these in every conversation:
- [demographic] 20歳らしい
- [interest] ラテン語が好き
- [speech_pattern] よく「〜だろ」という表現を使う

## Past Memories
(existing RAG results)
```

The profile section is placed **before** the memory RAG section so the LLM sees user identity context first.

### Token budget

30 traits × ~20 chars avg = ~600 chars. Comparable to the personalization message. Negligible vs. conversation history.

## API

### `GET /api/user-traits`

List all active traits for the authenticated user. Returns `{ id, category, content, confidence, evidenceCount, updatedAt }`.

### `POST /api/user-traits`

Manual trait creation. Body: `{ content, category }`. Creates with `confidence = 1.0` (user-authored = high trust), `evidenceCount = 1`.

### `PATCH /api/user-traits/[id]`

Edit `content` and/or `category`. Does not touch `confidence` / `evidenceCount`.

### `DELETE /api/user-traits/[id]`

Soft-delete (`suppressedAt = now`). Same pattern as memories.

All routes use `getSessionUser()` + `eq(userTraits.userId, user.id)`, following the existing API pattern.

## UI — MemoryViewerModal extension

The MemoryViewerModal gains a new filter option: `"profile"`. When selected, it fetches from `/api/user-traits` instead of `/api/memories`.

- Filter dropdown: すべて | 事実(fact) | 作業中(working) | ユーザー特性(profile)
- Profile items display with a distinct color badge (green) and category label
- Add form gains a category selector when `profile` is selected
- Edit/delete work the same way, hitting `/api/user-traits/[id]`

## Schema migration

Migration `0009_user_traits.sql`:

```sql
CREATE TABLE `user_traits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL,
  `content` text NOT NULL,
  `embedding` text NOT NULL,
  `content_hash` text NOT NULL,
  `model` text NOT NULL,
  `confidence` real NOT NULL DEFAULT 0.5,
  `evidence_count` integer NOT NULL DEFAULT 1,
  `suppressed_at` integer,
  `source_thread_id` text REFERENCES `threads`(`id`) ON DELETE SET NULL,
  `source_message_ids` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `user_traits_user_idx` ON `user_traits` (`user_id`);
CREATE INDEX `user_traits_category_idx` ON `user_traits` (`category`);
CREATE INDEX `user_traits_suppressed_idx` ON `user_traits` (`suppressed_at`);
```

## Files to change

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `userTraits` table definition |
| `drizzle/0009_user_traits.sql` | New migration |
| `src/lib/memory.ts` | Extend `SYSTEM_PROMPT` with `profile` kind; add `processProfileTraits()`; route profile items in `generateMemories` |
| `src/lib/traitStore.ts` | New file: `findProfileTraits()` |
| `src/lib/memoryStore.ts` | Add `findProfileTraits` call in `buildMemoryContext`; add profile section to system message |
| `src/app/api/user-traits/route.ts` | New: GET + POST |
| `src/app/api/user-traits/[id]/route.ts` | New: PATCH + DELETE |
| `src/components/MemoryViewerModal.tsx` | Add profile filter, category selector, profile badge color |
| `src/lib/i18n/dictionaries.ts` | Add `profile` labels (ja + en) |
## Non-goals

- **No similarity search for retrieval.** Traits are always injected (up to 30), not filtered by query similarity. Embeddings are used only for dedup and contradiction candidate selection.
- **No LLM reranking of traits.** Confidence + recency sort is sufficient.
- **No migration of existing `fact` memories to `user_traits`.** Existing memories stay where they are; only new extractions get routed.
- **No per-category confidence thresholds.** All active traits within the 30-row limit are injected.
