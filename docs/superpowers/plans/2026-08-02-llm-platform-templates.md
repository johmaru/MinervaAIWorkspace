# LLM プラットフォームテンプレート実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設定画面に「プラットフォーム」セレクトを追加し、有名な OpenAI 互換プラットフォームを選ぶと `LLM_PROVIDER=openai` と `LLM_BASE_URL` を自動入力する。

**Architecture:** クライアントのみの変更。`src/lib/llmTemplates.ts` に10件の静的定数テンプレートを定義し、`SettingsModal.tsx` のLLM設定タブに常時表示のセレクトを追加する。選択時は既存の `update()` でフォーム値（provider + baseUrl）を更新するだけで、保存は従来どおり POST /api/settings 経由。API・DB・.envスキーマ変更なし。

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Vitest + Testing Library, bun。

## Global Constraints

- 変更はクライアントのみ。API・DB・`.env` スキーマ変更禁止。
- テンプレート定数は仕様 `docs/superpowers/specs/2026-08-02-llm-platform-templates-design.md` の10件を id/name/baseUrl ともそのまま使う（順序・値・id を変更しない）。
- セレクトは LLM 設定タブに**常時表示**（プロバイダが cursor でも）。テンプレート選択時の挙動は `llmProvider="openai"` + `llmBaseUrl=<template.baseUrl>` の2項目のみ。APIキー・モデル・フォールバック等は触らない。
- 現在の `form.llmBaseUrl` とテンプレートの `baseUrl` が完全一致する場合のみそのテンプレートを選択表示。不一致・未入力は `custom`。
- i18n キーは ja/en 両方に追加（`en: typeof ja` の型制約あり。片方だけだと typecheck が落ちる）。
- プラットフォーム名は固有名詞のため翻訳しない。

---

### Task 1: テンプレート定数（`src/lib/llmTemplates.ts`）

**Files:**
- Create: `src/lib/llmTemplates.ts`
- Test: `src/lib/llmTemplates.test.ts`

**Interfaces:**
- Produces: `LLM_PLATFORM_TEMPLATES: readonly { id: string; name: string; baseUrl: string }[]`（10件）、`LlmPlatformId` 型。Task 3 が消費する。

- [ ] **Step 1: Write the failing test**

Create `src/lib/llmTemplates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LLM_PLATFORM_TEMPLATES } from "@/lib/llmTemplates";

describe("LLM_PLATFORM_TEMPLATES", () => {
  it("has unique ids (stable identifiers for the UI select)", () => {
    const ids = LLM_PLATFORM_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique baseUrls (UI matching depends on exact baseUrl match)", () => {
    const urls = LLM_PLATFORM_TEMPLATES.map((t) => t.baseUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/llmTemplates.test.ts`
Expected: FAIL — `Cannot find module "@/lib/llmTemplates"`

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/llmTemplates.ts`:

```ts
/**
 * Well-known OpenAI-compatible LLM platforms for the Settings GUI.
 *
 * Selecting a platform in Settings → LLM auto-fills LLM_PROVIDER=openai and
 * LLM_BASE_URL. The baseUrl must match the platform's OpenAI-compatible
 * chat/completions endpoint exactly — the UI matches on this string.
 *
 * Only OpenAI-compatible endpoints belong here. Anthropic-format
 * (/v1/messages) and Responses-API (/v1/responses) platforms are NOT
 * supported by the openai provider and must stay out.
 */
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/llmTemplates.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/llmTemplates.ts src/lib/llmTemplates.test.ts
git commit -m "feat: add LLM platform template constants"
```

---

### Task 2: i18n キー追加（ja/en）

**Files:**
- Modify: `src/lib/i18n/dictionaries.ts`（ja は `settings.modelIdPlaceholder` 行の直後、en は同キー行の直後）

**Interfaces:**
- Produces: キー `settings.platformTemplate` / `settings.platformTemplateDesc` / `settings.platformTemplateCustom`（ja/en）。Task 3 の `t()` が消費する。

- [ ] **Step 1: Add keys to the ja dictionary**

ja 側の `modelIdPlaceholder: "モデル ID を入力（候補から選択も可）",` の直後に挿入:

```ts
    platformTemplate: "プラットフォーム",
    platformTemplateDesc: "選択するとプロバイダと Base URL を自動設定します（後から手編集可）。",
    platformTemplateCustom: "カスタム（手入力）",
