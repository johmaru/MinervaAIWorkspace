import { randomUUID } from "node:crypto";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
} from "drizzle-orm/sqlite-core";

/** タイムスタンプ列の共通ヘルパー: Unix epoch ms（integer）で保存し Date で読み書き。 */
function ts(name: string) {
  return integer(name, { mode: "timestamp_ms" });
}
/** NOT NULL タイムスタンプ列 + デフォルト now()。 */
function tsNow(name: string) {
  return integer(name, { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());
}

// ── Auth.js tables ──
/**
 * global_instructions — ユーザー単位の名前付きグローバルシステムインストラクション。
 * 複数作成可。users.activeInstructionId で既定、threads.globalInstructionId でスレッド上書き。
 * users の前に定義（users.activeInstructionId が本テーブルを前方参照するため）。
 */
export const globalInstructions = sqliteTable("global_instructions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

// users: アプリユーザー。emailUnique でログイン。passwordHash で Credentials 認証。
export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  nickname: text("nickname").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  activeInstructionId: text("active_instruction_id"),
  // DrizzleAdapter が OAuth createUser で書き込む列（Google ログイン用）
  name: text("name"),
  emailVerified: ts("email_verified"),
  image: text("image"),
  createdAt: tsNow("created_at"),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type"),  // DrizzleAdapter linkAccount 用（oauth / oidc / email）
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: ts("expires_at"),
  tokenType: text("token_type"),
  scope: text("scope"),
  idToken: text("id_token"),
});

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

// 埋め込み次元数: env EMBED_DIM（デフォルト 1024 = LFM2.5-Embedding-350M）。
// SQLite では embedding は text（JSON 配列）で保存するため、次元は列型ではなく
// アプリ側の cosine 関数（vectorSearch.ts）で検証用として使われる。
export const EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;

/**
 * skills — ユーザー単位の再利用可能プロンプト（persona / behavior / knowledge）。
 *
 * 会話から LLM で抽出・命名し、embedding 付きで保存。
 * 次回以降の全スレッドでアプリ側 cosine 検索 → system context に注入。
 * ユーザーが「〇〇スキルを使って」と指定すれば名前で直接適用。
 * 「スキルで保存して」で現在の会話からスキルを生成。
 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  embedding: text("embedding", { mode: "json" }).$type<number[]>().notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

/**
 * mcpServers — ユーザー単位の MCP (Model Context Protocol) サーバー接続定義。
 *
 * transport="http" の場合は url を使用（Streamable HTTP / SSE 自動フォールバック）。
 * transport="stdio" の場合は command + args + env でローカルプロセスを起動。
 * スレッド単位で有効/無効を切り替え（threads.mcpServerIds に id 配列を保持）。
 */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  transport: text("transport", { enum: ["http", "stdio"] }).notNull(),
  url: text("url"),
  command: text("command"),
  args: text("args", { mode: "json" }).$type<string[]>(),
  env: text("env", { mode: "json" }).$type<Record<string, string>>(),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});


/**
 * connections — ユーザーが OAuth 認証した外部サービス（Notion 等）。
 *
 * provider は enum で拡張可能（"notion" → 将来 "google", "github" 等）。
 * accessToken / refreshToken はトークン取得済みの行のみ存在（NOT NULL）。
 * workspaceName / workspaceIcon / ownerName / ownerEmail は表示用メタデータ。
 * スレッド単位で有効/無効を切り替え（threads.connectionIds に id 配列を保持）。
 */
export const connections = sqliteTable("connections", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["notion"] }).notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  workspaceName: text("workspace_name"),
  workspaceIcon: text("workspace_icon"),
  botId: text("bot_id"),
  ownerName: text("owner_name"),
  ownerEmail: text("owner_email"),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});


/**
 * threads — 会話スレッド
 * current_leaf_id: 現在表示中の枝の末端 message id。枝分かれナビで切替。
 */
export const threads = sqliteTable("threads", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  title: text("title").notNull().default("New chat"),
  systemPrompt: text("system_prompt"),
  model: text("model").notNull().default("umans-glm-5.2"),
  responseMode: text("response_mode", { enum: ["single", "dual"] }).notNull().default("single"),
  dualModelA: text("dual_model_a"),
  dualModelB: text("dual_model_b"),
  dualStrategy: text("dual_strategy", { enum: ["cross_review", "debate"] }).notNull().default("cross_review"),
  dualDebateRounds: integer("dual_debate_rounds").notNull().default(2),
  mcpServerIds: text("mcp_server_ids", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
  connectionIds: text("connection_ids", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  globalInstructionId: text("global_instruction_id").references(() => globalInstructions.id, { onDelete: "set null" }),
  currentLeafId: text("current_leaf_id"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

/**
 * folders — スレッドを束ねるフォルダ。
 * instruction は所属スレッドの systemPrompt 先頭に結合される。
 * memoryScope が "folder" の場合、会話メモリ(RAG)検索を同一フォルダ内に限定。
 * "global" の場合は従来通り全スレッド横断（デフォルト、後方互換）。
 * フォルダ階層は1階層のみ（自己参照なし）。
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
 * messages — 枝分かれツリー
 * parent_id が NULL ならスレッドのルート発言。
 * 編集/再生成は新しい行を作り parent_id で親に繋ぐ。
 * 古い枝も残す（ChatGPT 式）。
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentId: text("parent_id"), // 自己参照（ルートは NULL）
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    reasoning: text("reasoning"), // assistant の思考プロセス（折りたたみ表示用）
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
      model?: string;
      elapsedMs?: number;
    }>(),
    createdAt: tsNow("created_at"),
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
 * 次回送信時にアプリ側 cosine 検索 → LLM rerank → recency スコアで並べ替え →
 * top-5 を system context に注入（RAG）。
 *
 * - kind: "fact" = 不変のユーザー情報・環境・設定。"working" = 現在のタスク・一時文脈。
 * - suppressedAt: 論理削除。replace/merge で古い記憶を無効化。
 * - folderId: folders.memoryScope が "folder" の場合、検索を同一フォルダに限定。
 *   "global" の場合は全スレッド横断（デフォルト）。
 * - embedding: JSON 配列（text 列, mode: json）。vectorSearch.ts で cosine 計算。
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
    embedding: text("embedding", { mode: "json" }).$type<number[]>().notNull(),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    importance: real("importance").notNull().default(0.5),
    suppressedAt: ts("suppressed_at"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
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
    // 画像の場合: dataURL（base64）。テキストの場合: null
    dataUrl: text("data_url"),
    // PDF/テキストの場合: 抽出されたテキスト。画像の場合: null
    extractedText: text("extracted_text"),
    createdAt: tsNow("created_at"),
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
export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    url: text("url").notNull().unique(),
    urlHash: text("url_hash").notNull().unique(), // SHA-256(normalized URL), 取得キャッシュ判定
    title: text("title"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(), // SHA-256(content), 変更検知
    fetchedAt: tsNow("fetched_at"),
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
 * embedding は JSON 配列（text 列, mode: json）。vectorSearch.ts で cosine 計算。
 */
export const pageEmbeddings = sqliteTable(
  "page_embeddings",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    embedding: text("embedding", { mode: "json" }).$type<number[]>().notNull(),
    model: text("model").notNull(),
    createdAt: tsNow("created_at"),
  },
  (t) => ({
    pageIdx: index("page_embeddings_page_idx").on(t.pageId),
  }),
);
