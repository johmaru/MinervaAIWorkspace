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

### Phase 3: Markdown + theme ✅
- `react-markdown` + `remark-gfm` + `rehype-highlight` + `rehype-katex` (KaTeX)
- `next-themes` でダークモード（system / light / dark 切替）
- シンタックスハイライト (highlight.js github-dark)、数式 ($...$ / $$...$$)
- 自動テスト: 75 tests green（Markdown 10 tests + ThemeToggle 4 tests 追加）
### Phase 4: System prompt + model ✅
- スレッド単位 system prompt 編集（折りたたみ欄）
- モデルセレクタ（LLM_MODELS env で候補リスト、GET /api/models）
- useChat に updateThread 追加（PATCH /api/threads?id=...）
- 自動テスト: 88 tests green（ThreadSettings 9 tests + models API 4 tests 追加）

### Phase 5: Stop / regenerate / edit ✅
- `AbortController` で生成停止（停止ボタン）
- 再生成ボタン → parentMessageId から新しい assistant 枝を生成
- メッセージ編集 → 新しい user 兄弟枝 + assistant 応答
- 枝ナビ `‹ 1/2 ›` セレクタ（siblingGroups で same parentId をグループ化）
- チャット API 3 モード対応: send / regenerate / edit
- `buildContextChain()` で parent chain を遡り LLM context 構築
- `threads.currentLeafId` で表示中の枝を追跡
- 自動テスト: 92 tests green（枝分かれ 4 tests 追加: siblings, switchBranch, regenerate, editMessage）

### Phase 6: File attachments ✅
- 画像：base64 dataURL として DB 保存、vision モデルへ inline 渡し
- PDF：`pdf-parse` でテキスト抽出、LLM context にテキストパートとして挿入
- テキスト/JSON/コード：UTF-8 で読み込み、LLM context に挿入
- `attachments` テーブル（threadId + nullable messageId）
- `POST /api/upload`（multipart/form-data）+ chat API で `attachmentIds` リンク
- `AttachmentBar` コンポーネント（サムネイル + 削除ボタン）
- 📎 ファイル添付ボタン（複数選択可、10MB 制限）
- 自動テスト: 100 tests green（AttachmentBar 8 tests 追加）

### Phase 7: Vector RAG + search ✅
- `@xenova/transformers` (all-MiniLM-L6-v2, 384次元) でローカル embedding
- 応答完了後に user + assistant メッセージを非同期 embed（contentHash で重複回避）
- `POST /api/search`: pgvector cosine distance でスレッド横断セマンティック検索
- RAG: 送信時に他スレッドから top-5 類似発言を検索し system context に注入（類似度 > 0.5）
- `SearchBar` コンポーネント（サイドバー、ドロップダウン結果、類似度%表示）
- Dockerfile: `.dockerignore` 追加、バンドル sharp 削除で transformers.js 動作
- 自動テスト: 110 tests green（embed 4 tests + SearchBar 6 tests 追加）

### Phase 8: UI polish ✅
- モバイルサイドバー（ハンバーガーボタン + オーバーレイ + Esc 閉じる）
- レスポンシブ: `sm:` / `md:` ブレイクポイントで padding, gap, max-width 調整
- a11y: ARIA labels, roles, aria-live, aria-expanded, aria-controls, aria-hidden
- focus-visible アウトライン（WCAG AA準拠）, コントラスト改善
- 自動テスト: 119 tests green（ChatShell 9 tests 追加）

### Phase 9: URL スクレイピング + IP ブロック回避 ✅
- Scrapling（Python）FastAPI microservice（`scraper/`）で Web ページ取得
  - `AsyncFetcher.get()` が TLS fingerprint impersonation（`impersonate='chrome'`）+ `stealthy_headers=True` + `retries=3` を組み込み
  - robots.txt 尊重（`User-agent: *` ブロックの Disallow、fail-open）
  - docker-compose に `scraper` サービス追加（port 8000）
- `pages` + `page_embeddings` テーブル追加（pgvector 384次元、HNSW インデックス）
- `POST /api/scrape`: URL 取り込み → スクレイプ → embed → 恒久ナレッジ化（contentHash でキャッシュ）
- `POST /api/search` に `pages` フィールド追加（スレッド横断ページ検索）
- `findRelevantMessages()` にページ RAG 注入（類似度 > 0.3、メッセージは > 0.5）
- `UrlInput` コンポーネント（サイドバー、Enter で取り込み）
- `SearchBar` に 🌐 Web知識 セクション追加（ページ結果を外部リンク表示）
- vitest pool を threads に変更（sharp native module が forks pool でクラッシュするため）
- 自動テスト: 152 tests green（scraper 9 + scrape route 8 + search route 3 + UrlInput 6 + SearchBar 2 追加、Python 15+1skip）

