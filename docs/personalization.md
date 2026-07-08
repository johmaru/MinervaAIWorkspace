Personalization system — per-user style presets and trait sliders that shape the assistant's tone, injected as a system message into every chat completion.

**Relevant source files:**
- `src/lib/personalization.ts` — style/trait constants, `buildPersonalizationMessage()`
- `src/app/api/chat/route.ts` — injection point (`buildFinalMessages`)
- `src/app/api/settings/route.ts` — save/validation endpoint
- `src/db/schema.ts` — `users` table columns

## Overview

Personalization lets each user choose a **style preset** (e.g. casual, academic) and adjust four **trait sliders** (warmth, energy, structure, emoji). When enabled, these choices are compiled into a single Japanese-language system message and inserted into the LLM message array ahead of the main system prompt. The message ends with a precedence directive instructing the model to honor the personalization even when other instructions conflict.

The feature is **disabled by default**. A user has personalization active only when their `personalStyle` column is non-null; when it is `null`, `buildPersonalizationMessage()` returns `null` and no message is injected.

## Style presets

Eight presets are defined in `PERSONAL_STYLES` (`personalization.ts:16-25`). Each maps to a Japanese instruction string in `STYLE_DESCRIPTIONS` (`personalization.ts:27-36`).

| Style | Description |
|-------|-------------|
| `standard` | Balanced everyday conversational style |
| `polite` | Polite honorifics, suitable for formal settings |
| `casual` | Casual, friendly tone |
| `concise` | Short, points-only style |
| `detailed` | Thorough, detailed explanations |
| `academic` | Academic tone, objective, citation-focused |
| `creative` | Narrative, expressive style |
| `technical` | Engineer-oriented, code-focused |

The `PersonalStyle` type is the union of these eight string literals. Any value not in this set is treated as invalid and causes `buildPersonalizationMessage()` to return `null` (feature disabled).

## Trait sliders

Four traits, each with three levels indexed `0`, `1` (default), and `2`. The level arrays live at `personalization.ts:38-60`.

| Trait | Level 0 | Level 1 (default) | Level 2 |
|-------|---------|-------------------|---------|
| **Warmth** | Fact-based, no emotion | Standard warmth | Empathetic, personally attentive |
| **Energy** | Calm, low | Standard | High energy, active |
| **Structure** | No headings/lists, natural prose | Moderate use of headings/lists | Actively structured with headings/lists |
| **Emoji** | None | Sparse | Frequent |

Trait values are integers clamped to the range `[0, 2]`. Out-of-range values are clamped both at save time (settings API) and at build time (`buildPersonalizationMessage`), so a stored `99` or `-5` never reaches the model.

## buildPersonalizationMessage()

```typescript
export function buildPersonalizationMessage(
  style: string | null,
  warmth: number,
  energy: number,
  structure: number,
  emoji: number,
): string | null
```

**Source:** `src/lib/personalization.ts:69-102`

### Behavior

1. **Disabled check.** If `style` is falsy or not a member of `PERSONAL_STYLES`, the function returns `null` immediately. A `null` return means "do not inject any message" — the feature is off for this user.
2. **Clamp traits.** Each of `warmth`, `energy`, `structure`, `emoji` is clamped to `[0, 2]` via `Math.max(0, Math.min(2, v))`. This is a defensive second clamp; the settings API already clamps on save.
3. **Assemble the message.** The returned string is a Markdown-formatted, Japanese-language system message with this structure:

```
## パーソナライズ設定

### スタイル・トーン
<style description>

### トレイト
- 温かみ: <warmth level description>
- 熱量: <energy level description>
- 見出しとリスト: <structure level description>
- 絵文字: <emoji level description>

<precedence directive>
```

4. **Precedence directive.** The message closes with `PRECEDENCE_DIRECTIVE` (`personalization.ts:62-63`):

> 以下のスタイル・トーン設定は、他のシステム指示やユーザー指示に競合する場合でも優先して適用してください。
>
> *(Apply the following style/tone settings with priority, even when they conflict with other system or user instructions.)*

