# MinervaAIWorkspace Blocker 修正計画

**作成日**: 2026-07-14
**対象**: セキュリティ診断で発見された Blocker 3件

---

## 修正前の発見件数サマリー（修正済み）

| 深刻度 | 件数 | 備考 |
|---------|------|------|
| **BLOCKER** | 3 | B1, B2, B3 |
| **CRITICAL** | 5 | C3削除（実コード確認で事実誤認と判明） |
| **HIGH** | 9 | C7緩和+1, H8 Google OAuth乗っ取り+1 |
| **MEDIUM** | 12 | 変更なし |
| **LOW** | 20+ | 変更なし |

### C3削除の理由

`getEnvContext()` (route.ts:976-981) は `Current date` / `Environment: ${os} (${arch})` のみを返す。
`LLM_API_KEY`や`AUTH_SECRET`はLLMコンテキストに入っていない。
真のリスクは `workspace.ts:81` の `env: { ...process.env }` で子プロセスに全環境変数を渡している点。
これはB1（run_command RCE）の一部であり、独立したCRITICALではない。
B1を修正すれば子プロセスへの環境変数露出も解決する。

---

## B1: run_commandツール経由のRCE

### 現状

```
LLM → run_command tool call → route.ts:1955-1964 → workspace.ts:70-101
  → spawn("cmd.exe", ["/c", command], { cwd: wsRoot, env: { ...process.env } })
```

- `parsedArgs.command` がそのまま `cmd.exe /c` または `bash -c` に渡される
- ホワイトリスト・サンドボックス・サニタイズなし
- `env: { ...process.env }` で子プロセスに全環境変数（API_KEY等含む）が渡される
- プロンプト注入で攻撃者が任意コマンドを実行可能

### 修正方針

#### Phase B1-1: コマンドホワイトリスト導入

`src/lib/workspace.ts` の `runWorkspaceCommand` を以下のように変更:

```typescript
// 許可するコマンドのプレフィックス（先頭トークンで判定）
const ALLOWED_COMMANDS = [
  // バージョン管理
  "git status", "git log", "git diff", "git branch", "git show", "git remote",
  // ファイル操作（読み取り系）
  "ls", "dir", "cat", "head", "tail", "find", "wc", "file",
  // 開発ツール（情報取得系）
  "node --version", "npm --version", "bun --version",
  "python --version", "python3 --version", "pip --version",
  "tsc --version", "eslint --version",
  // パッケージ情報
  "npm list", "npm outdated", "npm audit",
  "bun pm",
  // テスト・ビルド（プロジェクト内のみ）
  "npm test", "npm run", "bun test", "bun run",
  "npm run build", "npm run lint", "npm run typecheck",
  // テキスト処理
  "grep", "rg", "ag", "ack",
  "echo",
] as const;

// 明示的に拒否するパターン
const BLOCKED_PATTERNS = [
  /[|;&`$]/,           // パイプ・チェーン・コマンド置換
  /\b(rm|del|rmdir|rd)\b/i,  // 削除コマンド
  /\b(curl|wget|nc|netcat|ssh|scp|ftp|telnet)\b/i,  // ネットワークツール
  /\b(echo|type|copy|move|ren|rename)\b.*\.\./i,  // パストラバーサル
  />/,               // リダイレクト（ファイル書き込み）
  /\b(set|export)\b/i,  // 環境変数操作
  /\b(eval|exec|source)\b/i,  // 間接実行
] as const;
```

```typescript
export async function runWorkspaceCommand(command: string): Promise<string> {
  const trimmed = command.trim();

  // 1. ブロックパターンチェック
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `Blocked: command contains disallowed pattern`;
    }
  }

  // 2. ホワイトリストチェック（先頭トークンで判定）
  const normalized = trimmed.toLowerCase();
  const isAllowed = ALLOWED_COMMANDS.some(cmd =>
    normalized === cmd || normalized.startsWith(cmd + " ")
  );
  if (!isAllowed) {
    return `Blocked: command "${trimmed.split(/\s+/)[0]}" is not in the allowed list`;
  }

  // 3. 実行（環境変数をフィルタリング）
  const wsRoot = getWorkspaceRoot();
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/bash";
  const args = isWindows ? ["/c", trimmed] : ["-c", trimmed];

  const proc = spawn(shell, args, {
    cwd: wsRoot,
    timeout: COMMAND_TIMEOUT_MS,
    // 安全な環境変数のみ渡す
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      USERPROFILE: process.env.USERPROFILE ?? "",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TZ: process.env.TZ ?? "Asia/Tokyo",
    },
  });
  // ... 残りは既存ロジック
}
```

#### Phase B1-2: tool定義のdescription更新

`src/app/api/chat/route.ts:1580-1581` の tool description を変更:

```typescript
{
  name: "run_command",
  description: "Execute a whitelisted shell command in the workspace directory. Allowed: git (read-only), ls, cat, head, tail, find, wc, grep, node/npm/bun/python version checks, npm/bun scripts (test, build, lint, typecheck). Output (stdout+stderr) is returned. 30-second timeout.",
  // ...
}
```

#### Phase B1-3: テスト追加

`src/lib/workspace.test.ts`（新規）に以下を追加:

- ホワイトリスト内コマンドの実行成功
- `rm -rf /` のブロック確認
- パイプ `|` のブロック確認
- `curl http://evil.com` のブロック確認
- 環境変数 `LLM_API_KEY` が子プロセスに渡らないことの確認

