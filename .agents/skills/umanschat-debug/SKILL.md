---
name: umanschat-debug
description: >
  UmansChat プロジェクト固有のデバッグ手法とトラブルシューティングガイド。
  SSE スリーミング、Docker ビルド、transformers.js、pgvector、Next.js 16 の
  既知の落とし穴と解決策を含む。UmansChat のコード変更・デバッグ時に参照すること。
origin: session-debug-log
---

# Skill: UmansChat Debug Guide

UmansChat 開発で実際に遭遇したバグとその解決手法。再発時の診断時間を短縮する。

## アーキテクチャ概要

```
Next.js 16 (App Router, Turbopack) + Bun
├── src/app/api/         # Route Handlers (SSE streaming, Node.js runtime)
├── src/components/      # React 19 (ChatWindow, Sidebar, Markdown, etc.)
├── src/hooks/           # useChat, useThreads (状態管理 + SSE パース)
├── src/lib/             # llm.ts (OpenAI SDK), embed.ts (transformers.js)
├── src/db/              # Drizzle ORM + better-sqlite3 (SQLite)
└── Docker               | Bun → Next.js build → runner stage
```

## トラブルシューティング辞典

### 1. Thinking がメッセージと同じ場所に表示される

**症状**: LLM の思考内容が回答バブル内に混ざって表示される。

**原因**: `MessageBubble` コンポーネントが `ThinkingBlock` をバブル内にレンダリングしている。

**修正**: `ThinkingBlock` をバブルの外（上）に独立配置。

```tsx
// BAD: ThinkingBlock がバブル内
<div className="bg-muted ...">
  {thinking && <ThinkingBlock />}
  {answer}
</div>

// GOOD: ThinkingBlock がバブル外
<div className="flex flex-col items-start gap-1">
  {thinking && <ThinkingBlock />}
  <div className="bg-muted ...">{answer}</div>
</div>
```

**ファイル**: `src/components/ChatWindow.tsx` の `MessageBubble`

---

### 2. Thinking イベントがブラウザに届かない（SSE 圧縮問題）

**症状**: `curl` では `event: thinking` が来るが、ブラウザでは来ない。

**診断手順**:
1. `curl -sN -X POST localhost:3001/api/chat` で SSE を直接確認
2. ブラウザで `fetch()` を使って SSE を直接読み取り（`tab.evaluate` 内）
3. ブラウザと curl で差があれば、圧縮またはプロキシが原因

**原因**: Next.js 16 の `compress: true`（デフォルト）が gzip で SSE をバッファリングする。
`thinking` イベントが圧縮レイヤーで溜め込まれ、届かない。

**修正**: `next.config.ts` で `compress: false`。

```typescript
const nextConfig: NextConfig = {
  compress: false, // SSE は圧縮すべきではない
};
```

**ドキュメント**: `node_modules/next/dist/docs/01-app/02-guides/streaming.md` に
「Gzip and Brotli compression can buffer chunks internally before flushing」と明記。

---

### 3. Thinking が来ない（モデル不一致問題）

**症状**: 圧縮を無効化しても thinking が来ない。curl では来る。

**診断手順**:
1. `docker compose logs app` でサーバーログ確認
2. DB で `messages` テーブルの `model` カラム確認
3. スレッド作成 API がどの model を設定しているか確認

**原因**: スレッド作成時に `body.model` が `undefined` で、DB のデフォルト
（`gpt-4o-mini`）が使われる。`gpt-4o-mini` は `reasoning_content` を返さない。

**修正**: `src/app/api/threads/route.ts` でデフォルトを `defaultModel()` に。

```typescript
model: body.model ?? defaultModel(),
```

**確認**: `docker compose exec db psql -U umans -d umanschat -c "SELECT model FROM threads;"`

---

### 4. Docker でコード変更が反映されない

**症状**: `docker compose up --build -d` しても古いコードのまま。

**原因**: BuildKit のレイヤーキャッシュが `COPY . .` でキャッシュヒットする。

**修正**: `--no-cache` で完全リビルド。

```bash
docker compose build --no-cache app
docker compose up -d app --force-recreate
```

---

### 5. .dockerignore が無いと node_modules が上書きされる

**症状**: Dockerfile で `node_modules` の修正（シンボリックリンク削除等）が
ランタイムで消える。

**原因**: `.dockerignore` が無いと `COPY . .` がホストの `node_modules/` で
Docker 内のクリーンな `node_modules/` を上書きする。