### Phase 10: Web 検索 + 自動知識化 ✅
- SearXNG（セルフホスト metasearch）+ Tor プロキシを docker-compose に追加
  - `searxng` サービス: JSON API 有効化（`settings.yml` で `formats: [html, json]`）
  - `tor` サービス: SOCKS5 プロキシ（`dperson/torproxy`、`SCRAPE_PROXY` env で動的切り替え）
  - `app` / `scraper` に `SEARXNG_URL` / `TOR_PROXY` / `SCRAPE_PROXY` env 追加
- `scraper/main.py` に `POST /search` エンドポイント追加
  - SearXNG に検索依頼（httpx で JSON API）→ 上位 URL を `asyncio.gather` で並列スクレイピング
  - `scrape_url_safe()` で既存の `is_safe_host` / `extract_title` / `extract_text` を再利用（SSRF 保護継承）
  - `SCRAPE_PROXY` で Tor 経由スクレイピングを切り替え可能
- `src/lib/scraper.ts` に `searchWeb()` + `SourceInfo` / `WebSearchResult` 型追加
- `src/lib/pageStore.ts` 新規: `upsertPage()` で pages + page_embeddings の upsert + embed を共通化
  - `/api/scrape` route を `upsertPage` 呼び出しにリファクタ（重複排除）
- `/api/chat` route: 送信時に Web 検索 → 上位3件をスクレイピング → pages テーブルに知識化 → RAG 注入
  - SSE `sources` イベント追加（`send("sources", { sources })` を `start` の直後に送信）
- `useChat` hook: `sources` state + SSE `sources` イベント処理（送信/切替時にクリア）
- `ChatWindow`: 最新 assistant メッセージ下に「📚 参照元: N件」表示（外部リンク `target="_blank"`）
- Tor 切り替え: `SCRAPE_PROXY` env で scraper 側は動的、SearXNG 側は `settings.yml` の `outgoing.using_tor_proxy` 編集で切り替え
- 自動テスト: 161 vitest green（searchWeb 4 + pageStore 3 + useChat sources 1 + chat route sources 1 + ChatWindow 修正、Python 34+2skip: search endpoint 3 + scrape_url_safe 3 追加）
- GUI 設定モーダル: サイドバーの⚙️ボタンから全 `.env` 設定を GUI で編集可能
  - `GET/POST /api/settings`: 全設定取得 + `.env` へ保存 + 次元変更時の vector 列マイグレーション
  - `SettingsModal` コンポーネント: 5セクション（LLM / 埋め込み / Web検索 / Tor / DB）12項目
  - LLM 設定: BASE_URL, API_KEY, MODEL, MODELS, **Thinking Effort**（low/medium/high）
  - 埋め込みモデル: 4候補から選択、次元変更時はマイグレーション確認
  - Web 検索: 参照元件数, SCRAPER_URL, SEARXNG_URL
  - Tor プロキシ: TOR_PROXY, SCRAPE_PROXY（空 = Tor なし、socks5://tor:9050 = Tor あり）
  - Database: DATABASE_URL
  - 次元変更時は警告表示 → チェックボックスで確認 → vector 列再作成（HNSW インデックス含む）
- Thinking Effort: `THINKING_EFFORT` env で LLM の推論強度を制御（chat route で `reasoning_effort` パラメータとして送信）
- `.env` マウント: ホストの `.env` をコンテナにマウント（`volumes: ./.env:/app/.env`）+ `env_file` で読み込み
  - GUI で変更した `.env` が再ビルド後も保持される（イメージに焼き込まれない）
- 埋め込みモデル環境変数化: `EMBED_MODEL` / `EMBED_DIM` / `WEB_SEARCH_MAX_RESULTS` で動的切替
  - `embed.ts` / `schema.ts` / `pageStore.ts` / chat route が env を参照
  - 候補: all-MiniLM-L6-v2 (384), paraphrase-multilingual-MiniLM-L12-v2 (384, 推奨), multilingual-e5-small (384), multilingual-e5-base (768)
- 検索精度改善: 日本語の長い質問文をそのまま SearXNG に投げると精度が落ちる問題を解決
  - `extractSearchQuery()`: LLM で質問から検索クエリをキーワード化（「Project Motor Racingの2.0でて評価良いらしいんだけど本当？」→ "Project Motor Racing 2.0 評価" 等）。失敗時は元の質問にフォールバック
  - スクレイプ本文の注入を 2000→4000 文字に拡張し、「2.0」等の重要情報が欠落しないよう救済
  - スクレイプ失敗ページは SearXNG の snippet をフォールバックとして注入（情報ゼロを回避）
  - `findRelevantMessages()` の `page_embeddings` 検索を廃止: Web 検索で直接注入したページと重複・ノイズが増えるため。過去発言検索のみに専念
- E2E 検証済み: SearXNG 検索 → 並列スクレイピング → `sources` SSE → フロントで参照元3件表示
- GUI 検証済み: 設定モーダルで全設定編集 → Thinking Effort を high に変更 → 保存 → 再ビルド後も設定保持確認