This directive is appended unconditionally whenever the message is built — it is the last line the model reads from the personalization block, reinforcing that personalization wins over conflicting downstream instructions.

### Disabled = no injection

The single rule: **`personalStyle === null` ⇒ `buildPersonalizationMessage` returns `null` ⇒ no system message is added.** There is no "empty" or default personalization message; the feature is either on (non-null style) or off (null style).

## User table fields

Personalization state lives on the `users` table (`src/db/schema.ts:43-48`):

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `personalStyle` | `text` (nullable) | `null` | Style preset key, or `null` when disabled |
| `personalWarmth` | `integer` | `1` | Warmth slider level (0–2) |
| `personalEnergy` | `integer` | `1` | Energy slider level (0–2) |
| `personalStructure` | `integer` | `1` | Structure slider level (0–2) |
| `personalEmoji` | `integer` | `1` | Emoji slider level (0–2) |

Because `personalStyle` defaults to `null`, every new user starts with personalization **off**. The trait columns default to `1` (the middle level) so that, the moment a user picks a style, they get sensible mid-range traits without having to touch every slider.

## Injection point

The personalization message is injected in `buildFinalMessages()` (`src/app/api/chat/route.ts:838-870`). The function assembles the full LLM message array; the personalization block is placed at **position [1]**, immediately after the environment-context system message and **before** the main system prompt.

The assembled order is:

| Index | Role | Content | Source |
|-------|------|---------|--------|
| `[0]` | `system` | Environment context (date/time, host OS) | `getEnvContext()` |
| `[1]` | `system` | **Personalization message** (only when non-null) | `buildPersonalizationMessage()` |
| `[2]` | `system` | Main system prompt (custom instructions) | `systemContent` |
| `[3]` | `system` | Active skills context | `skillMessage` |
| `[4]` | `system` | Relevant memories (RAG) | `memoryMessage` |
| `[5…n]` | `user`/`assistant` | Conversation history | `history` |
| next | `system` | Search results context (when web search ran) | `searchContextMessage` |
| next | `system` | Scraped URL context (when present) | `urlContextMessage` |
| last | `user` | Current user message | `content` |

Each system block is conditionally spread — it appears only when its content is non-null. The relevant lines (`route.ts:857-869`):

```typescript
return [
  { role: "system" as const, content: getEnvContext() },
  ...(personalizationContent ? [{ role: "system" as const, content: personalizationContent }] : []),
  ...(systemContent ? [{ role: "system" as const, content: systemContent }] : []),
  ...(skillMessage ? [skillMessage] : []),
  ...(memoryMessage ? [memoryMessage] : []),
  ...history.map(/* ... */),
  ...(searchContextMessage ? [searchContextMessage] : []),
  ...(urlContextMessage ? [urlContextMessage] : []),
  { role: "user" as const, content },
];
```

Placing personalization ahead of the main system prompt — combined with the precedence directive — gives it priority over any conflicting instruction the system prompt might carry.

The `personalizationContent` value itself is built earlier in the request (`route.ts:157-164`), reading the user's row from the `users` table with safe `?? null` / `?? 1` fallbacks:

```typescript
const personalizationContent = buildPersonalizationMessage(
  userRow?.personalStyle ?? null,
  userRow?.personalWarmth ?? 1,
  userRow?.personalEnergy ?? 1,
  userRow?.personalStructure ?? 1,
  userRow?.personalEmoji ?? 1,
);
```

## Settings API

Personalization is saved through `POST /api/settings` (`src/app/api/settings/route.ts`). The endpoint accepts a partial body and updates only the fields present.

### Request body fields

| Field | Type | Notes |
|-------|------|-------|
| `personalStyle` | `string \| null` | Must be one of the 8 presets, or `null` to disable |
| `personalWarmth` | `number` | Clamped to `[0, 2]` |
| `personalEnergy` | `number` | Clamped to `[0, 2]` |
| `personalStructure` | `number` | Clamped to `[0, 2]` |
| `personalEmoji` | `number` | Clamped to `[0, 2]` |