**修正**: `.dockerignore` を作成。

```
node_modules
.next
.git
.env.local
*.md
```

---

### 6. transformers.js が sharp ネイティブバイナリエラーで落ちる

**症状**: `@xenova/transformers` の `pipeline()` 呼び出しで
「Cannot find module '../build/Release/sharp-linux-x64.node'」エラー。

**原因**: `@xenova/transformers` がバンドルする `sharp` にネイティブバイナリが無い。

**修正**: Dockerfile でバンドル版 sharp を削除し、トップレベルの sharp にフォールバック。

```dockerfile
RUN bun install --frozen-lockfile
RUN rm -rf node_modules/@xenova/transformers/node_modules/sharp
```

テキスト embedding のみに使う場合、sharp（画像処理）は不要だが、
transformers.js は起動時に sharp をロードしようとするため削除が必要。

---

### 7. SSE イベントのクライアント側デバッグ

**手法**: ブラウザの `fetch` をモンキーパッチして SSE を傍受。

```javascript
// tab.evaluate 内で実行
const origFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await origFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (url?.includes('/api/chat')) {
    const [a, b] = res.body.tee(); // ストリームを分岐
    // b を観察、a を useChat に返す
    (async () => {
      const reader = b.getReader();
      // ...イベントを収集
    })();
    return new Response(a, { status: res.status, headers: res.headers });
  }
  return res;
};
```

**注意**: `res.clone()` はストリームを壊すことがある。`tee()` を使う。
また、モンキーパッチ自体がイベント受信に影響するため、
最終的にはパッチなしで `waitForResponse` と `response.text()` で確認する。

---

### 8. DB の状態確認

```bash
# メッセージと reasoning の確認
docker compose exec -T db psql -U umans -d umanschat -c \
  "SELECT id, role, LEFT(content, 40), LEFT(reasoning, 40), length(reasoning) FROM messages ORDER BY created_at DESC LIMIT 10;"

# embeddings の確認
docker compose exec -T db psql -U umans -d umanschat -c \
  "SELECT COUNT(*) FROM embeddings;"

# スレッドのモデル確認
docker compose exec -T db psql -U umans -d umanschat -c \
  "SELECT id, title, model, current_leaf_id FROM threads;"
```

---

### 9. LLM API の直接テスト

```bash
# コンテナ内から LLM API を直接叩く
docker compose exec -T app bun -e '
const OpenAI = (await import("openai")).default;
const llm = new OpenAI({ baseURL: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY });
const completion = await llm.chat.completions.create({
  model: process.env.LLM_MODEL,
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of completion) {
  const delta = chunk.choices?.[0]?.delta;
  const reasoning = delta?.reasoning_content;
  if (reasoning) console.log("REASONING:", reasoning.slice(0, 50));
  if (delta?.content) console.log("CONTENT:", delta.content.slice(0, 50));
}
'
```

---

### 10. pgvector の cosine distance クエリ

```sql
-- 類似度検索（1 - distance = similarity）
SELECT m.content, m.role, t.title,
       1 - (e.embedding <=> '[0.1, 0.2, ...]'::vector) as similarity
FROM embeddings e
JOIN messages m ON e.message_id = m.id
JOIN threads t ON m.thread_id = t.id
WHERE m.thread_id != 'current-thread-id'
ORDER BY e.embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 5;
```

**注意**: drizzle-orm は pgvector の `<=>` 演算子を直接サポートしないため、
`sql` タグで raw SQL を書く。ベクトルは `JSON.stringify(array)` で渡し、
`::vector` でキャストする。

---

### 11. 記憶が保存されない（fire-and-forget 問題）

**症状**: `memories` テーブルが 0 行。LLM 記憶抽出呼び出しは成功し、
embedder も 200 OK を返すが、DB に何も保存されない。`docker compose logs app`
にもエラーが出力されない（`.catch` が実行されない）。

**原因**: `src/app/api/chat/route.ts` の `finally` ブロックで
`generateMemories` を `void generateMemories(...).catch(...)` として
fire-and-forget で呼び出している。`controller.close()` がストリームを終了すると、
Next.js 本番ランタイムが未完了のバックグラウンド Promise をキャンセルする。
`.catch` ハンドラ自体も実行されないため、エラーが完全に沈黙する。

**修正**: `finally` ブロック内で `await generateMemories(...)` する。
`done` SSE イベントは `try` ブロック内（`finally` の前）に送信済みのため、
クライアント UX に影響しない。エラーは `try/catch` で握りつぶし、ログのみ出力。