```

- [ ] **Step 2: Add keys to the en dictionary**

en 側の `modelIdPlaceholder: "Enter model ID (or pick a suggestion)",` の直後に挿入:

```ts
    platformTemplate: "Platform",
    platformTemplateDesc: "Selecting one auto-fills the provider and Base URL (editable afterwards).",
    platformTemplateCustom: "Custom (manual entry)",
```

- [ ] **Step 3: Verify parity + types**

Run: `bunx vitest run src/lib/i18n/i18n.test.ts`
Expected: PASS（ja/en のキー構造一致テスト含む）

Run: `bun run typecheck`
Expected: エラーなし

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries.ts
git commit -m "feat: add platform template i18n keys (ja/en)"
```

---

### Task 3: SettingsModal にプラットフォームセレクト追加

**Files:**
- Modify: `src/components/SettingsModal.tsx`（import 追加、`update` 定義の直後にヘルパー2つ、プロバイダ select ブロックの直後 `{(form.llmProvider ?? "openai") === "openai" && (` の直前にセレクト JSX を挿入）
- Test: `src/components/SettingsModal.test.tsx`（末尾に describe ブロック追加）

**Interfaces:**
- Consumes: `LLM_PLATFORM_TEMPLATES`（Task 1）、`settings.platformTemplate*` キー（Task 2）、既存 `update(key, value)` / `form.llmBaseUrl` / `form.llmProvider`
- Produces: 挙動 — テンプレート選択で `form.llmProvider="openai"` + `form.llmBaseUrl=<baseUrl>`。テスト4件。

- [ ] **Step 1: Write the failing tests**

`src/components/SettingsModal.test.tsx` の末尾（最後の `});` の後）に追加:

```ts
describe("SettingsModal — platform templates", () => {
  it("selecting a template fills provider=openai and baseUrl, and Save persists both", async () => {
    const { calls } = mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    const platform = screen.getByRole("combobox", { name: "プラットフォーム" });
    expect(platform).toHaveValue("umans"); // default baseUrl matches UmansAI
    fireEvent.change(platform, { target: { value: "opencode" } });

    expect(screen.getByRole("combobox", { name: "プラットフォーム" })).toHaveValue("opencode");
    expect(screen.getByDisplayValue("https://opencode.ai/zen/go/v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const posts = settingsPostCalls(calls);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(posts[0].init!.body as string);
      expect(body).toMatchObject({
        llmProvider: "openai",
        llmBaseUrl: "https://opencode.ai/zen/go/v1",
      });
    });
  });

  it("switches from cursor provider to openai and reveals the baseUrl field", async () => {
    mockFetch({ settings: { llmProvider: "cursor" } });
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    // Cursor mode: base URL input is hidden
    expect(screen.queryByDisplayValue("https://api.code.umans.ai/v1")).toBeNull();
    expect(screen.getByDisplayValue("Cursor SDK")).toBeInTheDocument();

    const platform = screen.getByRole("combobox", { name: "プラットフォーム" });
    fireEvent.change(platform, { target: { value: "openai" } });

    // Provider switched to OpenAI-compatible; base URL input now visible and filled
    expect(screen.getByDisplayValue("OpenAI 互換")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Cursor SDK")).toBeNull();
    expect(screen.getByDisplayValue("https://api.openai.com/v1")).toBeInTheDocument();
  });

  it("shows the matching template when current baseUrl equals a template", async () => {
    mockFetch({ settings: { llmBaseUrl: "https://openrouter.ai/api/v1" } });
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    expect(screen.getByRole("combobox", { name: "プラットフォーム" })).toHaveValue("openrouter");
  });

  it("custom selection does not change provider or baseUrl", async () => {
    mockFetch();
    renderModal();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled());

    const platform = screen.getByRole("combobox", { name: "プラットフォーム" });
    fireEvent.change(platform, { target: { value: "custom" } });

    expect(platform).toHaveValue("custom");
    expect(screen.getByDisplayValue("https://api.code.umans.ai/v1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("OpenAI 互換")).toBeInTheDocument(); // provider untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/SettingsModal.test.tsx`
