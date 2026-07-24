Reusable cross-thread procedures and rules, matched to conversations via embedding-based RAG and injected into the system prompt.

## Relevant source files

| File | Purpose |
|------|---------|
| `src/lib/skillStore.ts` | Skill retrieval (`findRelevantSkills`) and injection (`buildSkillContext`) |
| `src/lib/skillGenerator.ts` | Explicit skill generation from a conversation (`generateSkillFromConversation`) |
| `src/lib/skillCandidate.ts` | Auto-extraction of skill candidates (`extractSkillCandidates`) |
| `src/db/schema.ts` | `skills`, `skill_candidates`, `skill_usage_events` table definitions (lines 96–178) |
| `src/app/api/skills/route.ts` | `GET` / `POST /api/skills` |
| `src/app/api/skills/[id]/route.ts` | `PATCH` / `DELETE /api/skills/[id]` |
| `src/app/api/skill-candidates/route.ts` | `GET /api/skill-candidates` |
| `src/app/api/skill-candidates/[id]/route.ts` | `PATCH` / `DELETE /api/skill-candidates/[id]` (approve / reject / merge) |
| `src/app/api/chat/route.ts` | Skill injection (line 231), explicit-save trigger (line 519), candidate gating (line 529) |
| `src/components/SkillManagerModal.tsx` | Management UI (3 tabs: Active / Drafts / Archived) |
| `src/lib/embed.ts` | `embedText()`, `hashContent()` |
| `src/lib/vectorSearch.ts` | `cosineSimilarity()` — pure JS, no pgvector |

## Overview

Skills are **permanent, cross-thread** reusable procedures and rules — distinct from memories, which are ephemeral per-thread context fragments. While memories capture *what was discussed* (facts, working context), skills capture *how to do things* (workflows, debugging patterns, project conventions, tool usage). A skill created in one thread is searchable and injectable into any future thread owned by the same user.

The lifecycle has three paths:

1. **Explicit generation** — the user says "save as skill", and the entire conversation is summarized into a single skill via the LLM, embedded, and inserted directly into the `skills` table.
2. **Auto candidate extraction** — after every substantive conversation, up to 3 skill candidates are extracted as drafts, pending user approval before promotion to the `skills` table.
3. **Manual creation** — the user creates a skill directly via the REST API or the SkillManagerModal UI.

Once a skill exists in the `skills` table with `status = "active"`, it is retrieved on every subsequent message send via **client-side cosine similarity** (RAG) and/or manual name matching, then injected as a system message into the LLM context. See [Chat & Streaming](./chat-streaming.md) for the full message assembly flow.

### Skills vs. memories

| Aspect | Skills | Memories |
|--------|--------|----------|
| Scope | Cross-thread, permanent | Per-thread (or folder-scoped), ephemeral |
| Content | Reusable procedures / rules | Facts, working context |
| Extraction trigger | Explicit "save as skill" OR auto-candidate after substantive conversation | After every assistant response |
| Approval | Auto-extracted candidates require user approval | Fully automatic |
| Retrieval | Cosine similarity > 0.3, top 5 | Cosine similarity > 0.3, recency-weighted, top 5 |
| Storage | `skills` table | `memories` table |

See [Memory System](./memory.md) for the memory subsystem.

## The 6 skill kinds

Every skill is categorized by a `kind` field. The same enum is used in the `skills` table, the `skill_candidates` table, and all LLM extraction prompts.

| Kind | Description |
|------|-------------|
| `workflow` | Concrete reusable procedures (step-by-step workflows) |
| `bugfix` | How a specific bug was diagnosed and fixed |
| `project_rule` | Conventions, gotchas, must-do rules for this codebase |
| `tool_usage` | How to use a specific tool/API correctly |
| `coding_pattern` | Reusable code patterns or architectural decisions |
| `debugging` | Debugging patterns (diagnosis patterns, distinct from `bugfix` which captures a specific fix) |

Default kind is `workflow` when the LLM returns an unrecognized value or when no kind is specified during manual creation.