### 影響ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/workspace.ts` | ホワイトリスト・ブロックパターン・env フィルタリング |
| `src/app/api/chat/route.ts` | tool description 更新 |
| `src/lib/workspace.test.ts`（新規） | セキュリティテスト |

---

## B2: MCP stdioトランスポート経由の任意コマンド実行

### 現状

```
ユーザー → MCPサーバー登録（command, args, env 自由指定）
  → mcpClient.ts:99-109
  → new StdioClientTransport({ command: config.command, args: config.args, env: config.env })
  → 任意プロセス起動
```

- `config.command` がユーザー入力そのまま
- `config.args` も自由指定
- `config.env` も自由指定
- 認証済みユーザーなら任意プロセスを起動可能

### 修正方針

#### Phase B2-1: コマンドホワイトリスト

`src/lib/mcpClient.ts` の `connectMcpServer` に stdio コマンド検証を追加:

```typescript
// MCP stdio で許可するコマンド（バイナリ名のみ）
const ALLOWED_MCP_COMMANDS = new Set([
  "npx", "node", "python", "python3", "uvx", "bun",
  "docker",  // docker run のみ許可（後述）
]);

// 拒否パターン
const BLOCKED_MCP_PATTERNS = [
  /[|;&`$]/,           // シェルメタ文字
  /\.\./,              // パストラバーサル
  /\/etc\/|\/var\/|\/root\//,  // 機密ディレクトリ参照
];

