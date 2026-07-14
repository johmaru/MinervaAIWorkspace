Internationalization (i18n) and theming for UmansChat — a custom, lightweight, zero-dependency translation system paired with a CSS-variable–based light/dark theme.

## Relevant source files

| File | Purpose |
|------|---------|
| `src/lib/i18n/types.ts` | `Locale` type, supported-locale list, cookie/localStorage keys |
| `src/lib/i18n/index.ts` | `t()` translation function, `getRequestLocale()`, `Dictionary` type |
| `src/lib/i18n/dictionaries.ts` | `ja` (source of truth) and `en` (type-checked) translation dictionaries — 16 namespaces |
| `src/components/I18nProvider.tsx` | Client-side React context, SSR-safe locale restore, cookie/`<html lang>` sync |
| `src/components/ThemeProvider.tsx` | `next-themes` wrapper for class-based dark mode |
| `src/app/layout.tsx` | Root layout — provider nesting order, font variables |
| `src/app/globals.css` | CSS variables (light/dark), `@theme inline`, utilities, animations, global styles |

---

## i18n Architecture

UmansChat uses a **custom, lightweight, client-side i18n implementation** — no `next-intl`, `react-i18next`, or any external i18n library. The entire system is three small modules under `src/lib/i18n/` plus one React context provider.

Design principles:

- **Zero dependencies.** Translation is a pure function (`t(locale, key, params?)`) over a plain JS object. No runtime bundle, no locale loading, no async.
- **Japanese is the source of truth.** The `ja` dictionary is authored first; `en` is typed as `typeof ja`, so TypeScript guarantees every English key mirrors a Japanese key.
- **SSR-safe.** The server always renders with `DEFAULT_LOCALE`; the client restores the user's choice from `localStorage` after mount (same pattern as `next-themes`).
- **Cookie-synced for server-side reads.** API route handlers can read the locale from a cookie via `getRequestLocale()`.

### Types

Defined in `src/lib/i18n/types.ts`:

```ts
export type Locale = "en" | "ja";

export const SUPPORTED_LOCALES: Locale[] = ["en", "ja"];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE_NAME = "umanschat-locale";

export const LOCALE_STORAGE_KEY = "umanschat-locale";
```

- **`Locale`** — the union of supported locale codes.
- **`SUPPORTED_LOCALES`** — array used for runtime validation (e.g., checking a stored/cookie value is valid).
- **`DEFAULT_LOCALE`** — `"en"`; used during SSR and as the ultimate fallback when a dictionary or key is missing.
- **`LOCALE_COOKIE_NAME`** / **`LOCALE_STORAGE_KEY`** — both set to `"umanschat-locale"`. The provider writes the same value to both `localStorage` (for instant client restore) and a cookie (for server-side `getRequestLocale`).

### Dictionaries

Defined in `src/lib/i18n/dictionaries.ts`. The file header documents the conventions:

```ts
/**
 * i18n dictionaries. `ja` is the source of truth; `en` has the same key
 * structure (type-checked via `en: typeof ja`).
 * Key naming convention: `namespace.camelCase`.
 *
 * Interpolation placeholders use `{name}` format.
 * Replaced via `t(locale, key, { name: value })`.
 */
```

The `ja` object is declared first and fully typed:

```ts
const ja = {
  common: { cancel: "キャンセル", save: "保存", … },
  chat:   { placeholder: "メッセージを入力…", … },
  …
};

const en: typeof ja = {
  common: { cancel: "Cancel", save: "Save", … },
  …
};

export { ja, en };
```

Because `en` is annotated `typeof ja`, TypeScript **enforces structural identity**: every key present in `ja` must exist in `en` with the same shape, and no extra keys are allowed. This makes missing translations a compile-time error.

The `Dictionary` type (exported from `src/lib/i18n/index.ts`) is the shape of the Japanese dictionary:

```ts
export type Dictionary = typeof ja;
```

**Strings that are intentionally NOT translated** (kept out of the dictionaries):

- The brand name `UmansChat`.
- Environment variable names (`LLM_API_KEY`, `LLM_MODEL`, …) and their technical values (`none`/`low`/`medium`/`high`/`max`, `socks5://tor:9050`).
- English API validation error strings (intended for developers, not end users).
- Default titles stored in the database: `"New chat"` / `"New folder"`.

### Namespaces

There are **16 top-level namespaces** in the dictionary. Each maps to a feature area:

| # | Namespace | Purpose |
|---|-----------|---------|
| 1 | `common` | Shared UI labels: cancel, save, delete, error, loading, confirm dialogs |
| 2 | `chat` | Chat window: input, streaming, SSE status labels, branch nav, dual-model, rapid mode |
| 3 | `sidebar` | Sidebar nav: thread list, folder actions, memory scope |
| 4 | `settings` | Settings modal: LLM, web search, Tor, environment, database, connections, global instructions |
| 5 | `threadSettings` | Per-thread config: system prompt, model, response mode, MCP servers |
| 6 | `folderModal` | Folder create/edit: name, instruction, memory scope |
| 7 | `moveModal` | Move-thread-to-folder modal |
| 8 | `search` | Cross-thread semantic search bar |
| 9 | `urlInput` | URL-to-knowledge input |
| 10 | `theme` | Theme toggle labels (light/dark) |
| 11 | `language` | Language switcher labels |
| 12 | `auth` | Login/register forms, OAuth, validation messages |
| 13 | `skills` | Skill manager: active, draft candidates, archived |
| 14 | `memoryViewer` | Memory manager modal: list, filter, edit, delete |
| 15 | `personalization` | Style/tone presets, trait sliders |
| 16 | `help` | Help modal content (including nested Notion connection guide) |

### The `t()` function

Defined in `src/lib/i18n/index.ts`:

```ts
export function t(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
  const parts = key.split(".");
  let value: unknown = dict;
  for (const part of parts) {
    value = (value as Record<string, unknown>)?.[part];
    if (value === undefined) break;
  }
  let str = typeof value === "string" ? value : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}
```

Behavior:

1. **Dictionary selection** — picks `dictionaries[locale]`, falling back to `dictionaries[DEFAULT_LOCALE]` if the locale is somehow missing from the map.
2. **Key traversal** — splits the key on `.` and walks the dictionary object. Keys use `namespace.camelCase` notation (e.g., `"common.save"`, `"chat.mcpActiveCount"`). Nested namespaces (like `help.categories.connections.notion.label`) are traversed the same way.
3. **Fallback** — if the traversal does not resolve to a string, `t()` returns the **key itself** (not an empty string or error). This makes missing-key bugs visible without crashing.
4. **Interpolation** — if `params` is provided, each `{name}` placeholder is replaced globally with `String(value)`. Placeholders use curly braces, e.g. `"referenceCount": "📚 参照元: {count}件"`.

Example usage in a component:

```tsx
const { t } = useI18n();

// Simple lookup
<button>{t("common.save")}</button>

// With interpolation
<span>{t("chat.referenceCount", { count: 3 })}</span>
// → "📚 参照元: 3件" (ja) / "📚 References: 3" (en)

// Deeply nested key
<p>{t("help.categories.connections.notion.step1")}</p>
```

### `getRequestLocale()`

Server-side helper for API route handlers, also in `src/lib/i18n/index.ts`:

```ts
export function getRequestLocale(request: Request): Locale {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${LOCALE_COOKIE_NAME}=([^;]+)`));
  const raw = match?.[1] ?? DEFAULT_LOCALE;
  return SUPPORTED_LOCALES.includes(raw as Locale)
    ? (raw as Locale)
    : DEFAULT_LOCALE;
}
```

This reads the `umanschat-locale` cookie from the incoming request. If the cookie is missing or holds an unsupported value, it falls back to `DEFAULT_LOCALE`. API routes that need to return localized messages (e.g., the settings route returning Tor status strings) use this to pick the right dictionary language.

### I18nProvider

`src/components/I18nProvider.tsx` is a `"use client"` component that provides locale state and the `t()` function via React context.

**Provider nesting** (from `src/app/layout.tsx`):

```tsx
<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
  <MotionConfig reducedMotion="user">
    <I18nProvider>
      {children}
    </I18nProvider>
  </MotionConfig>