## Skills table — field reference

Defined in `src/db/schema.ts:107-129`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `text` PK | `randomUUID()` | UUID primary key |
| `userId` | `text` NOT NULL FK | — | Owner. Cascade delete when user is deleted. |
| `name` | `text` NOT NULL | — | Short skill name (2–5 words recommended) |
| `content` | `text` NOT NULL | — | Reusable instructions in second person ("You should… / When X happens, do Y") |
| `embedding` | `text` NOT NULL (JSON) | — | `number[]` — embedding vector. Drizzle auto-parses on read. |
| `contentHash` | `text` NOT NULL | — | SHA-256 hash of `content`, for deduplication |
| `kind` | `text` NOT NULL enum | `"workflow"` | One of the 6 skill kinds |
| `trigger` | `text` | NULL | Natural-language description of when to apply this skill |
| `tags` | `text` NOT NULL (JSON) | `[]` | `string[]` — improves searchability |
| `scope` | `text` NOT NULL enum | `"global"` | `"global"` / `"folder"` / `"thread"` (schema field; retrieval currently searches all active skills for the user regardless of scope) |
| `status` | `text` NOT NULL enum | `"active"` | `"active"` or `"archived"` |
| `version` | `integer` NOT NULL | `1` | Incremented when `content` changes via PATCH |
| `sourceThreadId` | `text` FK | NULL | Thread the skill was generated from. Set null on thread delete. |
| `sourceMessageIds` | `text` (JSON) | NULL | `string[]` — message IDs that contributed (schema field; not populated in current generation flow) |
| `lastUsedAt` | `timestamp` | NULL | Updated on each injection via `buildSkillContext()` |
| `successCount` | `integer` NOT NULL | `0` | Lifetime count of `helpful` feedback outcomes (updated via `POST /api/skill-usage/[id]/feedback`) |
| `failureCount` | `integer` NOT NULL | `0` | Lifetime count of `not_helpful` feedback outcomes (updated via `POST /api/skill-usage/[id]/feedback`) |
| `createdAt` | `timestamp` | `now()` | Creation time |
| `updatedAt` | `timestamp` | `now()` | Last modification time |

### Skill candidates table

Defined in `src/db/schema.ts:136-158`. Candidates are auto-extracted drafts pending approval:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `text` PK | `randomUUID()` | UUID primary key |
| `userId` | `text` NOT NULL FK | — | Owner. Cascade delete. |
| `threadId` | `text` FK | NULL | Thread the candidate was extracted from. Cascade delete. |
| `sourceMessageIds` | `text` (JSON) | NULL | `string[]` (schema field; not populated in current flow) |
| `proposedName` | `text` NOT NULL | — | Extracted skill name |
| `proposedKind` | `text` NOT NULL enum | — | One of the 6 kinds (no default — always set by extraction) |
| `proposedTrigger` | `text` NOT NULL | — | When to apply this skill |
| `proposedContent` | `text` NOT NULL | — | Reusable instructions |
| `proposedTags` | `text` NOT NULL (JSON) | `[]` | `string[]` |
| `confidence` | `real` NOT NULL | `0.5` | LLM-assigned confidence score (0.0–1.0) |
| `reason` | `text` | NULL | LLM-provided explanation of why this skill is worth saving |
| `status` | `text` NOT NULL enum | `"draft"` | `draft` → `approved` / `rejected` / `merged` |
| `createdAt` | `timestamp` | `now()` | Creation time |
| `updatedAt` | `timestamp` | `now()` | Last modification time |

### Skill usage events table

