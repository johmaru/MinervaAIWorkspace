import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  vector,
} from "drizzle-orm/pg-core";

// 埋め込み次元数: env EMBED_DIM（デフォルト 384）。
// モデル切替時は env で指定 + DB マイグレーション（vector 列の再作成）が必要。
const EMBED_DIM = Number(process.env.EMBED_DIM) || 384;


/**
 * threads — 会話スレッド
 * current_leaf_id: 現在表示中の枝の末端 message id。枝分かれナビで切替。
 */
export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("New chat"),
  systemPrompt: text("system_prompt"),
  model: text("model").notNull().default("gpt-4o-mini"),
  folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
  currentLeafId: uuid("current_leaf_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * folders — スレッドを束ねるフォルダ。
 * instruction は所属スレッドの systemPrompt 先頭に結合される。
 * memoryScope が "folder" の場合、会話メモリ(RAG)検索を同一フォルダ内に限定。
 * "global" の場合は従来通り全スレッド横断（デフォルト、後方互換）。
 * フォルダ階層は1階層のみ（自己参照なし）。
 */
export const folders = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("New folder"),
  instruction: text("instruction"),
  memoryScope: text("memory_scope", { enum: ["folder", "global"] }).notNull().default("global"),
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
    reasoning: text("reasoning"), // assistant の思考プロセス（折りたたみ表示用）
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
 * pgvector の vector 型。次元数は env EMBED_DIM (default 384)。
 */
export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(), // 再 embed 回避用
    embedding: vector("embedding", { dimensions: EMBED_DIM }).notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageIdx: index("embeddings_message_idx").on(t.messageId),
  }),
);

/**
 * attachments — メッセージ添付ファイル
 * 画像は base64 を dataURL として保存（vision モデルへ inline 渡し）。
 * PDF/テキストはサーバ側でテキスト抽出し extractedText に保存。
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    // 画像の場合: dataURL（base64）。テキストの場合: null
    dataUrl: text("data_url"),
    // PDF/テキストの場合: 抽出されたテキスト。画像の場合: null
    extractedText: text("extracted_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageIdx: index("attachments_message_idx").on(t.messageId),
    threadIdx: index("attachments_thread_idx").on(t.threadId),
  }),
);

/**
 * pages — スクレイピングした Web ページの恒久ナレッジ。
 * URL 単位で1行。contentHash が一致すれば再取得スキップ。
 * page_embeddings でスレッド横断の RAG/検索に供給。
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull().unique(),
    urlHash: text("url_hash").notNull().unique(), // SHA-256(normalized URL), 取得キャッシュ判定
    title: text("title"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(), // SHA-256(content), 変更検知
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    status: integer("status").notNull().default(200),
    errorMessage: text("error_message"),
  },
  (t) => ({
    urlHashIdx: index("pages_url_hash_idx").on(t.urlHash),
  }),
);

/**
 * page_embeddings — ページ本文の埋め込みベクトル。
 * embeddings テーブルと同構造。EMBED_DIM 次元（env で変更可能）。
 */
export const pageEmbeddings = pgTable(
  "page_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: EMBED_DIM }).notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pageIdx: index("page_embeddings_page_idx").on(t.pageId),
  }),
);