```typescript
// BAD: fire-and-forget — close() が Promise をキャンセル
void generateMemories(...).catch((err) => console.error("[memory]", err));

// GOOD: await で完了を保証（done 送信後なので UX 影響なし）
try {
  await generateMemories(...);
} catch (err) {
  console.error("[memory] generation failed:", err);
}
```

**注意**: `controller.close()` を `await` の前に移動してはいけない。
ストリームを先に閉じると、ランタイムが未完了 Promise を再キャンセルする。
**ファイル**: `src/app/api/chat/route.ts` の `finally` ブロック。

**検証**: 記憶抽出 LLM 呼び出しに時間がかかる場合（GLM で ~90秒）、
`done` 受信後もストリームが開いたままになる。クライアントは `done` 受信で
完了扱いするため問題ないが、サーバ側はメモリ保存完了まで待つ。

---

### 12. Vitest テスト環境の DB マイグレーション競合

**症状**: `bun run test` で `SqliteError: no such table: users` または `table 'accounts' already exists` が発生。

**原因**:
- `vitest.setup.ts` が DB マイグレーションを実行しない（`predev` の `drizzle-kit migrate` のみ）。
- `:memory:` DB は `openDatabase` の `fileMustExist` プローブで throw → corruption 警告。
- `process.pid` ベースの DB ファイルは複数 worker で共有され、migrate が再実行されて "table already exists" になる。

**修正** (`vitest.setup.ts`):
1. `DATABASE_URL` に `VITEST_WORKER_ID` を含めて worker ごとに固有の DB ファイルを作成。
2. ファイル先頭で `DATABASE_URL` を設定（静的 import の hoist より前）。
3. `@/db` と `migrate` は動的 `await import()` で読み込む（hoist 回避）。
4. `globalThis.__umanschatTestDbReady` ガードで同一 worker 内の再マイグレーションを防止。
5. 共有テストユーザー（`test-user-id`）をマイグレーション後に作成（FK 制約対応）。

```ts
import { tmpdir } from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("/app/data/")) {
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  process.env.DATABASE_URL = join(tmpdir(), `umanschat-test-${process.pid}-${workerId}.db`);
  try { unlinkSync(process.env.DATABASE_URL); } catch { /* 初回 */ }
}
// ... .env 読み込み ...
const globalForTestSetup = globalThis as unknown as { __umanschatTestDbReady?: boolean };
if (!globalForTestSetup.__umanschatTestDbReady) {
  const { db } = await import("@/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const { users } = await import("@/db/schema");
  await db.insert(users).values({ id: "test-user-id", nickname: "tester", email: "t@example.com" }).onConflictDoNothing();
  globalForTestSetup.__umanschatTestDbReady = true;
}
```

---

### 13. next-auth headers() がテストで throw する

**症状**: `Error: headers was called outside a request scope`

**原因**: `getSessionUser()` が `auth()` → `headers()` を呼ぶ。テスト環境では Next.js request store がない。

**修正**: テストファイルに `vi.mock("@/lib/auth-guards")` を追加。

```ts
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
```

**注意**: `chat/route` を import するテスト（`instruction.test.ts` 等）は `next/server` の `after()` も mock が必要。

---

### 14. jsdom が HTMLElement.scrollTo を実装していない

**症状**: `TypeError: el.scrollTo is not a function` （ChatWindow の自動スクロール）

**修正** (`vitest.setup.ts`):
```ts
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function () {};
}
```

---

### 15. I18nProvider 初回レンダーが en で日本語アサーションが失敗する

**症状**: `getByText("日本語ラベル")` が失敗。`I18nProvider` の `useState(DEFAULT_LOCALE)` が `en` で初期化されるため。

**修正**: テストファイルに `vi.mock("@/lib/i18n/types")` を追加して `DEFAULT_LOCALE` を `ja` に上書き。

```ts
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
```

**注意**:
- `vi.mock` は hoist されるため、component import より前に評価される。
- `beforeEach` に `localStorage.setItem("umanschat-locale", "ja")` も追加（useEffect 復元整合性）。
- Hook テスト（`.ts` ファイル）は `I18nProvider` wrapper が必要。JSX が使えないため `createElement` を使用:
```ts
import { createElement, type ReactNode } from "react";
import { I18nProvider } from "@/components/I18nProvider";
const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nProvider, null, children);
// renderHook を alias して wrapper を自動適用
import { renderHook as rtlRenderHook } from "@testing-library/react";
function renderHook<T>(callback: () => T) {
  return rtlRenderHook(callback, { wrapper });
}
```