Defined in `src/db/schema.ts:166-178`. Records each skill injection event:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `text` PK | `randomUUID()` | UUID primary key |
| `skillId` | `text` NOT NULL FK | — | The skill that was injected. Cascade delete. |
| `userId` | `text` NOT NULL FK | — | User who triggered the injection. Cascade delete. |
| `threadId` | `text` NOT NULL FK | — | Thread where injection occurred. Cascade delete. |
| `messageId` | `text` | NULL | Assistant message ID, attached after the assistant message is saved (via `attachUsageMessageIds`) |
| `similarity` | `real` | NULL | Cosine similarity score at injection time |
| `activationType` | `text` NOT NULL enum | — | `"semantic"` (search match) or `"manual"` (name-specified) |
| `outcome` | `text` NOT NULL enum | `"unknown"` | `"unknown"` / `"helpful"` / `"not_helpful"` — set via `POST /api/skill-usage/[id]/feedback` |
| `createdAt` | `timestamp` | `now()` | When the injection occurred |

See [Database & Schema](./database.md) for the full schema reference.

## Skill retrieval — `findRelevantSkills()`

Located in `src/lib/skillStore.ts:32-65`. This is the core RAG search function for skills.

```typescript
export async function findRelevantSkills(
  query: string,
  userId: string,
  limit = 5,
): Promise<ScoredSkill[]>
```

### Algorithm

1. **Embed the query** via `embedText(query, "query")`. Returns `[]` immediately if embedding fails (e.g., model still loading).
2. **Fetch all active skills** for the user: `SELECT id, name, content, embedding FROM skills WHERE userId = ? AND status = 'active'`.
3. **Compute cosine similarity** client-side for each skill: `cosineSimilarity(queryVector, row.embedding)`.
4. **Filter** by `similarity > 0.3` (same threshold as memory retrieval).
5. **Sort** by similarity descending.
6. **Take top `limit`** (default 5).
7. **Round** similarity to 3 decimal places.

Returns an array of `ScoredSkill` objects:

```typescript
export type ScoredSkill = {
  id: string;
  name: string;
  content: string;
  similarity: number;
};
```

> **Note:** Unlike memory retrieval, skill retrieval does **not** apply recency scoring or importance weighting. It is pure cosine similarity. See [Embeddings & Vector Search](./embeddings.md) for the `cosineSimilarity()` implementation.

## Skill injection — `buildSkillContext()`

Located in `src/lib/skillStore.ts:78-161`. Called from the chat route (line 231) during message preparation, **before** the LLM stream begins. In rapid mode (`body.rapid`), skill injection is skipped entirely.

```typescript
export async function buildSkillContext({
  content,
  userId,
  threadId,
}: {
  content: string;
  userId: string;
  threadId?: string;
}): Promise<{ role: "system"; content: string } | null>
```

### Step 1 — Manual skill name detection

The function first checks if the user explicitly requested a specific skill by name, using two regex patterns:

- **Japanese:** `/(.+?)スキルを使っ(?:て|え)/` — matches "Xスキルを使って" or "Xスキルを使え"
- **English:** `/use\s+(.+?)\s+skill/i` — matches "use X skill"

If a name is captured, a partial-match search is performed via SQLite `LIKE` (case-insensitive by default):

```typescript
const pattern = `%${name.replace(/[%_]/g, "\\$&")}%`;
```

The `%` and `_` wildcard characters in the captured name are escaped to prevent injection. The first matching active skill for the user is returned with `similarity: 1` (maximum confidence for manual activation).

### Step 2 — Semantic search

`findRelevantSkills(content, userId)` is called with the full user message content as the query, returning up to 5 skills with `similarity > 0.3`.

### Step 3 — Merge and dedup

The manually-specified skill (if found) is prepended to the semantic results. Deduplication is performed by skill `id` using a `Set`:

```typescript
const seen = new Set<string>();
const merged: ScoredSkill[] = [];
if (namedSkill) {
  merged.push(namedSkill);
  seen.add(namedSkill.id);
}
for (const s of semantic) {
  if (!seen.has(s.id)) {
    merged.push(s);
    seen.add(s.id);
  }
}
```

This ensures a skill matched both by name and semantically appears only once, with manual activation taking priority.

### Step 4 — Usage tracking (fire-and-forget)

If `threadId` is provided, usage is tracked in two fire-and-forget operations (errors are caught and logged, never blocking the response):

