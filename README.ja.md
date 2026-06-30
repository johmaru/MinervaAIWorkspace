# UmansChat

セルフホスト可能な、ストリーミング対応の AI チャットプラットフォーム。枝分かれする会話、セマンティック検索、Web 知識の取り込みを備えます。

[English](./README.md)

## 主な機能

- **ストリーミングチャット** — SSE によるトークンごとの出力
- **ラピッドモード** — 入力欄の ⚡ ボタンで、Web 検索・URL スクレイプ・記憶/スキル RAG（LLM 前の取得とストリーム後の生成の両方）をスキップし、初回トークンまでのレイテンシを下げます。MCP/コネクションツールとデュアルモデルフローは有効なまま。再度 ⚡ をクリックするまで、メッセージやスレッドを跨いでオン状態が維持されます。
- **枝分かれする会話ツリー** — 再生成やメッセージ編集で兄弟ノードを作成。`< 1/N >` で兄弟間を移動
- **添付ファイル** — 画像（ビジョン）、PDF（テキスト抽出）、テキスト/コードファイル（1ファイル最大 10MB）
- **セマンティック検索** — 全スレッド横断でコサイン類似度により検索
- **会話記憶** — 各ターン終了後に fact/working 記憶を抽出し、RAG コンテキストとして注入。サイドバーの 🧠 メモリマネージャーから記憶の確認・検索・編集・削除・手動追加が可能
- **Web ページスクレイピング → 知識化** — スクレイプしたページを RAG ソースとして取り込み、以降の回答に活用。チャットに URL を貼ると自動でスクレイプしてコンテキストに注入
- **Web 検索** — アプリレベルの SearXNG パイプライン。検索クエリ生成と結果要約は検索専用モデルが担当。揮発性情報・明示的な検索要求・未知の語や固有名詞で自動起動。設定で切替可能
- **デュアルモデル結論** — 2つのモデルを相互レビュー方式または会話方式で走らせ、統合した最終回答をストリーミングし、A/Bの検討内容は折りたたみ詳細で確認可能
- **Tor プロキシ** — 匿名スクレイピングのための Tor 対応
- **Thinking Effort 制御** — モデル毎に対応レベルが異なる（GLM-5.2: `none`/`high`/`max`、Flash: `none`/`low`/`medium`/`high`）。制御非対応モデルでは無視される
- **埋め込みモデル切替** — transformers.js によるローカル ONNX、または HTTP Python embedder サービス
- **フォルダ分け** — スレッドをフォルダで整理
- **ダーク / ライト / システムテーマ**
- **EN / JA 国際化切替**（デフォルトは英語）
- **OpenAI 互換 LLM バックエンド** — UmansAI、OpenAI、vLLM、Ollama など
- **自動タイトル生成** — 最初のユーザーメッセージから生成
- **日時・実行環境のプロンプト注入** — 現在日時（タイムゾーン考慮）と検出した OS/アーキテクチャを全プロンプトの先頭に付与し、モデルが環境に適した回答を返すようにする
- **モデル名・経過時間表示** — 各アシスタントメッセージに使用モデルと応答時間を表示
- **モーション UI アニメーション** — モーダル遷移、ボタン押下フィードバック、アコーディオン展開、スムーズスクロール
- **スレッド単位のシステムプロンプトとモデル選択**
- **MCP サーバー統合** — 外部の Model Context Protocol サーバー（Streamable HTTP / stdio）を登録し、スレッド単位で有効化。LLM がストリーミング中にツールを発見・呼び出し、組み込みの検索/スクレイプツールと併用可能
- **コネクション（Notion）** — Notion アカウントを OAuth で連携。チャット中に LLM が `notion_search`、`notion_get_page`、`notion_get_blocks` ツールを呼び出し、Notion のコンテンツを検索・取得。スレッド単位で＋メニューから有効化
- **アカウント認証** — Auth.js v5 + Credentials（email/password）+ オプションで Google OAuth。初回起動時にアカウント作成が必要、以降はログイン。ユーザー毎にデータが分離
- **設定 GUI** — `.env` に書き込み、埋め込みモデルのマイグレーション以外は再起動不要

## アーキテクチャ

UmansChat は Next.js 16 + React 19 のアプリケーションで、SQLite（better-sqlite3）をバックエンドに持ちます — ファイルベースの組み込みデータベースで、別サーバーは不要です。下記の Docker Compose 構成は、アプリとオプションサービスをまとめて起動します。