---

### 16. Accordion コンポーネントのテスト（AnimatePresence exit animation）

**症状**: トグルクリック後に `queryByPlaceholderText(...).not.toBeInTheDocument()` が失敗。`AnimatePresence` の exit animation 中も DOM に残るため。

**修正**: `await waitFor()` で exit 完了を待つ。
```ts
fireEvent.click(btn); // close
await waitFor(() => {
  expect(screen.queryByPlaceholderText("...")).not.toBeInTheDocument();
});
```

**注意**: `Accordion` は `defaultOpen=false` でマウントされる。内容を確認するにはクリックで開く必要がある。`closest("details")` は使えない（`Accordion` は `<details>` ではなく `<button>` + `AnimatePresence`）。

---

### 17. Route Handler テストで日本語ステータスメッセージが期待と不一致

**症状**: `expect(lastStatus.data.label).toContain("Web検索で結果が見つかりませんでした")` が失敗。実際は英語。

**原因**: `getRequestLocale(req)` が Cookie なしで `DEFAULT_LOCALE = "en"` にフォールバック。

**修正**: テストの Request helper に locale cookie を追加:
```ts
headers: { "Content-Type": "application/json", cookie: "umanschat-locale=ja" },
```

---

### 18. useFolders の error が成功後にクリアされない

**症状**: create/update/remove 失敗後に成功すると、`error` が `null` にならない。

**原因**: `useFolders` の `create`/`update`/`remove` が成功時に `setError(null)` を呼んでいない（`useThreads.move` は呼んでいる）。

**修正**: 成功パスに `setError(null)` を追加。

---

### 19. folder.instruction が chat route に結合されない

**症状**: `instruction.test.ts` が 404 または systemContent に folder instruction が含まれない。

**原因**: `chat/route.ts` が `folders` テーブルの `instruction` カラムを読んでいなかった。

**修正**: `chat/route.ts` で `thread.folderId` 経由で `folders.instruction` を lookup（`folders.userId === user.id` で所有権チェック）。空白のみは trim で除外。`systemContent` の先頭に結合。

---
## デバッグの基本手順

1. **症状を再現** — ブラウザまたは curl で確実に再現
2. **サーバログ確認** — `docker compose logs app --tail=30`
3. **DB 状態確認** — psql でデータの有無・整合性をチェック
4. **API 直接テスト** — curl またはコンテナ内 bun -e で API を直接叩く
5. **ブラウザ DOM 確認** — `tab.evaluate` で DOM 構造とスタイルを検査
6. **差分比較** — curl vs ブラウザ、動く環境 vs 動かない環境で差を特定
7. **最小再現** — 問題を再現する最小条件を見つける

## 頻出ファイル

| ファイル | 役割 |
|---|---|
| `src/app/api/chat/route.ts` | SSE スリーミング、LLM 呼び出し、RAG、embedding |
| `src/hooks/useChat.ts` | クライアント側 SSE パース、状態管理、枝分かれ |
| `src/components/ChatWindow.tsx` | メッセージ表示、入力、再生成・編集 |
| `src/lib/llm.ts` | LLM クライアント、モデル設定 |
| `src/lib/embed.ts` | transformers.js embedding |
| `next.config.ts` | compress 設定、Next.js 設定 |
| `Dockerfile` | ビルドステージ、sharp 削除 |
| `.dockerignore` | node_modules 上書き防止 |
| `docker-compose.yml` | env 変数、ポートマッピング |
| `src/lib/i18n/types.ts` | DEFAULT_LOCALE, LOCALE_STORAGE_KEY |
| `src/lib/auth-guards.ts` | getSessionUser (next-auth headers) |
| `src/hooks/useFolders.ts` | フォルダ CRUD、error クリア |
| `src/components/ui/motion.tsx` | Accordion, AnimatePresence |
| `vitest.setup.ts` | DB migration, test user, scrollTo polyfill |
| `vitest.config.mts` | threads pool, next/server alias |

## 環境変数

```
DATABASE_URL=umanschat.db
LLM_BASE_URL=https://api.code.umans.ai/v1
LLM_API_KEY=sk-...
LLM_MODEL=umans-glm-5.2
LLM_MODELS=umans-glm-5.2,gpt-4o-mini,gpt-4o
```
