import { randomUUID } from "node:crypto";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Embedding column type: stored as a Float32Array BLOB (compact, native for sqlite-vec),
 * but exposed as number[] in TypeScript. The column DDL is still `text` (SQLite storage
 * class is determined by the value, not the column affinity — BLOB values persist as BLOB
 * even in TEXT-affinity columns), so no ALTER TABLE is needed when switching from the
 * old JSON-text storage.
 *
 * - toDriver: number[] → Buffer(Float32Array) for storage
 * - fromDriver: Buffer → number[] for reads
 */
const embeddingColumn = (name: string) =>
  customType<{ data: number[]; driverData: Buffer }>({
    dataType: () => "text",
    toDriver(value) {
      return Buffer.from(new Float32Array(value).buffer);
    },
    fromDriver(value) {
      if (!value) return [];
      // Legacy JSON text (pre-sqlite-vec migration) — parse as number[]
      if (typeof value === "string") return JSON.parse(value);
      return Array.from(new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4));
    },
  })(name);

/** Common helper for timestamp columns: stored as Unix epoch ms (integer), read/written as Date. */
function ts(name: string) {
  return integer(name, { mode: "timestamp_ms" });
}
/** NOT NULL timestamp column + default now(). */
function tsNow(name: string) {
  return integer(name, { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());
}

// ── Auth.js tables ──
/**
 * global_instructions — per-user named global system instructions.
 * Multiple can be created. Default via users.activeInstructionId, overridden per-thread via threads.globalInstructionId.
 * Defined before users (because users.activeInstructionId forward-references this table).
 */
export const globalInstructions = sqliteTable("global_instructions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

// users: App users. Log in via emailUnique. Credentials auth via passwordHash.
export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  nickname: text("nickname").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  activeInstructionId: text("active_instruction_id"),
  // Personalization settings (per-user). If personalStyle is null, the feature is disabled.
  personalStyle: text("personal_style"),
  personalWarmth: integer("personal_warmth").notNull().default(1),
  personalEnergy: integer("personal_energy").notNull().default(1),
  personalStructure: integer("personal_structure").notNull().default(1),
  personalEmoji: integer("personal_emoji").notNull().default(1),
  // Primary language for translate characteristics (language code like "ja", "en"). null = use UI locale.
  translatePrimaryLang: text("translate_primary_lang"),
  // Columns written by DrizzleAdapter on OAuth createUser (for Google login)
  name: text("name"),
  emailVerified: ts("email_verified"),
  image: text("image"),
  createdAt: tsNow("created_at"),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type"),  // For DrizzleAdapter linkAccount (oauth / oidc / email)
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: ts("expires_at"),
    tokenType: text("token_type"),
    scope: text("scope"),
    idToken: text("id_token"),
  },
  (t) => ({
    // (provider, providerAccountId) composite unique constraint.
    // Auth.js DrizzleAdapter assumes this constraint for upsert.
    // This prevents duplicate accounts rows for the same OAuth account.
    providerUnique: uniqueIndex("accounts_provider_unique").on(t.provider, t.providerAccountId),
  }),
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: ts("expires").notNull(),
  sessionToken: text("session_token").notNull().unique(),
});

export const verificationTokens = sqliteTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: ts("expires").notNull(),
});

// Embedding dimensions: env EMBED_DIM (default 1024 = LFM2.5-Embedding-350M).
// Embeddings are stored as Float32 BLOB via sqlite-vec (vec_distance_cosine).
// The column DDL is `text` but BLOB values persist as BLOB (SQLite storage class rule).
// Dimension is not enforced at column level — runtime contract via EMBED_DIM.