```mermaid
flowchart LR
    subgraph Client
        Browser[ブラウザ :3001]
    end
    subgraph Compose
        app[app<br/>Next.js 16 + Bun]
        db[(db<br/>SQLite better-sqlite3)]
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
| `db`       | `better-sqlite3`（SQLite）  | SQLite データベース（ファイルベース・組み込み）            | —              |
| `embedder` | `./embedder` からビルド  | Python `sentence-transformers` HTTP embedder    | `8000`（公開） |
| `scraper`  | `./scraper` からビルド   | Scrapling FastAPI スクレイパー + SearXNG クライアント | `8000`（公開） |
| `searxng`  | `searxng/searxng:latest` | SearXNG メタ検索エンジン                         | `8081 → 8080`  |
| `tor`      | `dperson/torproxy:latest`| 匿名スクレイピング用 Tor SOCKS プロキシ          | `9050`（公開） |

- **Node.js / Bun** — Bun が主なランタイム兼パッケージマネージャ（ローカル開発・ビルド用）
- **Docker**（Docker Compose 含む） — 任意。スクレイパー、embedder、検索、Tor などのオプションサービスを利用する場合に必要。スタンドアロン Windows exe とローカル開発の SQLite パスは追加インストール不要
- **OpenAI 互換 LLM の API キー** — UmansAI、OpenAI、vLLM、Ollama など

## クイックスタート（Docker）

UmansChat を自己完結したサービスとして動かす場合の推奨手順です。

```bash
# 1. 環境設定テンプレートをコピー
cp .env.example .env

# 2. LLM の API キーを設定（必須）
#    .env を編集し LLM_API_KEY を入力
#    必要に応じて LLM_BASE_URL と LLM_MODEL をプロバイダに合わせて設定

# 2b. AUTH_SECRET を生成して .env に追加
bunx auth secret
# 2c.（任意）「Google でログイン」を有効にする場合、.env に設定:
#     GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET
#     https://console.cloud.google.com/apis/credentials で認証情報を作成
#     リダイレクト URI: http://localhost:3001/api/auth/callback/google

# 3. 全サービスを起動
docker compose up -d

# 4. アプリを開く
#    http://localhost:3001
#    初回起動時は管理者アカウントの作成を求められます
```

初回起動時、データベースのマイグレーションはアプリが自動的に適用されます。また、初回は管理者アカウントの作成（ニックネーム + メールアドレス + パスワード）を求められます。以降のアクセスにはログインが必要です。ユーザー毎にスレッド・フォルダ・記憶は分離されます。初期セットアップ後に埋め込みモデルを変更する場合は [データベースマイグレーション](#データベースマイグレーション) を参照してください。

## クイックスタート（スタンドアロン Windows exe）

Docker を使わずに配布・実行するもう一つの方法です。Docker や Node.js、Bun をユーザー環境に用意する必要はありません。ビルド環境でのみ Bun が必要です。

```bash
# 1. 依存パッケージをインストール（ビルド環境）
bun install

# 2. 環境設定テンプレートをコピーして設定
cp .env.example .env
#    .env を編集し LLM_API_KEY を入力
#    AUTH_SECRET を生成: bunx auth secret

# 3. 配布フォルダをビルド
bun run build
bun scripts/pack-exe.ts
#    dist/UmansChat/ に umanschat.exe と必要ファイル一式が出力されます
```

`dist/UmansChat/` フォルダをユーザーの Windows マシンにそのまま配布できます。`umanschat.exe` をダブルクリックすると：

1. 同梱の SQLite データベース（`data/umanschat.db`）を初回起動時に作成し、マイグレーションを適用
2. サーバーを起動し、ブラウザで `http://localhost:3001` を自動で開く
3. 初回は管理者アカウントの作成を求められます

**埋め込みモデルの初回ダウンロード**: スタンドアロン exe はデフォルトでローカル ONNX 埋め込み（`Xenova/all-MiniLM-L6-v2`）を使います。初回の埋め込み生成時に Hugging Face からモデルがダウンロードされるため、インターネット接続が必要です。モデルのダウンロードが完了すれば、以降のチャットはオフラインで動作します。

**オプションサービスの縮退**: スタンドアロン exe にはスクレイパー、SearXNG、Tor、Python embedder は同梱されません。これらの機能を使わずにチャットは正常に動作しますが、Web 検索・スクレイピングは空の結果を返します（エラーにはなりません）。スクレイピング/検索を利用したい場合は別途 Docker で該当サービスを起動し、`.env` の `SCRAPER_URL`・`SEARXNG_URL` を公開ポートに向けてください。


## Cloudflare Tunnel によるパブリックアクセス（任意）