### Phase 11: UI リフレッシュ — 深淵グラデ + glass-card ✅
- 前回フェーズ（Slate Lavender + glassmorphism）の「のっぺり」を解消
  - `--background` を `#0d1117` → `#0a0e17`（一段暗く）、`--muted` を `#161a26` → `#1c2235`（コントラスト比 1.09→1.5 で浮き立たせ）
  - 新変数 `--glow`（accent 発光用、ダーク `rgba(129,140,248,0.15)` / ライト `rgba(99,102,241,0.12)`）を `@theme inline` に `--color-glow` として登録
- body 背景: alpha 倍増の radial-gradient 2層（`background-attachment: fixed, fixed` でスクロール固定）
  - `.dark body` は `background-image` のみ上書きし、`background-attachment` と `background-size` は継承
  - **ノイズ SVG は撤去**: 当初 `feTurbulence` ノイズを追加したが、`<rect width="100%">` が不透明ノイズを全面描画して「砂嵐」状態になった（プランの「薄く乗る」前提が技術的に誤り）。グラデ＋glass-card で深みは十分なので削除
- `.glass-card` ユーティリティ: `inset 0 1px 0 0` の inner highlight + 低外影で「厚み」を演出（ライト=白ハイライト、ダーク=ラベンダーハイライト）
- 適用箇所: Sidebar aside / ThreadRow 選択行 / ChatWindow assistant バブル・入力欄上向き影・送信ボタン `--glow` 発光・user バブル `--glow` 外影・参照元・ThinkingBlock / 3モーダル本文・SearchBar ドロップダウン・ContextMenu ポータル
  - `shadow-*` と `glass-card` の box-shadow 衝突を回避: `glass-card` 適用要素からは `shadow-*` を削除
- 安全リスト維持: テキスト・aria・role・`text-red-500`・`.h-px.bg-border` は一切変更せず、className/CSS のみ
- 検証: typecheck green / build green / Docker 再ビルド + 本番 CSS チャンクで feTurbulence=0（砂嵐解消）、glass-card・radial-gradient・0a0e17・1c2235・background-attachment:fixed,fixed 確認済み

### Phase 12: 会話記憶システム — fact/working 記憶の抽出・検索・注入 ✅
- `embeddings` テーブル（死んだテーブル: 書き込み・読み込みなし）を削除し、新規 `memories` テーブルを追加
  - `kind` (fact/working), `content`, `embedding`, `importance`, `suppressedAt` (論理削除), `folderId` (スコープ判定)
  - HNSW インデックスで cosine 類似検索
- 記憶生成 (`src/lib/memory.ts`): アシスタント応答完了後に LLM で会話を要約・分類
  - fact (不変情報) / working (一時文脈) で分類
  - new / replace (suppressedAt で論理削除) / merge (LLM で content 統合) の action 判定
  - fire-and-forget で非同期実行（ストリーム完了を待たせない）
- 記憶検索 (`src/lib/memoryStore.ts`): 次回送信時に pgvector 検索 → LLM rerank → recency スコアで top-5
  - `folders.memoryScope` が "folder" の場合は同フォルダのみ検索、"global" は全スレッド横断
  - recency: `importance * 0.6 + exp(-age_days / 14) * 0.4`（2週間で半減）
- chat route 統合: `buildFinalMessages` に memory system message を注入（systemPrompt 直後、history 前）
- search route 切り替え: `embeddings` → `memories` テーブル、レスポンス型 `messageId`→`memoryId`/`role`→`kind`
- settings route 切り替え: `embeddings` → `memories` の vector 列次元管理
- マイグレーション `0005_memories.sql`: CREATE memories + DROP embeddings CASCADE + HNSW index
- テスト: 31 tests green（memory.test.ts 6 + memoryStore.test.ts 4 + search 4 + settings 4 + chat 11 + SearchBar 2）

## 環境変数（想定）

```
DATABASE_URL=postgres://...
LLM_BASE_URL=https://api.openai.com/v1   # or UmansAI / local
LLM_API_KEY=...
LLM_MODEL=gpt-4o-mini
EMBED_MODEL=text-embedding-3-small
EMBED_DIM=1536
SCRAPER_URL=http://localhost:8000       # or http://scraper:8000 in Docker
SEARXNG_URL=http://localhost:8080       # or http://searxng:8080 in Docker
TOR_PROXY=                               # empty = no Tor, socks5://tor:9050 = Tor
SCRAPE_PROXY=                            # empty = no Tor, socks5://tor:9050 = Tor
# 埋め込みモデル（transformers.js）:
#   Xenova/all-MiniLM-L6-v2               (384次元, 英語中心, デフォルト)
#   Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384次元, 多言語・日本語対応, 推奨)
#   Xenova/multilingual-e5-base            (768次元, 多言語, 高精度)
# モデル切替時は EMBED_DIM を合わせて変更 + DB マイグレーションが必要
EMBED_MODEL=Xenova/all-MiniLM-L6-v2
EMBED_DIM=384
# Web 検索の参照元数（チャット送信時に取得・スクレイピングする件数）
WEB_SEARCH_MAX_RESULTS=3

## 実行

```
docker compose up -d
# Next: http://localhost:3000
# Postgres: localhost:5432
```