/**
 * skills — per-user reusable procedures/rules.
 *
 * Extracted and named from conversations via LLM, stored with embeddings.
 * On all subsequent threads, searched via client-side cosine → injected into system context.
 * If the user says "use skill X", it is applied directly by name.
 * "Save as skill" generates a skill from the current conversation.
 *
 * persona/knowledge are managed by memories; skills specialize in reusable procedures/rules.
 * Categorized by kind, triggered by trigger, searchability improved by tags.
 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  embedding: embeddingColumn("embedding").notNull(),
  contentHash: text("content_hash").notNull(),
  kind: text("kind", {
    enum: ["workflow", "bugfix", "project_rule", "tool_usage", "coding_pattern", "debugging"],
  }).notNull().default("workflow"),
  trigger: text("trigger"),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  scope: text("scope", { enum: ["global", "folder", "thread"] }).notNull().default("global"),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  version: integer("version").notNull().default(1),
  sourceThreadId: text("source_thread_id").references(() => threads.id, { onDelete: "set null" }),
  sourceMessageIds: text("source_message_ids", { mode: "json" }).$type<string[]>(),
  lastUsedAt: ts("last_used_at"),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  lastEvolutionAt: ts("last_evolution_at"), // nullable — last time an evolution proposal was approved & applied
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

/**
 * skill_candidates — skill candidates automatically extracted from conversations.
 * Remain as draft until approved by the user. On approval, promoted to the skills table.
 * status: draft → approved/rejected/merged
 */
export const skillCandidates = sqliteTable("skill_candidates", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
  sourceMessageIds: text("source_message_ids", { mode: "json" }).$type<string[]>(),
  proposedName: text("proposed_name").notNull(),
  proposedKind: text("proposed_kind", {
    enum: ["workflow", "bugfix", "project_rule", "tool_usage", "coding_pattern", "debugging"],
  }).notNull(),
  proposedTrigger: text("proposed_trigger").notNull(),
  proposedContent: text("proposed_content").notNull(),
  proposedTags: text("proposed_tags", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  confidence: real("confidence").notNull().default(0.5),
  reason: text("reason"),
  contentHash: text("content_hash"),
  duplicateOfId: text("duplicate_of_id"),
  duplicateOfType: text("duplicate_of_type", { enum: ["skill", "candidate"] }),
  status: text("status", {
    enum: ["draft", "approved", "rejected", "merged"],
  }).notNull().default("draft"),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

/**
 * skill_usage_events — skill usage log.
 * Recorded for each skill injected by buildSkillContext.
 * activationType: semantic (search match) or manual (name-specified)
 * outcome: unknown (initial) → helpful / not_helpful (for future feedback)
 */
export const skillUsageEvents = sqliteTable("skill_usage_events", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  messageId: text("message_id"),
  similarity: real("similarity"),
  activationType: text("activation_type", { enum: ["semantic", "manual"] }).notNull(),
  outcome: text("outcome", { enum: ["unknown", "helpful", "not_helpful"] })
    .notNull()
    .default("unknown"),
  createdAt: tsNow("created_at"),
});

/**
 * skill_evolution_proposals — bounded LLM-generated content patches for existing skills.
 *
 * Created when a skill accumulates enough negative feedback within an evolution window.
 * Remains as draft until approved/rejected by the user. On approval, the skill content is
 * updated via updateSkillContent (version bump + re-embed) and lastEvolutionAt is set.
 *
 * status: draft → approved / rejected / superseded / conflict
 * One open draft per skill enforced by partial unique index (PR3 migration).
 */
export const skillEvolutionProposals = sqliteTable("skill_evolution_proposals", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  baseVersion: integer("base_version").notNull(),
  previousContent: text("previous_content").notNull(),
  proposedContent: text("proposed_content").notNull(),
  proposedName: text("proposed_name"),
  proposedTrigger: text("proposed_trigger"),
  proposedTags: text("proposed_tags", { mode: "json" }).$type<string[]>(),
  patchSummary: text("patch_summary").notNull(),
  reason: text("reason"),
  evidenceEventIds: text("evidence_event_ids", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  contentHash: text("content_hash").notNull(),
  status: text("status", {
    enum: ["draft", "approved", "rejected", "superseded", "conflict"],
  }).notNull().default("draft"),
  appliedVersion: integer("applied_version"),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
}, (t) => ({
  userSkillStatusIdx: index("skill_evo_user_skill_status_idx").on(
    t.userId, t.skillId, t.status,
  ),
}));

/**
 * mcpServers — per-user MCP (Model Context Protocol) server connection definitions.
 *
 * When transport="http", uses url (Streamable HTTP with SSE fallback).
 * When transport="sse", uses url (legacy SSE only — no Streamable attempt).
 * When transport="stdio", launches a local process via command + args + env.
 * Headers (optional) apply to http/sse transports only; ignored for stdio.
 */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  transport: text("transport", { enum: ["http", "sse", "stdio"] }).notNull(),
  url: text("url"),
  command: text("command"),
  args: text("args", { mode: "json" }).$type<string[]>(),
  env: text("env", { mode: "json" }).$type<Record<string, string>>(),
  // Optional HTTP headers for remote transports (http/sse). JSON object string.
  // Stored as text JSON; secrets — never returned in GET list (hasHeaders only).
  // Ignored for stdio (must be null).
  headers: text("headers", { mode: "json" }).$type<Record<string, string> | null>(),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});


