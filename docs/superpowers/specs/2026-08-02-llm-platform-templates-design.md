# LLM プラットフォームテンプレート設計

## 概要

設定画面のLLM設定に「プラットフォーム」セレクトを追加する。UmansAI・OpenCode Go・OpenAI・OpenRouterなど有名な OpenAI 互換プラットフォームを選択すると、`LLM_PROVIDER=openai` への切替と `LLM_BASE_URL` の自動入力を一度で行う。Base URLのような「プラットフォーム毎に固定で、ユーザーが覚えにくい値」の手入力をなくす。

## 背景

`LLM_BASE_URL` はプラットフォーム毎に固定だが、ユーザーは設定画面に手入力する必要がある（例: OpenCode Go は `https://opencode.ai/zen/go/v1`、GitHub Models は `https://models.github.ai/inference`）。プロバイダを cursor から openai に切り替える場合も2つのフィールドを跨ぐ操作が必要で、入力を誤ると接続エラーの原因になる。

UmansChat の openai プロバイダは OpenAI 互換の chat/completions エンドポイントのみをサポートする。Anthropic ネイティブ形式（`/v1/messages`）や Responses API（`/v1/responses`）を提供するプラットフォームは対象外（プロキシ経由のみ可）。

## 設計判断（ユーザー承認済み）

- **自動入力の範囲は Base URL + プロバイダ切替のみ**。モデル候補リスト・thinking effort カタログの自動設定は行わない（YAGNI）。
- **テンプレートはクライアント側の静的定数**。サーバー API の変更なし。
- **対象は10件**: UmansAI, OpenCode Go, OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Google Gemini, GitHub Models。

## 対象コード

### `src/lib/llmTemplates.ts` — 新規

```ts
export const LLM_PLATFORM_TEMPLATES = [
  { id: "umans",      name: "UmansAI",       baseUrl: "https://api.code.umans.ai/v1" },
  { id: "opencode",   name: "OpenCode Go",   baseUrl: "https://opencode.ai/zen/go/v1" },
  { id: "openai",     name: "OpenAI",        baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter",     baseUrl: "https://openrouter.ai/api/v1" },
  { id: "groq",       name: "Groq",          baseUrl: "https://api.groq.com/openai/v1" },
  { id: "deepseek",   name: "DeepSeek",      baseUrl: "https://api.deepseek.com/v1" },
  { id: "mistral",    name: "Mistral",       baseUrl: "https://api.mistral.ai/v1" },
  { id: "xai",        name: "xAI",           baseUrl: "https://api.x.ai/v1" },
  { id: "gemini",     name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "github",     name: "GitHub Models", baseUrl: "https://models.github.ai/inference" },
] as const;

export type LlmPlatformId = (typeof LLM_PLATFORM_TEMPLATES)[number]["id"];
```

プラットフォーム名は固有名詞のため翻訳対象外。`id` は安定識別子（表示名変更や追加に耐える）。

### `src/components/SettingsModal.tsx` — セレクト追加

プロバイダ選択の直下・Base URL 入力欄の**直上**に「プラットフォーム」セレクトを追加。**openai プロバイダかどうかにかかわらず常に表示する**（テンプレート選択の役割の1つが「プロバイダを openai に切替」であるため、cursor 表示中でも選択可能でなければならない）。

**選択肢**:
- `custom` — 「カスタム（手入力）」。テンプレート非適用時の既定値。
- 10テンプレート各1件。

**挙動**:
1. テンプレート選択時: `update("llmProvider", "openai")` + `update("llmBaseUrl", <template.baseUrl>)`。APIキー・モデル・フォールバック等は触らない。
2. 現在の `form.llmBaseUrl` がテンプレートの `baseUrl` と完全一致する場合、そのテンプレートを選択表示。不一致（手入力・未入力）なら `custom`。
3. 選択後も Base URL 欄は自由に手編集可能（テンプレートは入力補助でありロックではない）。

**選択状態の導出**（セレクトの `value`）:

```ts
const selectedTemplateId =
  LLM_PLATFORM_TEMPLATES.find((t) => t.baseUrl === (form.llmBaseUrl ?? ""))?.id ?? "custom";
```

**変更時ハンドラ**:

```ts
function applyTemplate(id: string) {
  if (id === "custom") return; // 何もしない（手入力モードへ）
  const t = LLM_PLATFORM_TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  update("llmProvider", "openai");
  update("llmBaseUrl", t.baseUrl);
}
```

### `src/lib/i18n/dictionaries.ts` — 新規キー（ja/en 各2）

| キー | ja | en |
|---|---|---|
| `settings.platformTemplate` | プラットフォーム | Platform |
| `settings.platformTemplateDesc` | 選択するとプロバイダと Base URL を自動設定します（後から手編集可） | Selecting one auto-fills the provider and Base URL (editable afterwards) |

## 保存フロー

変更は従来どおり「保存」ボタン → `POST /api/settings` → `.env` 書き込み（`updateEnvContent`）を経由する。**API 側の変更は一切なし。** テンプレート選択はフォーム値（`llmProvider` / `llmBaseUrl`）の自動入力に過ぎず、保存ボタンで確定される。未保存のまま閉じると従来どおり破棄される。

## 対象外

- モデル候補リストの自動設定（`LLM_MODEL`、ModelCombobox の候補）
- thinking effort レベルのカタログ追加（`llm.reasoning.ts` の `MODEL_REASONING`）
- Anthropic ネイティブ / Responses API プラットフォームの対応
- Azure OpenAI 等、デプロイ毎に URL が変わるプラットフォーム

## テスト

### `src/components/SettingsModal.test.tsx` — 追加

1. **テンプレート選択で provider と baseUrl が更新される**: OpenCode Go を選択 → `llmProvider` が `openai`、`llmBaseUrl` が `https://opencode.ai/zen/go/v1` になる。**プロバイダが cursor の状態から選択した場合も `openai` に切り替わる**。
2. **現在値と一致するテンプレートが選択表示される**: `llmBaseUrl` が `https://openrouter.ai/api/v1` のときセレクトの値が `openrouter`。
3. **custom 選択では何も起きない**: `custom` を選んでも provider / baseUrl が変わらない。
4. **手入力値はテンプレート一致しない場合 custom 扱い**: `llmBaseUrl` が任意の手入力値のときセレクトの値が `custom`。

`LLM_PLATFORM_TEMPLATES` 自体は定数なので専用テスト不要（重複 id・重複 baseUrl の検証は任意）。

## 影響範囲

- クライアントのみ（`SettingsModal.tsx` + 新規 `llmTemplates.ts` + `dictionaries.ts` + テスト）。
- API・DB・`.env` スキーマ変更なし。既存設定への後方互換あり（カスタム URL のままでも動作）。
- README 更新: 設定画面の挙動に言及があるため、`README.md` / `README.ja.md` の該当箇所にテンプレート機能の1行を追記する。