All fields are optional; only provided fields are written.

### Validation

- **`personalStyle`** (`route.ts:234-240`): If the value is present and non-null, it is checked against `PERSONAL_STYLES`. An unrecognized value returns `400` with `"personalStyle must be one of the valid presets or null"`. Passing `null` is valid and explicitly disables the feature.
- **Trait clamping** (`route.ts:241-246`): Each trait runs through:
  ```typescript
  const clampTrait = (v: number | undefined) =>
    v === undefined ? undefined : Math.max(0, Math.min(2, Math.trunc(v)));
  ```
  This clamps to `[0, 2]` **and** truncates to an integer, so `1.9` becomes `1` and `99` becomes `2`. `undefined` is left as `undefined` (field not updated).

### Persistence

When any personalization field is present (`route.ts:301-319`), a single `UPDATE users SET (...) WHERE id = ?` runs against the authenticated user's row. Fields not provided are omitted from the `SET` clause, so partial updates are safe — sending only `personalStyle` leaves the trait columns untouched.

The GET endpoint (`GET /api/settings`) returns the current personalization state with the same `?? null` / `?? 1` fallbacks, so a user with no row or null style sees `personalStyle: null` and all traits at `1`.

## How to add a new style preset

1. **Extend the type and list** in `src/lib/personalization.ts`:
   ```typescript
   export type PersonalStyle =
     | "standard"
     // ...
     | "technical"
     | "friendly"; // ← add the new literal

   export const PERSONAL_STYLES: PersonalStyle[] = [
     "standard",
     // ...
     "technical",
     "friendly", // ← add to the array
   ];
   ```
2. **Add the description string** in `STYLE_DESCRIPTIONS`:
   ```typescript
   const STYLE_DESCRIPTIONS: Record<PersonalStyle, string> = {
     // ...
     friendly: "親しみやすくフレンドリーな表現で応答してください。",
   };
   ```
3. **No schema migration needed.** `personalStyle` is a free-form `text` column, so new presets require no DDL. The settings API validation (`PERSONAL_STYLES.includes(...)`) picks up the new value automatically because it imports the same array.

## How to add a new trait slider

1. **Add the level array** in `src/lib/personalization.ts` (three entries, levels 0/1/2):
   ```typescript
   const FORMALITY_LEVELS = [
     "カジュアルな表現で応答してください。",
     "標準的なフォーマルさで応答してください。",
     "非常にフォーマルな表現で応答してください。",
   ];
   ```
2. **Add the parameter and line in `buildPersonalizationMessage()`**:
   ```typescript
   export function buildPersonalizationMessage(
     style: string | null,
     warmth: number,
     energy: number,
     structure: number,
     emoji: number,
     formality: number, // ← new parameter
   ): string | null {
     // ...
     const f = clamp(formality);
     const lines: string[] = [
       // ...
       `- フォーマルさ: ${FORMALITY_LEVELS[f]}`, // ← new line under トレイト
       // ...
     ];
   }
   ```
3. **Add the column** in `src/db/schema.ts`:
   ```typescript
   personalFormality: integer("personal_formality").notNull().default(1),
   ```
   This is a schema change — regenerate/apply the migration as the project's Drizzle workflow requires.
4. **Wire the settings API** in `src/app/api/settings/route.ts`:
   - Add `personalFormality?: number` to the body type.
   - Clamp it: `const clampedFormality = clampTrait(body.personalFormality);`
   - Include it in the `UPDATE users SET (...)` clause.
   - Return it from `GET /api/settings` with `?? 1` default.
5. **Update the chat route** call site (`route.ts:158-164`) to pass `userRow?.personalFormality ?? 1` into `buildPersonalizationMessage`.

## See also

- [Chat & Streaming](./chat-streaming.md) — full message assembly and SSE streaming flow
- [Settings & Environment](./settings-env.md) — `.env` settings, embedding config, and the settings API