/**
 * connections — external services OAuth-authorized by the user (e.g. Notion).
 *
 * provider is an extensible enum ("notion" → future "google", "github", etc.).
 * accessToken / refreshToken exist only for rows with tokens obtained (NOT NULL).
 * workspaceName / workspaceIcon / ownerName / ownerEmail are display metadata.
 * Enabled/disabled per thread (threads.connectionIds holds an array of ids).
 */
export const connections = sqliteTable("connections", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider", {
    enum: [
      "notion",
      "gmail",
      "google_drive",
      "google_calendar",
      "github",
      "outlook",
      "outlook_calendar",
    ],
  }).notNull(),
  accessToken: text("access_token").notNull(),
  // nullable: GitHub OAuth App tokens have no refresh token; Google/Microsoft may.
  refreshToken: text("refresh_token"),
  // space-separated granted scopes (nullable; legacy Notion rows have none)
  scopes: text("scopes"),
  // access-token expiry (nullable; GitHub OAuth App tokens don't expire)
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  workspaceName: text("workspace_name"),
  workspaceIcon: text("workspace_icon"),
  botId: text("bot_id"),
  ownerName: text("owner_name"),
  ownerEmail: text("owner_email"),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});


/**
 * threads — conversation threads
 * current_leaf_id: The leaf message id of the currently displayed branch. Switched via the branching navigator.
 */