</ThemeProvider>
```

**SSR-safe pattern.** The provider initializes locale state to `DEFAULT_LOCALE` (`"en"`):

```tsx
const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
```

During SSR and the first client render, the component renders with `DEFAULT_LOCALE`. This guarantees the server-rendered HTML matches the first client render — **no hydration mismatch**. The `<html lang="en">` attribute in `layout.tsx` is set to match, and `suppressHydrationWarning` is applied to `<html>` as a belt-and-suspenders guard.

**localStorage restore.** On mount (in a `useEffect`, so it only runs client-side), the provider reads `localStorage` and, if a valid supported locale is stored, updates state:

```tsx
useEffect(() => {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored as Locale)) {
      setLocaleState(stored as Locale);
      document.documentElement.lang = stored; // fix <html lang> for screen readers
    }
  } catch {
    // localStorage unavailable (e.g., private mode) — ignore
  }
}, []);
```

Note the `document.documentElement.lang` update: the SSR HTML has `lang="en"`, but if the user's stored locale is `ja`, the `<html lang>` attribute is corrected here to prevent screen readers from mispronouncing Japanese text.

**Cookie sync.** When `setLocale()` is called (user toggles language), it writes to three places atomically:

```tsx
const setLocale = useCallback((next: Locale) => {
  setLocaleState(next);                                  // 1. React state
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);      // 2. localStorage (for next visit)
  } catch { /* ignore */ }
  document.cookie = `${LOCALE_COOKIE_NAME}=${next}; path=/; max-age=31536000; samesite=lax`; // 3. cookie (for server)
  document.documentElement.lang = next;                  // 4. <html lang> (for a11y)
}, []);
```

- **React state** — triggers re-render with new translations.
- **localStorage** — restores instantly on the next page load (before any network).
- **Cookie** (`max-age=31536000` = 1 year) — lets API route handlers read the locale via `getRequestLocale()`.
- **`<html lang>`** — keeps the document language attribute in sync for accessibility.

The `t` function from context is memoized on `locale`:

```tsx
const t = useCallback(
  (key: string, params?: Record<string, string | number>) =>
    tFunction(locale, key, params),
  [locale],
);
```

**Consuming the context:**

```tsx
import { useI18n } from "@/components/I18nProvider";

function MyComponent() {
  const { locale, setLocale, t } = useI18n();
  // ...
}
```

`useI18n()` throws if called outside an `I18nProvider`, catching wiring mistakes early.

---

## How to add a translation

Adding a new user-facing string is a **three-step** process. Because `en: typeof ja`, the TypeScript compiler will error if you add a key to `ja` but forget `en` (or vice versa).

### Step 1 — Add the key to the `ja` dictionary

Open `src/lib/i18n/dictionaries.ts` and add the key to the appropriate namespace in the `ja` object, using `namespace.camelCase` naming:

```ts
const ja = {
  common: {
    // …existing keys…
    exportThread: "スレッドをエクスポート",
  },
  // …
};
```

If the string needs interpolation, use `{param}` placeholders:

```ts
shareCount: "{count}人と共有中",
```

### Step 2 — Add the matching key to the `en` dictionary

Add the **same key** to the `en` object in the same namespace:

```ts
const en: typeof ja = {
  common: {
    // …existing keys…
    exportThread: "Export thread",
    shareCount: "Sharing with {count} people",
  },
  // …
};
```

The `: typeof ja` annotation guarantees this — if the key shape or interpolation placeholder name differs, TypeScript flags it at compile time.

### Step 3 — Use it in a component

```tsx
import { useI18n } from "@/components/I18nProvider";

export function ExportButton() {
  const { t } = useI18n();
  return <button onClick={handleExport}>{t("common.exportThread")}</button>;
}
```

> **Key naming convention:** use `namespace.camelCase`. Pick the namespace that matches the feature area (see the [Namespaces table](#namespaces)). If a string is used across many unrelated components, put it in `common`.

---

## Theming

UmansChat uses [`next-themes`](https://github.com/pacocoursey/next-themes) for dark/light mode toggling, with all visual tokens defined as CSS custom properties.

### next-themes setup

`src/components/ThemeProvider.tsx` wraps `next-themes` with the project's configuration:

```tsx
"use client";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
```

In `src/app/layout.tsx`, it is configured with:

```tsx
<ThemeProvider
  attribute="class"           // toggles by adding/removing .dark on <html>
  defaultTheme="system"      // respects OS preference on first visit
  enableSystem               // reads prefers-color-scheme
  disableTransitionOnChange  // no color-transition animation on theme switch
