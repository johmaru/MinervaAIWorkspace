import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  vector,
} from "drizzle-orm/pg-core";

/**
 * threads — 会話スレッド
 * current_leaf_id: 現在表示中の枝の末端 message id。枝分かれナビで切替。
 */
export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("New chat"),
  systemPrompt: text("system_prompt"),
  model: text("model").notNull().default("gpt-4o-mini"),
  currentLeafId: uuid("current_leaf_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * messages — 枝分かれツリー
 * parent_id が NULL ならスレッドのルート発言。
 * 編集/再生成は新しい行を作り parent_id で親に繋ぐ。
 * 古い枝も残す（ChatGPT 式）。
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"), // 自己参照（ルートは NULL）
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index("messages_thread_idx").on(t.threadId),
    parentIdx: index("messages_parent_idx").on(t.parentId),
  }),
);

/**
 * embeddings — メッセージの埋め込みベクトル
 * セマンティック検索 + 長期記憶 RAG 用。
 * pgvector の vector 型。次元数は env EMBED_DIM (default 1536)。
 */
export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(), // 再 embed 回避用
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageIdx: index("embeddings_message_idx").on(t.messageId),
  }),
);