ポート開放やパブリック IP なしで HTTPS 経由でアプリを公開するには、Cloudflare 名前付きトンネルを使います。リモートネットワークから Google OAuth を利用する場合に推奨します。

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels → Create a tunnel で名前付きトンネルを作成（タイプ: Cloudflared）。
2. パブリックホスト名を追加し、`Service=http://app:3000` にルーティング。
3. 発行されたトークンを `.env` に設定:
   ```
   TUNNEL_TOKEN=your-token-here
   AUTH_URL=https://your-tunnel.example.com
   ```
4. トンネルプロファイル付きで起動:
   ```bash
   docker compose --profile tunnel up -d
   ```
5. Google Cloud Console で認可リダイレクト URI を以下に設定:
   `https://your-tunnel.example.com/api/auth/callback/google`

`--profile tunnel` なしの場合、cloudflared サービスは除外され、アプリは通常通り `localhost:3001` で動作します。

## クイックスタート（ローカル開発）

Next.js アプリ本体を開発する場合の手順です。

```bash
# 1. 依存パッケージをインストール
bun install

# 2. データベースを準備（SQLite は組み込み。初回起動時に data/umanschat.db が自動作成される）
#    スクレイピング/検索などのオプションサービスを使う場合は別途 Docker で起動（後述）

# 3. 環境設定テンプレートをコピーして設定
cp .env.example .env
#    LLM_API_KEY を設定。スクレイピング/検索を使う場合は各サービス URL も設定

# 4. 開発サーバーを起動（predev フックが自動でマイグレーションを実行）
bun run dev
#    http://localhost:3000
```

ローカル開発では Docker で DB コンテナを起動する必要はありません。SQLite ファイル（`data/umanschat.db`）が `bun run dev` の初回起動時に自動作成され、`predev` フックが `drizzle-kit migrate` でテーブルを作成します。

ローカル開発中にスクレイピング/検索が必要な場合は、scraper / embedder / searxng / tor を Docker で起動できます。