>
```

- **`attribute="class"`** — `next-themes` adds or removes the `dark` class on the `<html>` element. This integrates with Tailwind v4's class-based dark mode (see `@custom-variant` below).
- **`suppressHydrationWarning`** is set on `<html>` in the layout because `next-themes` injects an inline script that sets the theme class before hydration — the server-rendered HTML intentionally differs, and this attribute silences the resulting React warning.

### Tailwind v4 dark mode variant

In `globals.css`, dark mode is enabled for Tailwind v4 via a custom variant:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

This tells Tailwind that `dark:` utilities should apply when the element (or any ancestor) has the `.dark` class — which is exactly what `next-themes` toggles on `<html>`.

### CSS variables — light and dark tokens

All colors and design tokens are defined as CSS custom properties in `:root` (light) and `.dark` (dark) blocks in `src/app/globals.css`. Components reference these through Tailwind utilities (e.g., `bg-background`, `text-foreground`) or directly via `var(--token)`.

| Token | Light value | Dark value | Purpose |
|-------|-------------|------------|---------|
| `--background` | `#f7f7f8` | `#08090c` | App background |
| `--foreground` | `#0c0c0f` | `#e6e7eb` | Default text |
| `--muted` | `#ededf0` | `#14151a` | Muted backgrounds (e.g., code blocks in light) |
| `--muted-foreground` | `#5a5a66` | `#8a8b95` | Secondary text |
| `--border` | `rgba(12,12,15,0.08)` | `rgba(255,255,255,0.06)` | Borders, dividers |
| `--accent` | `#4b5563` | `#9ca3af` | Accent color |
| `--accent-foreground` | `#ffffff` | `#08090c` | Text on accent |
| `--focus-ring` | `#4b5563` | `#9ca3af` | Focus outline color |
| `--glass-bg` | `rgba(255,255,255,0.72)` | `rgba(20,21,26,0.72)` | Glassmorphism card background |
| `--glass-border` | `rgba(12,12,15,0.06)` | `rgba(255,255,255,0.05)` | Glassmorphism card border |
| `--glow` | `rgba(75,85,99,0.10)` | `rgba(156,163,175,0.12)` | Soft glow effect |
| `--card` | `#ffffff` | `#14151a` | Card background |
| `--card-foreground` | `#0c0c0f` | `#e6e7eb` | Text on cards |
| `--popover` | `#ffffff` | `#14151a` | Popover background |
| `--popover-foreground` | `#0c0c0f` | `#e6e7eb` | Text in popovers |
| `--primary` | `#4b5563` | `#9ca3af` | Primary action color |
| `--primary-foreground` | `#ffffff` | `#08090c` | Text on primary |
| `--secondary` | `#ededf0` | `#14151a` | Secondary button background |
| `--secondary-foreground` | `#0c0c0f` | `#e6e7eb` | Text on secondary |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | Destructive/danger actions |
| `--input` | `rgba(12,12,15,0.06)` | `rgba(255,255,255,0.06)` | Input field backgrounds |
| `--ring` | `#4b5563` | `#9ca3af` | Focus ring (shadcn) |
| `--radius` | `0.625rem` | `0.625rem` | Base border radius |
| `--sidebar` | `#f2f2f4` | `#0d0e12` | Sidebar background |
| `--sidebar-foreground` | `#0c0c0f` | `#e6e7eb` | Sidebar text |
| `--sidebar-primary` | `#4b5563` | `#9ca3af` | Sidebar primary accent |
| `--sidebar-primary-foreground` | `#ffffff` | `#08090c` | Text on sidebar primary |
| `--sidebar-accent` | `#ededf0` | `#14151a` | Sidebar hover/active background |
| `--sidebar-accent-foreground` | `#0c0c0f` | `#e6e7eb` | Text on sidebar accent |
| `--sidebar-border` | `rgba(12,12,15,0.08)` | `rgba(255,255,255,0.06)` | Sidebar borders |
| `--sidebar-ring` | `#4b5563` | `#9ca3af` | Sidebar focus ring |
| `--chart-1` … `--chart-5` | oklch grays (0.87 → 0.269) | same | Chart palette (grayscale) |

### `@theme inline`