export const threads = sqliteTable("threads", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  title: text("title").notNull().default("New chat"),
  systemPrompt: text("system_prompt"),
  model: text("model").notNull().default("umans-glm-5.2"),
  responseMode: text("response_mode", { enum: ["single", "dual", "hyper", "council"] }).notNull().default("single"),
  dualModelA: text("dual_model_a"),
  dualModelB: text("dual_model_b"),
  dualStrategy: text("dual_strategy", { enum: ["cross_review", "debate"] }).notNull().default("cross_review"),
  dualDebateRounds: integer("dual_debate_rounds").notNull().default(2),
  hyperRounds: integer("hyper_rounds").notNull().default(3),
  // council mode
  councilSize: integer("council_size").notNull().default(3),        // 2〜6
  councilTimeLimit: integer("council_time_limit").notNull().default(60), // 秒、30〜300
  mcpServerIds: text("mcp_server_ids", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
  activeKbIds: text("active_kb_ids", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  connectionIds: text("connection_ids", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  globalInstructionId: text("global_instruction_id").references(() => globalInstructions.id, { onDelete: "set null" }),
  currentLeafId: text("current_leaf_id"),
  // Columns added in the 0002 migration (were not reflected in schema.ts).
  // Not currently referenced by code, but defined to maintain schema-DB consistency.
  temperature: real("temperature"),
  maxTokens: integer("max_tokens"),
  contextLength: integer("context_length"),
  autoCompact: integer("auto_compact"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

/**
 * folders — folders that group threads.
 * instruction is prepended to the systemPrompt of member threads.
 * If memoryScope is "folder", conversation memory (RAG) search is limited to the same folder.
 * "global" searches across all threads as before (default, backward-compatible).
 * Folder hierarchy is one level only (no self-reference).
 */
export const folders = sqliteTable("folders", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull().default("New folder"),
  instruction: text("instruction"),
  memoryScope: text("memory_scope", { enum: ["folder", "global"] }).notNull().default("global"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

/**
 * messages — branching tree
 * If parent_id is NULL, it's the root message of the thread.
 * Edits/regenerations create a new row linked to the parent via parent_id.
 * Old branches are kept (ChatGPT-style).
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentId: text("parent_id"), // Self-referencing (NULL for root)
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    reasoning: text("reasoning"), // Assistant's thought process (for collapsible display)
    metadata: text("metadata", { mode: "json" }).$type<{
      dualTrace?: {
        strategy: "cross_review" | "debate";
        modelA: string;
        modelB: string;
        finalModel: string;
        answerA: string;
        answerB: string;
        reviewA?: string;
        reviewB?: string;
        debateTurns?: { speaker: "A" | "B"; model: string; content: string }[];
      };
      hyperTrace?: {
        rounds: {
          perspective: string;
          draft: string;
          critique: string;
          revised: string;
        }[];
        finalModel: string;
      };
      councilTrace?: {
        panels: { id: string; persona: string; model: string }[];
        initialAnswers: { panelId: string; content: string }[];
        discussionTurns: { panelId: string; round: number; content: string }[];
        finalModel: string;
        roundsCompleted: number;
        timeLimitReached: boolean;
      };
      model?: string;
      elapsedMs?: number;
      /** Skill Evolution: skills injected into this assistant response */
      injectedSkills?: Array<{
        skillId: string;
        name: string;
        usageEventId: string;
        similarity: number;
        activationType: "semantic" | "manual";
      }>;
    }>(),
    createdAt: tsNow("created_at"),
  },
  (t) => ({
    threadIdx: index("messages_thread_idx").on(t.threadId),
    parentIdx: index("messages_parent_idx").on(t.parentId),
  }),
);

/**
 * memories — conversation memories (fact / working).
 *
 * After an assistant response completes, the conversation is summarized and classified via LLM, then stored with an embedding.
 * On the next send, client-side cosine search (similarity > 0.3) → top-30 by similarity →
 * top-5 by recency score → injected into system context (RAG).
 *
 * Lifecycle:
 * - kind: "fact" = immutable user info/environment/settings. "working" = current task/temporary context.
 * - suppressedAt: user-initiated soft delete (DELETE /api/memories/[id]).
 * - validFrom / validUntil: time-validity range. When a memory is replaced (outdated/wrong),
 *   validUntil = now() is set instead of suppressedAt — the old memory remains as history
 *   but is excluded from active search. Replaced memories are NOT physically deleted.
 * - expiresAt: automatic expiration. working memories get expiresAt = now + 7 days at INSERT time.
 *   fact memories have expiresAt = null (never auto-expire).
 * - injectionCount / lastInjectedAt / lastReferencedAt: feedback loop tracking.
 *   injectionCount incremented each time the memory is injected into context.
 *   lastInjectedAt = timestamp of most recent injection.
 *   lastReferencedAt = timestamp of most recent injection that was followed by a user message
 *   with cosine > 0.5 (user continued the topic). importance is adjusted ±0.05/0.02 per cycle.
 * - folderId: When folders.memoryScope is "folder", search is limited to the same folder.
 *   "global" searches across all threads (default).
 * - embedding: Float32 BLOB (embeddingColumn customType). Cosine via sqlite-vec vec_distance_cosine().
 *
 * Active memory = suppressedAt IS NULL AND (validUntil IS NULL OR validUntil > now)
 *   AND (expiresAt IS NULL OR expiresAt > now).
 * Use activeMemoryConditions() from memoryUtils.ts to build WHERE clauses.
 */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["fact", "working"] }).notNull(),
    content: text("content").notNull(),
    sourceMessageIds: text("source_message_ids", { mode: "json" }).$type<string[]>(),
    embedding: embeddingColumn("embedding").notNull(),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    importance: real("importance").notNull().default(0.5),
    suppressedAt: ts("suppressed_at"),
    validFrom: tsNow("valid_from"),
    validUntil: ts("valid_until"),
    expiresAt: ts("expires_at"),
    injectionCount: integer("injection_count").notNull().default(0),
    lastInjectedAt: ts("last_injected_at"),
    lastReferencedAt: ts("last_referenced_at"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => ({
    threadIdx: index("memories_thread_idx").on(t.threadId),
    folderIdx: index("memories_folder_idx").on(t.folderId),
    kindIdx: index("memories_kind_idx").on(t.kind),
    suppressedIdx: index("memories_suppressed_idx").on(t.suppressedAt),
    expiresIdx: index("memories_expires_idx").on(t.expiresAt),
  }),
);
/**
 * todos — per-user task items with vector embedding for future semantic search.
 * status: pending → in_progress → completed. Physical DELETE (todos are disposable).
 * threadId is nullable: todos from the modal have null, AI-created todos link to the chat thread.
 */
export const todos = sqliteTable(
  "todos",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    embedding: embeddingColumn("embedding").notNull(),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    status: text("status", {
      enum: ["pending", "in_progress", "completed"],
    }).notNull().default("pending"),
    priority: text("priority", {
      enum: ["low", "medium", "high"],
    }).notNull().default("medium"),
    dueAt: ts("due_at"),
    completedAt: ts("completed_at"),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => ({
    userIdx: index("todos_user_idx").on(t.userId),
    statusIdx: index("todos_status_idx").on(t.status),
    dueIdx: index("todos_due_idx").on(t.dueAt),
  }),
);

/**
 * memory_injections — junction table tracking which memories were injected for each user message.
 * Used by the feedback loop: on the next send, the previous message's injected memories
 * are compared (cosine similarity) against the new user input. If similarity > 0.5,
 * the memory is "referenced" (importance boosted, lastReferencedAt updated).
 * One row per (messageId, memoryId) pair. Deleted with the message (cascade).
 */
export const memoryInjections = sqliteTable(
  "memory_injections",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    injectedAt: tsNow("injected_at"),
  },
  (t) => ({
    messageIdx: index("memory_injections_message_idx").on(t.messageId),
    memoryIdx: index("memory_injections_memory_idx").on(t.memoryId),
  }),
);

/**
 * attachments — message attached files
 * Images are stored as base64 dataURLs (passed inline to vision models).
 * PDF/text files have text extracted server-side and saved in extractedText.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    // For images: dataURL (base64). For text: null
    dataUrl: text("data_url"),
    // For PDF/text: extracted text. For images: null
    extractedText: text("extracted_text"),
    createdAt: tsNow("created_at"),
  },
  (t) => ({
    messageIdx: index("attachments_message_idx").on(t.messageId),
    threadIdx: index("attachments_thread_idx").on(t.threadId),
  }),
);

/**
 * pages — permanent knowledge from scraped web pages.
 * One row per URL. If contentHash matches, re-fetch is skipped.
 * Feeds cross-thread RAG/search via page_embeddings.
 */
export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    url: text("url").notNull().unique(),
    urlHash: text("url_hash").notNull().unique(), // SHA-256(normalized URL), used for fetch cache check
    title: text("title"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(), // SHA-256(content), change detection
    fetchedAt: tsNow("fetched_at"),
    status: integer("status").notNull().default(200),
    errorMessage: text("error_message"),
  },
  (t) => ({
    urlHashIdx: index("pages_url_hash_idx").on(t.urlHash),
  }),
);