Expected: FAIL — 4件とも `Unable to find role="combobox" with name "プラットフォーム"`

- [ ] **Step 3: Write minimal implementation**

**3a. Import** — `src/components/SettingsModal.tsx` の既存 import 群（`ModelCombobox` import の直後）に追加:

```ts
import { LLM_PLATFORM_TEMPLATES } from "@/lib/llmTemplates";
```

**3b. ヘルパー** — 既存 `update` の useCallback 定義（`const update = useCallback(...`, []);`）の直後に追加:

```ts
  /** Template whose baseUrl exactly matches the current form value (or "custom"). */
  const selectedTemplateId =
    LLM_PLATFORM_TEMPLATES.find((t) => t.baseUrl === (form.llmBaseUrl ?? ""))?.id ?? "custom";

  /** Auto-fill provider + base URL from a platform template. "custom" is a no-op. */
  const applyTemplate = (id: string) => {
    if (id === "custom") return;
    const tpl = LLM_PLATFORM_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    update("llmProvider", "openai");
    update("llmBaseUrl", tpl.baseUrl);
  };
```

**3c. JSX** — プロバイダ select の `<div className="sm:col-span-2">...` ブロック（`llmProvider` select を含む）の直後、かつ `{(form.llmProvider ?? "openai") === "openai" && (` の直前に挿入:

```tsx
            <div className="sm:col-span-2">
              <label className="mb-1 block">
                <span className="block text-xs font-medium text-foreground">{t("settings.platformTemplate")}</span>
              </label>
              <select
                aria-label={t("settings.platformTemplate")}
                value={selectedTemplateId}
                onChange={(e) => applyTemplate(e.target.value)}
                className="w-full rounded-xl bg-muted px-2 py-1.5 text-sm transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
              >
                <option value="custom">{t("settings.platformTemplateCustom")}</option>
                {LLM_PLATFORM_TEMPLATES.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">{t("settings.platformTemplateDesc")}</p>
            </div>
```

> ラベルはタイトルのみ（env 変数表示はしない）。テンプレート選択は `llmProvider` + `llmBaseUrl` の2項目に反映されるだけで、対応する単一の env 変数はないため。

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/SettingsModal.test.tsx`
Expected: PASS（既存テスト + 新規4件すべて）

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsModal.tsx src/components/SettingsModal.test.tsx
git commit -m "feat: add platform template selector to LLM settings"
```

---

### Task 4: README 同期（EN/JA）

**Files:**
- Modify: `README.md`（`## LLM Provider` セクション、TTFT フォールバックの箇条書きの直後）
- Modify: `README.ja.md`（`## LLM プロバイダ` セクション、同様）

**Interfaces:** なし（ドキュメントのみ）

- [ ] **Step 1: README.md に追記**

`- Optional **TTFT model fallback**...` の直後に追加:

```markdown
- **Platform templates** — Settings → LLM: pick UmansAI / OpenCode Go / OpenAI / OpenRouter / Groq / DeepSeek / Mistral / xAI / Google Gemini / GitHub Models to auto-fill the provider and base URL (still editable)
```

- [ ] **Step 2: README.ja.md に追記**

`- 任意の **TTFT モデルフォールバック**: ...` の直後に追加:

```markdown
- **プラットフォームテンプレート** — 設定 → LLM: UmansAI / OpenCode Go / OpenAI / OpenRouter / Groq / DeepSeek / Mistral / xAI / Google Gemini / GitHub Models を選ぶとプロバイダと Base URL を自動入力（後から手編集可）
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.ja.md
git commit -m "docs: document LLM platform templates"
```

---

### Task 5: 全体検証

- [ ] **Step 1: Full test suite**

Run: `bun run test`
Expected: ゼロ失敗

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: エラーなし

- [ ] **Step 3: Working tree check**

Run: `git status --short`
Expected: 何も表示されない（全変更がコミット済み）

- [ ] **Step 4: Push**

```bash
git push origin develop
```