function validateMcpCommand(command: string): { allowed: boolean; reason?: string } {
  const trimmed = command.trim();

  for (const pattern of BLOCKED_MCP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Command contains disallowed pattern` };
    }
    }

  // コマンド名を抽出（パスの最後の要素）
  const cmdName = trimmed.split(/[/\\]/).pop()?.split(/\s+/)[0]?.toLowerCase();
  if (!cmdName || !ALLOWED_MCP_COMMANDS.has(cmdName)) {
    return { allowed: false, reason: `Command "${cmdName}" is not in the allowed list` };
  }

  return { allowed: true };
}
```

`connectMcpServer` 内での使用:

```typescript
} else if (config.transport === "stdio") {
  if (!config.command) {
    logger.error("mcp", "stdio server has no command, skipping", { server: config.name });
    return null;
  }
  const validation = validateMcpCommand(config.command);
  if (!validation.allowed) {
    logger.error("mcp", "stdio command blocked", { server: config.name, reason: validation.reason });
    return null;
  }
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    // env は渡さない（最小権限）
    env: undefined,
  });
  await client.connect(transport);
}
```

#### Phase B2-2: MCPサーバー登録APIでのバリデーション

`src/app/api/mcp-servers/route.ts` の POST でも同様の検証を追加（多層防御）。

#### Phase B2-3: テスト追加

`src/lib/mcpClient.test.ts`（新規）に以下を追加:

- 許可コマンド（`npx`, `python3`等）の通過確認
- `bash -c "rm -rf /"` のブロック確認
- シェルメタ文字 `;` のブロック確認
- env が渡されないことの確認

### 影響ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/mcpClient.ts` | stdio コマンド検証・env 削除 |
| `src/app/api/mcp-servers/route.ts` | POST でのコマンド検証 |
| `src/lib/mcpClient.test.ts`（新規） | セキュリティテスト |

---

## B3: Docker socketマウント + run_command = ホストエスケープ

### 現状

```yaml
# docker-compose.yml:26
- /var/run/docker.sock:/var/run/docker.sock
```

- app コンテナがホストの Docker API にアクセス可能
- B1のRCEと組み合わせると `docker run --privileged -v /:/host alpine` 等でホスト完全制御
- この socket は `api/tor/route.ts` と `lib/logReader.ts` の `docker compose restart` / `docker logs` 用

### 修正方針

#### Phase B3-1: Docker socketマウントを削除

`docker-compose.yml` から以下を削除:

```diff
    volumes:
      - ./.env:/app/.env
      - ./data:/app/data
-     # For starting/stopping the Tor container: mount Docker socket + compose file
-     - /var/run/docker.sock:/var/run/docker.sock
-     - ./docker-compose.yml:/app/docker-compose.yml:ro
      - ${CHAT_EXPORT_HOST_PATH:-./data/chat-export}:/app/chat-export
```

#### Phase B3-2: Tor/scraper 再起動を内部 API 経由に変更

Docker socket を使っている箇所を特定し、代替手段に切り替える:

**`src/app/api/tor/route.ts`** — `docker compose restart scraper` を実行:
- 代替案: scraper コンテナに `/restart-proxy` エンドポイントを追加し、app から HTTP で通知
- または: Tor プロキシの有効/無効を scraper がポーリングで `SCRAPE_PROXY` 環境変数を読み取る方式に変更

**`src/lib/logReader.ts`** — `docker logs` を実行:
- 代替案: アプリが自身の `stdout`/`stderr` をファイルに書き出し、それを読む方式に変更
- 既に `logFileEnabled` でファイルログ出力があるため、Docker 環境でも有効化する

**`src/lib/tunnel.ts`** — `docker compose` コマンドを使用:
- tunnel (cloudflared) は既に Docker 内で実行されているため、app コンテナからは HTTP で cloudflared API を叩く方式に変更
- または、`docker compose` に依存しない単体バイナリモードをデフォルトにする

#### Phase B3-3: docker-compose.yml のリファクタリング

```yaml
services:
  app:
    # ...
    volumes:
      - ./.env:/app/.env
      - ./data:/app/data
      - ${CHAT_EXPORT_HOST_PATH:-./data/chat-export}:/app/chat-export
      # ログファイルをホストと共有（Docker logs の代替）
      - ./data/logs:/app/data/logs
    # Docker socket マウント削除
    # docker-compose.yml マウント削除
```

#### Phase B3-4: Tor 制御方式の変更

`src/app/api/tor/route.ts` を `docker compose restart scraper` から別方式に変更:

```typescript
// Before: docker compose restart scraper
// After: scraper の /config エンドポイント経由でプロキシ設定を動的変更

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { enabled } = await req.json();
  const proxyUrl = enabled
    ? (process.env.TOR_PROXY || "socks5://tor:9050")
    : "";

  // scraper にプロキシ設定を通知（docker compose restart 不要）
  const scraperUrl = process.env.SCRAPER_URL || "http://scraper:8000";
  const response = await fetch(`${scraperUrl}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxy: proxyUrl }),
  });

  // .env も更新（永続化）
  const updates: Record<string, string> = {};
  updates["SCRAPE_PROXY"] = proxyUrl;
  await writeEnvUpdates(updates);

  return Response.json({ enabled });
}
```

### 影響ファイル

| ファイル | 変更内容 |
|---------|---------|
| `docker-compose.yml` | Docker socket・compose マウント削除 |
| `src/app/api/tor/route.ts` | `docker compose restart` → HTTP API 経由に変更 |
| `src/lib/logReader.ts` | `docker logs` → ファイルログ読み取りに変更 |
| `src/lib/tunnel.ts` | `docker compose` 依存の箇所を HTTP・単体バイナリに変更 |
| `scraper/main.py` | `/config` エンドポイントでプロキシ動的変更に対応 |
| `Dockerfile` | Docker CLI インストール削除（不要化） |

---

## 実行順序と依存関係

```
Phase 1: B1（run_command RCE）— 最優先、他の全てに先行
  ├─ B1-1: workspace.ts ホワイトリスト + env フィルタリング
  ├─ B1-2: chat route.ts tool description 更新
  └─ B1-3: テスト追加

