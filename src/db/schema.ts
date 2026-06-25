import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  vector,
  jsonb,
  real,
} from "drizzle-orm/pg-core";
// ── Auth.js tables ──
// users: アプリユーザー。emailUnique でログイン。passwordHash で Credentials 認証。
// nickname は UI に表示される表示名。
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  nickname: text("nickname").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// accounts/sessions/verificationTokens: DrizzleAdapter が期待するスキーマ形状。
// JWT セッション戦略（Credentials で必須）のため sessions は実行時に未使用だが、
// アダプター互換のためにテーブルを定義しておく。
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  tokenType: text("token_type"),
  scope: text("scope"),
  idToken: text("id_token"),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
  sessionToken: text("session_token").notNull().unique(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

// 埋め込み次元数: env EMBED_DIM（デフォルト 1024 = LFM2.5-Embedding-350M）。
// モデル切替時は env で指定 + DB マイグレーション（vector 列の再作成）が必要。
const EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;

/**
 * skills — ユーザー単位の再利用可能プロンプト（persona / behavior / knowledge）。
 *
 * 会話から LLM で抽出・命名し、embedding 付きで保存。
 * 次回以降の全スレッドで pgvector 検索 → system context に注入。
 * ユーザーが「〇〇スキルを使って」と指定すれば名前で直接適用。
 * 「スキルで保存して」で現在の会話からスキルを生成。
 */
export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: EMBED_DIM }).notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * mcpServers — ユーザー単位の MCP (Model Context Protocol) サーバー接続定義。
 *
 * transport="http" の場合は url を使用（Streamable HTTP / SSE 自動フォールバック）。
 * transport="stdio" の場合は command + args + env でローカルプロセスを起動。
 * スレッド単位で有効/無効を切り替え（threads.mcpServerIds に id 配列を保持）。
 */
export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  transport: text("transport", { enum: ["http", "stdio"] }).notNull(),
  url: text("url"),
  command: text("command"),
  args: jsonb("args").$type<string[]>(),
  env: jsonb("env").$type<Record<string, string>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});


/**
 * threads — 会話スレッド
 * current_leaf_id: 現在表示中の枝の末端 message id。枝分かれナビで切替。
 */
export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("New chat"),
  systemPrompt: text("system_prompt"),
  model: text("model").notNull().default("umans-glm-5.2"),
  responseMode: text("response_mode", { enum: ["single", "dual"] }).notNull().default("single"),
  dualModelA: text("dual_model_a"),
  dualModelB: text("dual_model_b"),
  dualStrategy: text("dual_strategy", { enum: ["cross_review", "debate"] }).notNull().default("cross_review"),
  dualDebateRounds: integer("dual_debate_rounds").notNull().default(2),
  mcpServerIds: jsonb("mcp_server_ids").$type<string[]>().notNull().default([]),
  folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
  currentLeafId: uuid("current_leaf_id"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
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
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
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
    metadata: jsonb("metadata").$type<{
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
      model?: string;
      elapsedMs?: number;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index("messages_thread_idx").on(t.threadId),
    parentIdx: index("messages_parent_idx").on(t.parentId),
  }),
);

/**
 * memories — 会話記憶（fact / working）。
 *
 * アシスタント応答完了後に LLM で会話を要約・分類し、embedding 付きで保存。
 * 次回送信時に pgvector 検索 → LLM rerank → recency スコアで並べ替え →
 * top-5 を system context に注入（RAG）。
 *
 * - kind: "fact" = 不変のユーザー情報・環境・設定。"working" = 現在のタスク・一時文脈。
 * - suppressedAt: 論理削除。replace/merge で古い記憶を無効化。
 * - folderId: folders.memoryScope が "folder" の場合、検索を同一フォルダに限定。
 *   "global" の場合は全スレッド横断（デフォルト）。
 */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["fact", "working"] }).notNull(),
    content: text("content").notNull(),
    sourceMessageIds: jsonb("source_message_ids").$type<string[]>(),
    embedding: vector("embedding", { dimensions: EMBED_DIM }).notNull(),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    importance: real("importance").notNull().default(0.5),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index("memories_thread_idx").on(t.threadId),
    folderIdx: index("memories_folder_idx").on(t.folderId),
    kindIdx: index("memories_kind_idx").on(t.kind),
    suppressedIdx: index("memories_suppressed_idx").on(t.suppressedAt),
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
 * memories テーブルの embedding 列と同次元。EMBED_DIM（env で変更可能）。
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