/**
 * page_embeddings — embedding vectors for page body text.
 * Same dimensions as the embedding column in the memories table. EMBED_DIM (configurable via env).
 * embedding is a Float32 BLOB (embeddingColumn). Cosine via sqlite-vec vec_distance_cosine().
 */
export const pageEmbeddings = sqliteTable(
  "page_embeddings",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    embedding: embeddingColumn("embedding").notNull(),
    model: text("model").notNull(),
    createdAt: tsNow("created_at"),
  },
  (t) => ({
    pageIdx: index("page_embeddings_page_idx").on(t.pageId),
  }),
);

/**
 * user_traits — persistent user profile traits (always injected, not similarity-searched).
 *
 * Extracted from conversations alongside memories (shared LLM call, kind="profile").
 * Stored with embeddings for dedup (cosine > 0.85) and contradiction candidate selection
 * (cosine > 0.75 → checkContradiction). Unlike memories, these are:
 * - User-scoped (direct userId FK, not thread-scoped)
 * - Always injected (up to 30, ordered by confidence DESC, updatedAt DESC)
 * - Survive thread deletion (sourceThreadId ON DELETE SET NULL)
 *
 * Active trait = suppressedAt IS NULL.
 */
export const userTraits = sqliteTable(
  "user_traits",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category", {
      enum: ["demographic", "interest", "speech_pattern", "preference"],
    }).notNull(),
    content: text("content").notNull(),
    embedding: embeddingColumn("embedding").notNull(),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    evidenceCount: integer("evidence_count").notNull().default(1),
    suppressedAt: ts("suppressed_at"),
    sourceThreadId: text("source_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    sourceMessageIds: text("source_message_ids", { mode: "json" }).$type<string[]>(),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => ({
    userIdx: index("user_traits_user_idx").on(t.userId),
    categoryIdx: index("user_traits_category_idx").on(t.category),
    suppressedIdx: index("user_traits_suppressed_idx").on(t.suppressedAt),
  }),
);