1. **Insert usage events** — one row per injected skill into `skill_usage_events`, recording `activationType` (`"manual"` for the named skill, `"semantic"` for search matches) and `similarity`:

```typescript
db.insert(skillUsageEvents)
  .values(usageEntries)
  .catch((e) => console.error("[skill] usage log failed:", e));
```

2. **Update `lastUsedAt`** — for each injected skill, `UPDATE skills SET last_used_at = now() WHERE id = ?`:

```typescript
for (const s of merged) {
  db.update(skills)
    .set({ lastUsedAt: new Date() })
    .where(eq(skills.id, s.id))
    .catch((e) => console.error("[skill] lastUsedAt update failed:", e));
}
```

### Step 5 — Injection format

If no skills were found (`merged.length === 0`), the function returns `null` and no system message is injected. Otherwise, the skills are formatted as a single system message:

```
Active skills for this conversation. Follow these instructions:
- [skill name] skill content
- [skill name] skill content
```

This message is inserted into the LLM message array after the base system prompt but before memory context (see [Chat & Streaming](./chat-streaming.md) for message assembly order).

## Explicit skill generation — `generateSkillFromConversation()`

Located in `src/lib/skillGenerator.ts:108-199`. Triggered when the user explicitly requests saving the conversation as a skill.

### Trigger detection

In the chat route's `after()` callback (line 519), the user's message content is tested against:

```typescript
/(スキルで保存|スキルとして保存|save\s+as\s+skill)/i
```

This matches:
- Japanese: "スキルで保存" or "スキルとして保存"
- English: "save as skill" (case-insensitive)

When triggered, `generateSkillFromConversation(threadId, userId, llm, model)` is called.

### Generation flow

1. **Verify thread owner** — fetch the thread and confirm `thread.userId === userId`. Return silently if mismatch.

2. **Fetch all messages** in chronological order (`ORDER BY createdAt ASC, id ASC`). Guard: return if no user message, no assistant message, or empty message list.

3. **LLM extraction** — send the full conversation to the LLM with a system prompt instructing it to extract a single concrete reusable skill. The prompt specifies what to extract (procedures, debugging patterns, project rules, tool usage, implementation patterns) and what to reject (personal info, general facts, temporary context, generic knowledge, persona instructions).

4. **Parse the response** — `parseSkillExtraction()` strips markdown code fences and parses JSON. Accepts both array and single-object responses (backward compatibility). Validates `name` and `content` as non-empty strings; defaults `kind` to `"workflow"` if invalid; filters `tags` to strings only. Returns `null` on any parse failure.

5. **Generate embedding** — the embedding source is the combined text of `name + trigger + tags + content`, joined by newlines, to improve searchability (trigger/tags help match queries that don't use the skill's exact name):

```typescript
const embedSource = [
  extracted.name,
  extracted.trigger,
  extracted.tags.join(", "),
  extracted.content,
]
  .filter(Boolean)
  .join("\n");
const vector = await embedText(embedSource, "document");
```

6. **Deduplication** — compute `contentHash` (SHA-256 of `content` only). Check if a skill with the same `contentHash` already exists for this user. If so, skip insertion (log and return).

7. **Insert** into the `skills` table with `userId`, `name`, `content`, `embedding`, `contentHash`, `kind`, `trigger`, `tags`, and `sourceThreadId`. The skill is created with `status = "active"` by default — no approval needed for explicitly-requested skills.

> One conversation → one skill. Unlike candidate extraction (up to 3), explicit generation extracts at most a single skill per request.

## Auto candidate extraction — `extractSkillCandidates()`

Located in `src/lib/skillCandidate.ts:109-177`. Runs automatically after conversations that meet a gating heuristic, extracting up to 3 skill **candidates** as drafts pending user approval.

### Gating heuristic

In the chat route's `after()` callback (lines 529-534), candidate extraction runs only when:

```typescript
const totalLen = prepared.content.length + streamResult.assistantContent.length;
const hasSubstantiveContent =
  totalLen > 200 ||
  /```|error|exception|config|bug|fix|debug/i.test(
    prepared.content + streamResult.assistantContent,
  );