The `@theme inline` block bridges CSS variables into Tailwind v4's theme system, generating utility classes (`bg-background`, `text-foreground`, `border-border`, etc.):

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  /* …all color tokens… */
  --color-glass-bg: var(--glass-bg);
  --color-glass-border: var(--glass-border);
  --color-glow: var(--glow);
  /* fonts */
  --font-sans: var(--font-sans);
  --font-mono: var(--font-geist-mono);
  --font-heading: var(--font-sans);
  /* radii (derived from --radius) */
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}
```

Using `inline` means Tailwind does **not** emit the variable definitions themselves (they're already in `:root` / `.dark`); it only creates the utility-class mappings. This lets a single `var(--background)` flip between light and dark via the `.dark` class override.

The radius scale is derived from `--radius` (`0.625rem`), producing a consistent set of corner-roundness utilities from `rounded-sm` through `rounded-4xl`.

### Glass-card utility

A frosted-glass effect for cards and message bubbles:

```css
.glass-card {
  box-shadow:
    inset 0 1px 0 0 rgba(255, 255, 255, 0.02),
    0 4px 24px -8px rgba(0, 0, 0, 0.4);
}
.dark .glass-card {
  box-shadow:
    inset 0 1px 0 0 rgba(255, 255, 255, 0.03),
    0 4px 24px -8px rgba(0, 0, 0, 0.5);
}
```

The `inset` top highlight simulates a subtle light reflection on the top edge; the outer shadow provides depth. Dark mode increases both slightly for visibility against the darker background.

### Aurora background

A slow-drifting, multi-color aurora effect rendered behind all content via `body::before`:

```css
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image:
    radial-gradient(ellipse 60% 50% at 10% 10%, rgba(34, 211, 238, 0.07), transparent 60%),
    radial-gradient(ellipse 55% 45% at 90% 15%, rgba(232, 121, 249, 0.06), transparent 60%),
    radial-gradient(ellipse 65% 55% at 50% 95%, rgba(251, 191, 36, 0.05), transparent 60%);
  background-size: 180% 180%, 160% 160%, 200% 200%;
  background-repeat: no-repeat;
}
```

Three radial gradients (cyan, magenta, amber) positioned at different corners create a soft, ambient glow. Using a `::before` pseudo-element with `z-index: -1` and `pointer-events: none` means the effect **never triggers content repaints** — it lives on its own layer.

Dark mode boosts the alpha values for visibility:

```css
.dark body::before {
  background-image:
    radial-gradient(ellipse 60% 50% at 10% 10%, rgba(34, 211, 238, 0.10), transparent 60%),
    radial-gradient(ellipse 55% 45% at 90% 15%, rgba(232, 121, 249, 0.09), transparent 60%),
    radial-gradient(ellipse 65% 55% at 50% 95%, rgba(251, 191, 36, 0.08), transparent 60%);
}
```

---

## Other global styles

All in `src/app/globals.css`.

### Thin scrollbars

A minimal, slim scrollbar across the entire app:

```css
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
```

`scrollbar-width: thin` is the standard CSS property (Firefox and Chromium 121+); `scrollbar-color` sets the thumb to the border token and the track to transparent.

### Focus-visible ring (accessibility)

Keyboard focus gets a visible ring; mouse clicks suppress it:

```css
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 2px;
}

:focus:not(:focus-visible) {
  outline: none;
}
```

This ensures keyboard navigators see a clear focus indicator while mouse users don't get a lingering outline after clicking.

### Markdown body

Markdown content rendering adjustments:

```css
.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child  { margin-bottom: 0; }

/* Tables: horizontal scroll, allow cell wrapping */
.markdown-body table {
  display: block;
  overflow-x: auto;
  white-space: normal;
}

/* Mobile: smaller font */
@media (max-width: 640px) {
  .markdown-body { font-size: 0.875rem; }
}
```

### highlight.js

The `github-dark` theme is imported globally (in `layout.tsx`). In light mode, its dark background is overridden to match the muted token:

```css
:not(.dark) .hljs {
  background: var(--muted);
  color: var(--foreground);
}

.dark .hljs {
  border: 1px solid var(--border);
  border-radius: 4px;
}
```

### KaTeX

Math rendering color is synced to the foreground token in dark mode (KaTeX defaults to black text, which is invisible on dark backgrounds):

```css
.dark .katex {
  color: var(--foreground);
}
```

### Base layer

A Tailwind `@layer base` block sets up default border and text colors:

```css
@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
```

---

## Animation keyframes

Three keyframe animations defined in `globals.css`:

| Keyframe | Animation | Used for |
|----------|-----------|----------|
| `msg-in` | `opacity: 0 → 1`, `translateY(8px) → 0` | New chat message appearance |
| `modal-in` | `opacity: 0 → 1`, `scale(0.96) → 1` | Modal dialog entrance |
| `blink` | `opacity: 1 → 0.2 → 1` (50% midpoint) | Streaming/loading cursor blink |

```css
@keyframes msg-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes modal-in {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.2; }
}
```

These are consumed by utility classes and motion components (see [Frontend Components](./frontend.md)).

---

## See also

- [Frontend Components](./frontend.md) — component catalog, server/client boundaries, UI primitives
- [Hooks & State](./hooks.md) — `useChat`, `useThreads`, `useFolders` state management
- [Settings & Environment](./settings-env.md) — `.env` configuration and runtime settings GUI
- [Architecture Overview](./architecture.md) — high-level system architecture
