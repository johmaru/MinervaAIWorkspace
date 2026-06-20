# UmansChat

セルフホスト可能な、ストリーミング対応の AI チャットプラットフォーム。枝分かれする会話、セマンティック検索、Web 知識の取り込みを備えます。

[English](./README.md)

## 主な機能

- **ストリーミングチャット** — SSE によるトークンごとの出力
- **枝分かれする会話ツリー** — 再生成やメッセージ編集で兄弟ノードを作成。`< 1/N >` で兄弟間を移動
- **添付ファイル** — 画像（ビジョン）、PDF（テキスト抽出）、テキスト/コードファイル（1ファイル最大 10MB）
- **セマンティック検索** — 全スレッド横断で pgvector のコサイン類似度により検索
- **会話記憶** — 各ターン終了後に fact/working 記憶を抽出し、RAG コンテキストとして注入
- **Web ページスクレイピング → 知識化** — スクレイプしたページを RAG ソースとして取り込み、以降の回答に活用
- **アプリレベルの検索パイプライン** — 検索判定 LLM が検索要否を判断し、一言断りを表示 → SearXNG で検索 → 結果を context に注入して最終回答を生成
- **デュアルモデル結論** — 2つのモデルを相互レビュー方式または会話方式で走らせ、統合した最終回答をストリーミングし、A/Bの検討内容は折りたたみ詳細で確認可能
- **Tor プロキシ** — 匿名スクレイピングのための Tor 対応
- **Thinking Effort 制御** — モデル毎に対応レベルが異なる（GLM-5.2: `none`/`high`/`max`、Flash: `none`/`low`/`medium`/`high`）。制御非対応モデルでは無視される
- **埋め込みモデル切替** — transformers.js によるローカル ONNX、または HTTP Python embedder サービス
- **フォルダ分け** — スレッドをフォルダで整理
- **ダーク / ライト / システムテーマ**
- **EN / JA 国際化切替**（デフォルトは英語）
- **OpenAI 互換 LLM バックエンド** — UmansAI、OpenAI、vLLM、Ollama など
- **自動タイトル生成** — 最初のユーザーメッセージから生成
- **スレッド単位のシステムプロンプトとモデル選択**
- **設定 GUI** — `.env` に書き込み、埋め込みモデルのマイグレーション以外は再起動不要

## アーキテクチャ

UmansChat は Next.js 16 + React 19 のアプリケーションで、pgvector 拡張を入れた PostgreSQL 16 をバックエンドに持ち、Docker Compose により5つのサービスで構成されます。

```mermaid
flowchart LR
    subgraph Client
        Browser[ブラウザ :3001]
    end
    subgraph Compose
        app[app<br/>Next.js 16 + Bun]
        db[(db<br/>pgvector pg16)]
        embedder[embedder<br/>Python sentence-transformers]
        scraper[scraper<br/>Scrapling FastAPI]
        searxng[searxng<br/>メタ検索]
        tor[tor<br/>dperson/torproxy]
    end
    Browser --> app
    app --> db
    app --> embedder
    app --> scraper
    scraper --> searxng
    searxng --> tor
```

| サービス   | イメージ / ビルド        | 役割                                            | ポート         |
|------------|--------------------------|-------------------------------------------------|----------------|
| `app`      | `Dockerfile` からビルド  | Next.js アプリ（チャット UI・API・設定）         | `3001 → 3000`  |
| `db`       | `pgvector/pgvector:pg16` | pgvector 拡張入り PostgreSQL 16                  | `5432`         |
| `embedder` | `./embedder` からビルド  | Python `sentence-transformers` HTTP embedder    | `8000`（公開） |
| `scraper`  | `./scraper` からビルド   | Scrapling FastAPI スクレイパー + SearXNG クライアント | `8000`（公開） |
| `searxng`  | `searxng/searxng:latest` | SearXNG メタ検索エンジン                         | `8081 → 8080`  |
| `tor`      | `dperson/torproxy:latest`| 匿名スクレイピング用 Tor SOCKS プロキシ          | `9050`（公開） |

## 必要環境

- **Node.js / Bun** — Bun が主なランタイム兼パッケージマネージャ
- **Docker**（Docker Compose 含む） — DB、スクレイパー、embedder、検索、Tor の各サービス用
- **OpenAI 互換 LLM の API キー** — UmansAI、OpenAI、vLLM、Ollama など

## クイックスタート（Docker）

UmansChat を自己完結したサービスとして動かす場合の推奨手順です。

```bash
# 1. 環境設定テンプレートをコピー
cp .env.example .env

# 2. LLM の API キーを設定（必須）
#    .env を編集し LLM_API_KEY を入力
#    必要に応じて LLM_BASE_URL と LLM_MODEL をプロバイダに合わせて設定

# 3. 全サービスを起動
docker compose up -d

# 4. アプリを開く
#    http://localhost:3001
```