```bash
docker compose up -d scraper embedder searxng tor
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
| `EMBED_MODEL`           | 埋め込みモデル名（`local` プロバイダでは `Xenova/*` モデルを使用） | `Xenova/all-MiniLM-L6-v2`                           |
| `EMBED_DIM`             | 埋め込み次元数                                                    | `384`                                               |
| `EMBED_PROVIDER`        | 埋め込みバックエンド: `local`（ONNX）または `http`（Python embedder） | `local`                                  |
| `EMBEDDER_URL`          | Python embedder の URL（`EMBED_PROVIDER=http` 時に必要。Docker は自動設定） | `http://localhost:8001`                   |
| `WEB_SEARCH_MAX_RESULTS`| チャット送信時に取得・スクレイピングする件数                       | `3`                                                  |
| `WEB_SEARCH_MAX_ROUNDS` | 1回の回答で検索を繰り返す最大回数（1-5）。検索判定 LLM が決定したクエリのうち実行する数を制限 | `2`                                                  |
| `SCRAPER_URL`           | Scraper マイクロサービスの URL                                    | `http://localhost:8000`                              |
| `SEARXNG_URL`           | SearXNG の URL                                                    | `http://localhost:8080`                              |
| `TOR_PROXY`             | アプリ側の Tor プロキシ（参考用。空 = Tor なし）                  | —                                                    |
| `SCRAPE_PROXY`          | Scraper がスクレイピング時に使用するプロキシ                       | —                                                    |
| `WEB_SEARCH_MODEL`    | 検索クエリ生成と結果要約に使うモデル                              | `umans-coder`                                        |
| `DATABASE_URL`          | SQLite データベースファイルのパス                                   | `data/umanschat.db`                                  |
| `HOST_OS`              | プロンプトに注入する OS 名（`Windows`, `macOS`, `Linux`。空 = `/proc/version` から自動検出） | —                            |
| `AUTH_SECRET`           | Auth.js JWT 暗号化シークレット（必須。`bunx auth secret` で生成） | —                                                  |
| `AUTH_TRUST_HOST`       | リバースプロキシ背後でホストヘッダーを信頼（Docker 用）            | `true`                                               |
| `TZ`                   | プロンプト日時表示のタイムゾーン（空 = `Asia/Tokyo`）              | —                                                    |
| `NOTION_CLIENT_ID`      | Notion OAuth クライアント ID（コネクション機能。[Notion 連携設定](#notion-連携設定)を参照） | — |
| `NOTION_CLIENT_SECRET`  | Notion OAuth クライアントシークレット                              | —                                                    |
| `AUTH_URL`              | アプリの公開 URL（Notion OAuth リダイレクト URI と一致する必要あり） | `http://localhost:3001`                             |

## Notion 連携設定

コネクション機能を使うと、チャット中に LLM が Notion ツール（ページ検索、ページ内容取得）を呼び出せます。有効化手順:

1. [https://www.notion.so/developers](https://www.notion.so/developers) で **public** インテグレーションを作成する。
2. リダイレクト URI を `http://localhost:3001/api/connections/notion/callback` に設定する（デプロイ環境に合わせてホスト/ポートを調整）。
3. `.env` に `NOTION_CLIENT_ID` と `NOTION_CLIENT_SECRET` を設定する。`AUTH_URL` はアプリの公開 URL に合わせる（リダイレクト URI と一致させる）。
4. アプリを再起動する（`docker compose up -d --build`）。
5. 設定 → コネクション →「Notion に接続」を開く。Notion で認可すると、コネクションが設定リストに表示される。
6. スレッド単位: ＋メニュー →「コネクション」→ Notion コネクションをオンにする。LLM が会話内容から判断して Notion ツールを自動呼び出しする。

## 使い方

- **スレッド作成** — 入力欄に入力すると、最初の送信でスレッドが作成され、最初のメッセージから自動でタイトルが生成されます。
- **メッセージ送信** — `Enter` で送信、`Shift+Enter` で改行。応答はトークンごとにストリーミングされます。完了した各アシスタントメッセージの下にモデル名と応答時間が表示されます。
- **ラピッドモード** — 入力欄の ⚡ をクリックすると、Web 検索・URL スクレイプ・記憶/スキル取得をスキップして高速に応答します。再度 ⚡ をクリックするまで、以降のメッセージ（スレッド切替後も）でオンのままです。MCP/コネクションツールとデュアルモデルモードは通常通り動作します。
- **枝分かれ** — 任意のメッセージで「再生成」または「編集」を行うと兄弟ブランチが作成されます。`< 1/N >` で兄弟間を移動できます。
- **デュアルモデルモード** — スレッド設定で「応答モード」を「デュアルモデル」に切り替え、モデルA/Bと「相互レビュー」または「会話方式」を選びます。チャットには統合された最終回答が先に表示され、A/B回答・レビュー・議論ログは「デュアルモデル詳細」の折りたたみで確認できます。1メッセージあたり複数回LLMを呼ぶため、通常モードよりコストと待ち時間が増えます。
- **添付ファイル** — 画像（ビジョン対応モデルに送信）、PDF（テキスト抽出）、テキスト/コードファイル（各 10MB まで）を添付できます。
- **セマンティック検索** — 全スレッドを横断して検索し、コサイン類似度で順位付けします。
- **Web スクレイピング** — Web 検索が有効な場合、結果がスクレイプされ、現在の回答の RAG ソースとして取り込まれます。
- **Tor** — 設定で Tor を切り替え、匿名スクレイピングを有効にできます。
- **設定** — 設定パネルを開き、LLM プロバイダ/モデル、Thinking Effort、埋め込みモデル、Web 検索件数、Tor オプションを変更できます。変更は `.env` に書き込まれ、埋め込みモデルの変更（マイグレーションが必要）以外は即座に反映されます。
- **メモリマネージャー** — サイドバーの 🧠 ボタンから会話記憶（fact/working）の一覧表示・検索・フィルタ・編集（内容/種類/重要度）・削除（論理削除で RAG から除外）・手動追加ができます。

## データベースマイグレーション

UmansChat は Drizzle ORM を使用し、デフォルトで SQLite（better-sqlite3）をバックエンドにします。初回起動時に `drizzle-kit migrate` がテーブルを作成します — `bun run dev` の `predev` フック、Docker コンテナの起動エントリ、スタンドアロン exe のランチャーのいずれかが実行します。pgvector 拡張や HNSW インデックスは不要です。

Docker を使わないローカル開発では、`predev` フックが自動的に `drizzle-kit migrate` を実行するため手動適用は不要です（[クイックスタート（ローカル開発）](#クイックスタートローカル開発) を参照）。

埋め込みモデルを切り替えた場合（`EMBED_MODEL` / `EMBED_DIM` を変更）、既存の埋め込みデータは新しいベクトル空間と互換性がなくなります。設定 GUI のマイグレーション機能（`applyMigration`）は `memories` および `page_embeddings` テーブルの埋め込みデータをクリアします（DDL 不要 — SQLite では埋め込みは JSON text 列として保存されるため、次元数に依存しません）。クリア後、コンテンツを再埋め込みしてください。

## テスト

```bash
# ユニットテスト
bun run test

# 型チェック
bun run typecheck

# リント
bun run lint
```