```

Extraction is triggered when **either**:
- The combined user + assistant content exceeds **200 characters**, OR
- The content contains code blocks (` ``` `) or error/config/debug keywords

This prevents candidate extraction on short greetings or trivial exchanges. If the user explicitly requested "save as skill", candidate extraction is **skipped** entirely (the explicit path takes over).

### Extraction flow

1. **Verify thread owner** and **fetch all messages** (same as explicit generation).

2. **LLM extraction** — send the full conversation to the LLM with a system prompt nearly identical to the explicit-generation prompt, but requesting an **array** of candidates with additional fields:

```json
[
  {
    "name": "short skill name (2-5 words)",
    "kind": "workflow|bugfix|project_rule|tool_usage|coding_pattern|debugging",
    "trigger": "when to apply this skill (natural language)",
    "tags": ["tag1"],
    "content": "reusable instructions in second person (You should... / When X happens, do Y)",
    "confidence": 0.0-1.0,
    "reason": "why this skill is worth saving"
  }
]
```

3. **Parse candidates** — `parseCandidates()` strips markdown fences, parses JSON, and validates each candidate. `confidence` is clamped to `[0, 1]` (defaulting to `0.5` if missing or invalid). Invalid candidates are filtered out. The result is **sliced to 3** (maximum 3 candidates per conversation):

```typescript
.slice(0, 3);
```