// ── Knowledge Bases (user-created RAG databases) ──
/**
 * knowledge_bases — user-created RAG databases.
 * Each KB is a collection of documents (files, URLs, pasted text) that can be
 * selectively enabled per-thread for RAG injection into chat context.
 * e.g. "ソシャゲストーリー用", "仕事用資料"
 */
export const knowledgeBases = sqliteTable("knowledge_bases", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
}, (t) => ({
  userIdx: index("knowledge_bases_user_idx").on(t.userId),
}));

/**
 * kb_documents — documents within a knowledge base.
 * sourceType: "file" (uploaded PDF/text), "url" (scraped web page), "text" (pasted directly).
 * sourceUrl: original URL for sourceType="url", null otherwise.
 * content: full extracted text (for display/re-embedding on model change).
 * chunkCount: denormalized count of kb_chunks rows (updated on insert/delete).
 */
export const kbDocuments = sqliteTable("kb_documents", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  knowledgeBaseId: text("knowledge_base_id")
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sourceType: text("source_type", { enum: ["file", "url", "text"] }).notNull(),
  sourceUrl: text("source_url"),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
}, (t) => ({
  kbIdx: index("kb_documents_kb_idx").on(t.knowledgeBaseId),
}));

/**
 * kb_chunks — text chunks with embeddings for RAG search.
 * Each chunk is ~512 chars with ~64 char overlap (see chunker.ts).
 * ordinal: position within the document (0-based), for context reconstruction.
 * embedding is Float32 BLOB via embeddingColumn, same as memories/page_embeddings.
 * model: embedding model that produced the vector (for migration on model change).
 */
export const kbChunks = sqliteTable("kb_chunks", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  documentId: text("document_id")
    .notNull()
    .references(() => kbDocuments.id, { onDelete: "cascade" }),
  knowledgeBaseId: text("knowledge_base_id")
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  text: text("text").notNull(),
  embedding: embeddingColumn("embedding").notNull(),
  contentHash: text("content_hash").notNull(),
  model: text("model").notNull(),
  createdAt: tsNow("created_at"),
}, (t) => ({
  docIdx: index("kb_chunks_doc_idx").on(t.documentId),
  kbIdx: index("kb_chunks_kb_idx").on(t.knowledgeBaseId),
}));