初回起動時、データベースのマイグレーションはアプリが自動的に適用します。初期セットアップ後に埋め込みモデルを変更する場合は [データベースマイグレーション](#データベースマイグレーション) を参照してください。

## クイックスタート（ローカル開発）

Next.js アプリ本体を開発する場合の手順です。

```bash
# 1. 依存パッケージをインストール
bun install

# 2. データベース（必要に応じて他サービスも）を Docker で起動
docker compose up -d db

# 3. 環境設定テンプレートをコピーして設定
cp .env.example .env
#    DATABASE_URL、LLM_API_KEY、および（スクレイピング/検索を使う場合）
#    各サービスの URL を設定

# 4. 開発サーバーを起動
bun run dev
#    http://localhost:3000
```

ローカル開発中にスクレイピング/検索が必要な場合は、DB とあわせて scraper / embedder / searxng / tor を起動できます。

```bash
docker compose up -d db scraper embedder searxng tor
```

Compose 経由ではなくアプリを直接動かす場合は、`.env` の `SCRAPER_URL`・`SEARXNG_URL`・`EMBEDDER_URL`（HTTP 埋め込みを使う場合）を、ホストに公開されたポートに向けてください。

## 設定

設定はすべて `.env` にまとまっています（`.env.example` が典拠）。アプリ内の設定 GUI で大部分を実行時に編集でき、再起動不要です。

| 変数                    | 説明                                                              | デフォルト                                           |
|-------------------------|-------------------------------------------------------------------|------------------------------------------------------|
| `LLM_BASE_URL`          | OpenAI 互換 API のベース URL（api.code.umans.ai で Umansモード自動取得） | `https://api.code.umans.ai/v1`                       |
| `LLM_API_KEY`           | API キー（必須）                                                  | —                                                    |
| `LLM_MODEL`             | デフォルトモデル                                                  | `umans-glm-5.2`                                      |
| `LLM_MODELS`            | モデルセレクタ用のカンマ区切りモデル一覧（OAI互換モード用。Umansモードでは無視） | —                                                    |
| `THINKING_EFFORT`       | 推論レベル（`none`/`low`/`medium`/`high`/`max`、モデル毎に異なる）  | `medium`                                             |
| `EMBED_MODEL`           | 埋め込みモデル名                                                  | `Xenova/all-MiniLM-L6-v2`                            |
| `EMBED_DIM`             | 埋め込み次元数                                                    | `384`                                                |
| `WEB_SEARCH_MAX_RESULTS`| チャット送信時に取得・スクレイピングする件数                       | `3`                                                  |
| `WEB_SEARCH_MAX_ROUNDS` | 廃止 — 検索ラウンド数は検索判定 LLM が決定（1回答あたり1-3クエリ） | `2`                                                  |
| `SCRAPER_URL`           | Scraper マイクロサービスの URL                                    | `http://localhost:8000`                              |
| `SEARXNG_URL`           | SearXNG の URL                                                    | `http://localhost:8080`                              |
| `TOR_PROXY`             | アプリ側の Tor プロキシ（参考用。空 = Tor なし）                  | —                                                    |
| `SCRAPE_PROXY`          | Scraper がスクレイピング時に使用するプロキシ                       | —                                                    |
| `DATABASE_URL`          | PostgreSQL 接続 URL（ローカル `bun run dev` 時に使用）            | `postgres://umans:umans@localhost:5432/umanschat`    |

## 使い方

- **スレッド作成** — 入力欄に入力すると、最初の送信でスレッドが作成され、最初のメッセージから自動でタイトルが生成されます。
- **メッセージ送信** — `Enter` で送信、`Shift+Enter` で改行。応答はトークンごとにストリーミングされます。
- **枝分かれ** — 任意のメッセージで「再生成」または「編集」を行うと兄弟ブランチが作成されます。`< 1/N >` で兄弟間を移動できます。
- **デュアルモデルモード** — スレッド設定で「応答モード」を「デュアルモデル」に切り替え、モデルA/Bと「相互レビュー」または「会話方式」を選びます。チャットには統合された最終回答が先に表示され、A/B回答・レビュー・議論ログは「デュアルモデル詳細」の折りたたみで確認できます。1メッセージあたり複数回LLMを呼ぶため、通常モードよりコストと待ち時間が増えます。
- **添付ファイル** — 画像（ビジョン対応モデルに送信）、PDF（テキスト抽出）、テキスト/コードファイル（各 10MB まで）を添付できます。
- **セマンティック検索** — 全スレッドを横断して検索し、pgvector のコサイン類似度で順位付けします。
- **Web スクレイピング** — Web 検索が有効な場合、結果がスクレイプされ、現在の回答の RAG ソースとして取り込まれます。
- **Tor** — 設定で Tor を切り替え、匿名スクレイピングを有効にできます。
- **設定** — 設定パネルを開き、LLM プロバイダ/モデル、Thinking Effort、埋め込みモデル、Web 検索件数、Tor オプションを変更できます。変更は `.env` に書き込まれ、埋め込みモデルの変更（マイグレーションが必要）以外は即座に反映されます。

## データベースマイグレーション

UmansChat は Drizzle ORM と pgvector を使用します。手動でマイグレーションを適用する場合（例: ローカルの新規データベース）:

```bash
bunx drizzle-kit migrate
```

埋め込みモデルを切り替えた場合（`EMBED_MODEL` / `EMBED_DIM` を変更）、既存の `embeddings` および `page_embeddings` のベクトル列を新しい次元数で再作成する必要があります。設定 GUI のマイグレーション機能（`applyMigration`）を使ってベクトル列を削除・再作成した上で、コンテンツを再埋め込みしてください。

## テスト

```bash
# ユニットテスト
bun run test

# 型チェック
bun run typecheck

# リント
bun run lint
```
