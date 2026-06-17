# UmansChat — 設計 & 実装計画

ChatGPT ライクなチャットウィンドウ。UmansAI / OpenAI 互換 LLM と会話。
PostgreSQL + pgvector で RDB とベクトルを1DB ハイブリッド運用。
メッセージ編集は ChatGPT 式の枝分かれ。UI はミニマル自作。

## 確定事項

| 項目 | 決定 |
|---|---|
| フロント | Next.js 15 (App Router) + React 19 + TypeScript + Tailwind |
| バックエンド | Route Handlers / OpenAI 互換 SDK（baseURL 切替） |
| ストレージ | PostgreSQL + `pgvector`（1DB ハイブリッド） |
| ORM | Drizzle ORM |
| ベクトル用途 | C：セマンティック検索 + 長期記憶 RAG |
| メッセージ編集 | 枝分かれ（親ポインタツリー、`threads.current_leaf_id`） |
| デザイン | ミニマル自作（モノクロ + 1アクセント、罫線仕切り、細サイドバー） |
| 実行 | Docker Compose（Next + Postgres） |

## アーキテクチャ

```
Browser ──> Next.js Route Handlers ──> OpenAI 互換 LLM (env: LLM_BASE_URL)
   │             │
   │             v
   │      PostgreSQL + pgvector
   │       - threads (RDB)
   │       - messages (RDB, parent_id 自己参照でツリー)
   │       - embeddings (vector(1536))  -- RAG/検索用
   │
   └─ localStorage: オフラインキャッシュ（任意）
```

### データモデル概要

```
threads
  id, title, system_prompt, model, current_leaf_id, created_at, updated_at

messages
  id, thread_id, parent_id (自己参照, NULL=root), role, content,
  created_at
  -- 枝分かれ: 編集/再生成は新しいレコードを作り parent_id で繋ぐ

embeddings
  id, message_id, content_hash, embedding vector(1536), model, created_at
```

### 枝分かれの挙動

- ユーザー発言を編集 → 元メッセージは残し、新しい message (parent_id=同じ親) を作成。
- `threads.current_leaf_id` を新しい方に更新。サイドバーで枝を選択可能。
- 再生成も同じ仕組み：assistant メッセージを新規作成、parent_id はユーザー発言。

## フェーズ

### Phase 0: Scaffold
- Next.js + TS + Tailwind 初期化
- Docker Compose（Next + Postgres with pgvector）
- Drizzle スキーマ + 初回マイグレーション
- スケルトンレイアウト（サイドバー + メイン）

### Phase 1: Streaming chat ✅
- 単一スレッドのチャット UI（メッセージリスト + 入力欄）
- `/api/chat` Route Handler、SSE でストリーミング
- OpenAI 互換クライアント（`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` env）
- 自動テスト: Vitest + React Testing Library（実 API で SSE 疎通検証含む、30 tests green）

### Phase 2: Threads + persistence ✅
- サイドバー：スレッド CRUD（作成/選択/リネーム/削除）
- メッセージ Postgres 永続化（/api/chat が user/assistant を DB に保存）
- 楽観更新（state + fetch、SWR/React Query は最適化フェーズで検討）
- title 自動生成（初回 user 発言から先頭40字）
- 自動テスト: 55 tests green（実 API SSE + DB 永続化含む）

### Phase 3: Markdown + theme
- `react-markdown` + `remark-gfm` + `rehype-highlight` + KaTeX
- `next-themes` でダークモード

### Phase 4: System prompt + model
- スレッド単位 system prompt 編集（折りたたみ欄）
- モデルセレクタ（env で候補リスト）

### Phase 5: Stop / regenerate / edit
- `AbortController` で生成停止
- 再生成ボタン → 新しい assistant 枝
- メッセージ編集 → 新しい user 枝、`current_leaf_id` 切替
- 枝ナビ（"< 1/2 >" のようなセレクタ）

### Phase 6: File attachments
- 画像：base64 inline で vision モデルへ
- PDF/テキスト：サーバ側でテキスト抽出（`pdf-parse` 等）

### Phase 7: Vector RAG + search
- エンベディング生成パイプライン（応答後に message を embed）
- セマンティック検索 UI（スレッド横断検索バー）
- RAG：新規送信時、関連過去発言を自動でコンテキスト注入

### Phase 8: UI polish
- ミニマルデザイン詰め（行間、罫線、アクセント色）
- レスポンシブ + a11y

## 環境変数（想定）

```
DATABASE_URL=postgres://...
LLM_BASE_URL=https://api.openai.com/v1   # or UmansAI / local
LLM_API_KEY=...
LLM_MODEL=gpt-4o-mini
EMBED_MODEL=text-embedding-3-small
EMBED_DIM=1536
```

## 実行

```
docker compose up -d
# Next: http://localhost:3000
# Postgres: localhost:5432
```