4. **Insert as drafts** — each candidate is inserted into `skill_candidates` with `status: "draft"`, recording the `threadId`, proposed fields, `confidence`, and `reason`. Insertion errors are caught and logged per-candidate (one failure doesn't block others).

> Candidates are **not** immediately active. They require user approval before promotion to the `skills` table.

## Approval pipeline

The approval pipeline promotes draft candidates to active skills via `PATCH /api/skill-candidates/[id]` with `status: "approved"`.

### Status flow

```
draft ──┬── approved   (promoted to skills table)
        ├── rejected   (discarded)
        └── merged     (duplicate of existing skill detected)
```

### Approval flow (`PATCH /api/skill-candidates/[id]`)

Located in `src/app/api/skill-candidates/[id]/route.ts:28-121`.

1. **Validate** — `status` must be `"approved"` or `"rejected"`. Returns 400 otherwise.

2. **Fetch candidate** scoped by `userId` (ownership check). Returns 404 if not found.

3. **If rejected** — set `status = "rejected"`, return `{ id, status: "rejected" }`.

4. **If approved** — resolve final field values. The request body can override any proposed field (enabling "edit and approve"):

```typescript
const name = body.proposedName?.trim() || candidate.proposedName;
const content = body.proposedContent?.trim() || candidate.proposedContent;
const kind = body.proposedKind || candidate.proposedKind;
const trigger = body.proposedTrigger?.trim() || candidate.proposedTrigger;
const tags = body.proposedTags
  ? body.proposedTags.filter((t): t is string => typeof t === "string")
  : candidate.proposedTags;
```

5. **Generate embedding** from the combined text of `name + trigger + tags + content` (same formula as explicit generation). Returns 503 if embedding fails.

6. **Duplicate check** — compute `contentHash` (SHA-256 of `content`). Query the `skills` table for an existing skill with the same `contentHash` for this user:
   - **If duplicate exists** → set candidate `status = "merged"`, return `{ id, status: "merged", reason: "duplicate skill exists" }`. No new skill is created.
   - **If no duplicate** → proceed to insertion.

7. **Insert into `skills`** — create a new skill row with `userId`, `name`, `content`, `embedding`, `contentHash`, `kind`, `trigger`, `tags`, and `sourceThreadId` (from the candidate's `threadId`). The new skill has `status = "active"` by default.

8. **Update candidate** — set `status = "approved"`.

9. **Return** `{ candidate: { id, status: "approved" }, skill }`.

### Candidate deletion

`DELETE /api/skill-candidates/[id]` performs a **physical delete** (not soft-delete) of a draft candidate. Only `draft`-status candidates can be deleted this way; `approved` / `rejected` / `merged` candidates are retained for audit and can only be removed via status changes.

## Skill usage tracking

Each time `buildSkillContext()` injects skills, two fire-and-forget operations record usage:

### `skill_usage_events` table

One row is inserted per injected skill, recording:
- `skillId` — which skill was injected
- `userId` / `threadId` — context of the injection
- `similarity` — the cosine similarity score (or `1.0` for manual activation)
- `activationType` — `"manual"` (name-specified) or `"semantic"` (search match)
- `outcome` — defaults to `"unknown"`; reserved for future thumbs-up/thumbs-down feedback

### `lastUsedAt` updates

Each injected skill's `lastUsedAt` timestamp is updated to `now()`, enabling the UI to show when a skill was last used.

### `successCount` / `failureCount` — future feedback

The `skills` table has `successCount` and `failureCount` integer columns (both default `0`). These are **not currently incremented** by any code path — they are reserved for a future feedback mechanism where users can rate whether an injected skill was helpful. The `outcome` field on `skill_usage_events` (currently always `"unknown"`) is the intended vehicle for this feedback.

## Skill REST API

All endpoints require authentication (session via `getSessionUser()`). All operations are scoped to the authenticated user — no cross-user access is possible.

### `GET /api/skills` — List skills

Returns all skills for the logged-in user, ordered by `updatedAt DESC`. Excludes the `embedding` column (metadata only).

**Response fields:** `id`, `name`, `content`, `kind`, `trigger`, `tags`, `scope`, `status`, `version`, `lastUsedAt`, `successCount`, `failureCount`, `createdAt`, `updatedAt`.

### `POST /api/skills` — Manual skill creation

Creates a new skill with embedding.

**Request body:**

```typescript
{
  name: string;         // required, non-empty after trim
  content: string;      // required, non-empty after trim
  kind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger?: string;
  tags?: string[];
}
```

**Behavior:**
- `kind` defaults to `"workflow"` if omitted.
- `trigger` is trimmed; empty string if omitted.
- `tags` defaults to `[]`; non-string entries are filtered.
- Embedding is generated from `name + trigger + tags.join(", ") + content`.
- `contentHash` is computed (SHA-256 of `content`).
- Duplicate check: if a skill with the same `contentHash` exists for this user, returns **409 Conflict**.
- Embedding failure (empty vector) returns **503**.
- **Response:** 201 with `{ id, name, content }`.

### `PATCH /api/skills/[id]` — Edit a skill

Partially updates a skill. Re-embeds when any embedding-source field changes; bumps `contentHash` + `version` only when `content` changes.

**Request body** (all fields optional):

```typescript
{
  name?: string;
  content?: string;
  kind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger?: string;
  tags?: string[];
  status?: "active" | "archived";
}
```

**Re-embedding logic:**
- If `content`, `name`, `trigger`, or `tags` changed, the embedding is regenerated from the combined source text.
- `contentHash` is recomputed and `version` is incremented **only** when `content` itself changed (not when only name/trigger/tags changed).
- Returns **503** if embedding fails.
- Returns **404** if the skill doesn't exist or doesn't belong to the user.

**Response:** 200 with the updated skill fields (`id`, `name`, `content`, `kind`, `trigger`, `tags`, `status`, `version`, `updatedAt`).

### `DELETE /api/skills/[id]` — Delete a skill

Performs a **physical delete** (hard delete, not soft-delete). Scoped by `userId`. Returns **204** on success, **404** if not found.

### `GET /api/skill-candidates` — List candidates

Returns skill candidates for the logged-in user, filtered by status.

**Query parameter:** `?status=draft|approved|rejected|merged` (default: `draft`).

Invalid status values fall back to `draft`.

**Response fields:** `id`, `threadId`, `proposedName`, `proposedKind`, `proposedTrigger`, `proposedContent`, `proposedTags`, `confidence`, `reason`, `status`, `createdAt`, `updatedAt`. Ordered by `createdAt DESC`.

### `PATCH /api/skill-candidates/[id]` — Approve / reject / merge

See [Approval pipeline](#approval-pipeline) above for the full flow.

**Request body:**

```typescript
{
  status: "approved" | "rejected";       // required
  // Override fields (only used when status = "approved"):
  proposedName?: string;
  proposedKind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  proposedTrigger?: string;
  proposedTags?: string[];
  proposedContent?: string;
}
```

**Responses:**
- Rejected → `{ id, status: "rejected" }`
- Merged (duplicate) → `{ id, status: "merged", reason: "duplicate skill exists" }`
- Approved → `{ candidate: { id, status: "approved" }, skill: { ... } }`

### `DELETE /api/skill-candidates/[id]` — Delete a draft

Physical delete of a draft candidate. Scoped by `userId`. Returns **204** on success, **404** if not found.

> Approved/rejected/merged candidates cannot be deleted via this endpoint (only `draft`-status rows should be targeted; the endpoint itself does not enforce this, but the UI only offers deletion for drafts).

## SkillManagerModal UI

Located in `src/components/SkillManagerModal.tsx`. A modal component for managing both the `skills` and `skill_candidates` tables. Uses the same pattern as `MemoryViewerModal` (AnimateModal, clientFetch, useI18n).

### Three tabs

| Tab | Source | Content |
|-----|--------|---------|
| **Active** | `GET /api/skills` (filtered to `status === "active"`) | Active skills with inline editing, archiving |
| **Drafts** | `GET /api/skill-candidates?status=draft` | Draft candidates with approve / edit-and-approve / reject actions |
| **Archived** | `GET /api/skills` (filtered to `status === "archived"`) | Archived skills with restore action |

### Active tab features

- **Inline edit** — click "Edit" to edit `name`, `kind` (dropdown), `trigger`, `tags` (comma-separated), and `content` inline. Saves via `PATCH /api/skills/[id]`.
- **Archive** — sets `status = "archived"` via PATCH. The skill moves to the Archived tab and is excluded from RAG retrieval.
- **Display** — shows skill name, kind badge, trigger (if set), tags, content, and `lastUsedAt` (or "never").

### Drafts tab features

- **Approve** — promotes the candidate directly to the `skills` table via `PATCH /api/skill-candidates/[id]` with `status: "approved"` (no field overrides).
- **Edit & Approve** — opens an inline editor for `name`, `kind`, `trigger`, `tags`, and `content`, then submits with override fields.
- **Reject** — sets `status = "rejected"` via PATCH.
- **Display** — shows proposed name, kind badge, confidence percentage (`Math.round(confidence * 100)%`), trigger, reason (italicized), proposed content, and tags.
- **Badge** — the Drafts tab shows a count badge when candidates exist.

### Archived tab features

- **Restore** — sets `status = "active"` via PATCH, moving the skill back to the Active tab.
- **Display** — shows skill name, kind badge, and content (line-clamped to 2 lines).

### Data loading

On open, `fetchAll()` makes three parallel requests:

```typescript
const [activeRes, draftRes, archivedRes] = await Promise.all([
  clientFetch("/api/skills"),
  clientFetch("/api/skill-candidates?status=draft"),
  clientFetch("/api/skills"),
]);
```

The active and archived tabs both fetch from `/api/skills` and filter client-side by `status`.

## See also

- [Chat & Streaming](./chat-streaming.md) — How `buildSkillContext()` is called during message preparation and where the skill system message is positioned in the LLM message array
- [Memory System](./memory.md) — The sibling RAG system; memories are ephemeral per-thread context, skills are permanent cross-thread procedures
- [Embeddings & Vector Search](./embeddings.md) — `embedText()`, `cosineSimilarity()`, local ONNX vs HTTP embedder providers, the `kind` parameter
- [Database & Schema](./database.md) — Full `skills`, `skill_candidates`, and `skill_usage_events` table definitions, migration history, and embedding storage conventions
- [API Routes](./api-routes.md) — Complete REST API reference including skill endpoints