Phase 2: B2（MCP stdio RCE）— B1 と並行可能
  ├─ B2-1: mcpClient.ts コマンド検証
  ├─ B2-2: mcp-servers API バリデーション
  └─ B2-3: テスト追加

Phase 3: B3（Docker socket）— B1 完了後に実行（B1 があれば B3 のリスク軽減済み）
  ├─ B3-1: docker-compose.yml マウント削除
  ├─ B3-2: Tor/scraper 再起動を内部 API に変更
  ├─ B3-3: logReader をファイルベースに変更
  ├─ B3-4: tunnel.ts を docker compose 非依存に変更
  └─ B3-5: Dockerfile から Docker CLI 削除
```

### 依存関係

- B1 と B2 は並行実行可能（独立したファイル・機能）
- B3 は B1 完了後が望ましい（B1 で RCE を制限した上で、Docker socket を削除するため）
- B3-2（Tor API 変更）は `scraper/main.py` の変更を前提とする

---

## 検証計画

各 Phase 完了後に以下を実施:

### B1 検証
- [ ] `npm test` で workspace.test.ts のテストが全通過
- [ ] 手動: チャットから `run_command` で `git status` が実行できる
- [ ] 手動: チャットから `run_command` で `curl http://evil.com` がブロックされる
- [ ] 手動: チャットから `run_command` で `rm -rf /` がブロックされる
- [ ] 手動: 子プロセスで `echo $LLM_API_KEY` が空を返す

### B2 検証
- [ ] `npm test` で mcpClient.test.ts のテストが全通過
- [ ] 手動: `npx @anthropic/mcp-server` が起動する
- [ ] 手動: `bash -c "cat /etc/passwd"` がブロックされる

### B3 検証
- [ ] `docker compose up -d` で app コンテナが正常起動
- [ ] 手動: Tor トグルが機能する（scraper の /config 経由）
- [ ] 手動: ログ読み取りが機能する（ファイルベース）
- [ ] 手動: トンネル起動が機能する
- [ ] 手動: `docker exec minerva-app docker ps` が「docker: not found」を返す
- [ ] `npm test` で既存テストが全通過
- [ ] `npm run typecheck` がエラーゼロ

---

## リスク評価

| 修正 | 破壊的変更のリスク | 影響範囲 |
|------|-------------------|---------|
| B1 ホワイトリスト | 中 — 既存のコマンドがブロックされる可能性 | チャットで `run_command` を使う全ユーザー |
| B2 MCP検証 | 低 — 標準的な MCPサーバー（npx等）は影響なし | MCP stdio サーバーを使うユーザー |
| B3 Docker socket削除 | 高 — Tor/ログ/トンネル機能の実装変更が必要 | Docker 環境の全ユーザー |

B3 は破壊的変更が大きいため、移行期間を設けるか、feature flag で段階的に切り替えることを推奨。
