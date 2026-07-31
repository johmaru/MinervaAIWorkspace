# Frontend Components

MinervaAIWorkspace frontend: component catalog, server/client boundaries, UI primitives, markdown rendering, and key architectural patterns. Built with Next.js 16 App Router, React 19, Tailwind CSS v4, and Motion (Framer Motion).

## Relevant source files

```
src/app/layout.tsx              — root layout (Server Component)
src/app/page.tsx                — main page (Server Component)
src/app/login/page.tsx          — login page (Server Component)
src/app/globals.css             — CSS variables, light/dark themes, utilities
src/components/                 — all React components
src/components/ui/motion.tsx    — shared motion primitives
src/components/I18nProvider.tsx — i18n context provider
src/components/ThemeProvider.tsx — next-themes wrapper
src/components/AuthProvider.tsx  — auth context provider
src/lib/clientFetch.ts          — client fetch wrapper
src/hooks/useChat.ts            — chat state + SSE streaming
src/hooks/useThreads.ts         — thread list CRUD
src/hooks/useFolders.ts         — folder list CRUD
```

## App Structure

### Root Layout

`src/app/layout.tsx` is a **Server Component**. It loads Google Fonts (Geist Sans, Geist Mono), imports global CSS (`globals.css`), highlight.js theme (`github-dark.css`), and KaTeX styles. It wraps the application in three nested providers:

```
ThemeProvider (next-themes, attribute="class")
  └─ MotionConfig (reducedMotion="user")
       └─ I18nProvider (client-side locale)
            └─ {children}
```

```tsx
<html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
  <body className="min-h-full flex flex-col bg-background text-foreground">
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user">
        <I18nProvider>
          {children}
        </I18nProvider>
      </MotionConfig>
    </ThemeProvider>
  </body>
</html>
```

### Pages

| Route | File | Type | Description |
|-------|------|------|-------------|
| `/` | `src/app/page.tsx` | Server Component | Renders `<ChatShell />` — the main application shell |
| `/login` | `src/app/login/page.tsx` | Server Component | First-run detection (0 users → register mode), renders `<LoginForm>` |

The login page calls `auth()` server-side and redirects to `/` if already authenticated. It checks the user count via `db.$count(users)` to determine first-run, and passes `googleEnabled` based on env vars.

### Server / Client Component Boundaries

| Component | Boundary | Rationale |
|-----------|----------|-----------|
| `RootLayout` (`layout.tsx`) | **Server** | Fonts, metadata, CSS imports — all server-only |
| `Home` (`page.tsx`) | **Server** | Thin wrapper that renders `<ChatShell />` |
| `LoginPage` (`login/page.tsx`) | **Server** | Calls `auth()`, queries DB for user count, redirects |
| `ChatShell` | **Client** (`"use client"`) | Stateful: activeThreadId, sidebar, modals, localStorage |
| `ChatWindow` | **Client** (`"use client"`) | Stateful: useChat hook, input, streaming |
| `Sidebar` | **Client** (`"use client"`) | Stateful: search, context menus, folder/thread interactions |
| All other components | **Client** (`"use client"`) | Interactive: state, effects, event handlers, motion |
| `AuthProvider` | **Client** (`"use client"`) | Context provider; receives user from Server Component |
| `ThemeProvider` | **Client** (`"use client"`) | next-themes wrapper |
| `I18nProvider` | **Client** (`"use client"`) | Context provider, localStorage for locale |

All components in `src/components/` are client components (`"use client"`). Server Components are only the App Router pages and layout. The boundary is clean: Server Components handle data fetching and redirects; Client Components handle all interactivity.

## Component Catalog

### Application Shell & Chat

| Component | File | Description |
|-----------|------|-------------|
| `ChatShell` | `src/components/ChatShell.tsx` | Top-level shell. Manages `activeThreadId` (persisted to localStorage). Orchestrates Sidebar + ChatWindow + modals (FolderSettingsModal, HelpModal). Mobile sidebar overlay with backdrop. |
| `ChatWindow` | `src/components/ChatWindow.tsx` | Main conversation view. Memoized. Uses `useChat(threadId)`. Renders message list, input area with attachment/MCP/connection menu, rapid toggle (⚡), time range selector. Auto-scroll only when near bottom. IME composition-safe Enter handling. |
| `MessageBubble` | `src/components/ChatWindow.tsx:524` | Single message with role styling. Assistant messages: thinking blocks, markdown rendering, dual trace, source references, regenerate button. User messages: inline edit, attachments, branch nav. |
| `DualTraceDetails` | `src/components/ChatWindow.tsx:706` | Accordion showing dual-model trace. Renders both model answers, reviews (cross_review strategy) or debate turns (debate strategy). |
| `BranchNav` | `src/components/ChatWindow.tsx:753` | Branch navigation `< 2/3 >` with prev/next buttons. Disabled at bounds. |
| `ThinkingBlock` | `src/components/ChatWindow.tsx:479` | Collapsible accordion for LLM reasoning/thinking content. |
| `EmptyState` | `src/components/ChatWindow.tsx:459` | Empty thread placeholder. |
| `NoThreadState` | `src/components/ChatWindow.tsx:469` | No thread selected placeholder. |
| `TraceSection` | `src/components/ChatWindow.tsx:742` | Sub-section within DualTraceDetails — renders a single model's answer/review/debate turn. |

### Sidebar & Thread/Folder Management

| Component | File | Description |
|-----------|------|-------------|
| `Sidebar` | `src/components/Sidebar.tsx` | Left navigation panel (memoized). Renders SearchBar, UrlInput, folder list, thread list. Right-click context menu (ContextMenu) for threads and folders. Hosts SettingsModal, MemoryViewerModal, SkillManagerModal triggers. |
| `ThreadSettings` | `src/components/ThreadSettings.tsx` | Collapsible thread config panel. System prompt editing, model selector (fetches from GET `/api/models`), response mode (single/dual), dual model A/B selectors, dual strategy, debate rounds, global instruction selector. |
| `FolderSettingsModal` | `src/components/FolderSettingsModal.tsx` | Folder create/edit modal. Fields: name, instruction, memoryScope (`folder` or `global`). Dual-mode: `folder=null` → create new; `folder=FolderSummary` → edit existing. |
| `MoveToFolderModal` | `src/components/MoveToFolderModal.tsx` | Move thread to folder modal. Radio button list of folders + "No folder" option. Resets selection on open. Esc to close. |

### Settings & Admin

| Component | File | Description |
|-----------|------|-------------|
| `SettingsModal` | `src/components/SettingsModal.tsx` | Application settings modal. 6 vertical tabs with left rail navigation: 🤖 AI・モデル, 🔍 検索・ネット, 🖥️ システム, 🔗 コネクション, 🌐 公開・セキュリティ, 🎨 パーソナライズ. Manages LLM config, embeddings (with migration confirmation), web search, Tor, database, Notion OAuth, Cloudflare Tunnel, global instructions, and personalization. |
| `MemoryViewerModal` | `src/components/MemoryViewerModal.tsx` | Memories table viewer/editor. List with search and filter (all/fact/working). Inline edit (PATCH), soft-delete (DELETE), add new (POST). Targets only `memories` table (not `page_embeddings`). |
| `SkillManagerModal` | `src/components/SkillManagerModal.tsx` | Skills management UI. 3 tabs: Active Skills, Draft Candidates, Archived. CRUD for skills table + skill_candidates approval pipeline. |
| `HelpModal` | `src/components/HelpModal.tsx` | Help modal with left nav + right content layout. Currently covers Notion connections help. |

#### SettingsModal Tabs

| Index | Icon | Tab Key | Content |
|-------|------|---------|---------|
| 0 | 🤖 | `settings.tabAiModels` | LLM base URL, API key, model, models list, thinking effort. Embedding model with dimension migration. |
| 1 | 🔍 | `settings.tabSearchNetwork` | Web search model, max results/rounds, scraper URL, SearXNG URL, Tor proxy, scrape proxy. |
| 2 | 🖥️ | `settings.tabSystem` | Runtime environment: database URL, host OS, timezone. Tor status + connection check. |
| 3 | 🔗 | `settings.tabConnections` | Notion OAuth credentials + connections list + authorize. |
| 4 | 🌐 | `settings.tabServerAccess` | Public base URL (AUTH_URL), Cloudflare Tunnel (start/stop + token), security (registration lock + allowed IPs). |
| 5 | 🎨 | `personalization.title` | Style presets, trait sliders (warmth, energy, structure, emoji). |

### Auth & Toggles

| Component | File | Description |
|-----------|------|-------------|
| `LoginForm` | `src/components/LoginForm.tsx` | Login/register form. Uses `useActionState` for server action `authenticate`. Toggle between login/register modes. Password mismatch validation. Google OAuth button (when enabled). First-run banner. |
| `AuthProvider` | `src/components/AuthProvider.tsx` | Context provider for authenticated user. Receives `SessionUser` from Server Component, exposes via `useUser()` hook. |
| `ThemeProvider` | `src/components/ThemeProvider.tsx` | Thin wrapper around `next-themes` `ThemeProvider`. Uses `attribute="class"` for Tailwind v4 `.dark` support. |
| `ThemeToggle` | `src/components/ThemeToggle.tsx` | Dark mode toggle button. Uses `next-themes` `resolvedTheme`. Renders empty placeholder before mount to avoid hydration mismatch. Sun/Moon SVG icons. |
| `LanguageToggle` | `src/components/LanguageToggle.tsx` | Language toggle button (EN ⇄ JA). Renders empty placeholder before mount. Uses `useI18n()` from I18nProvider. |
| `I18nProvider` | `src/components/I18nProvider.tsx` | Client-side i18n context provider. Persists locale to localStorage, syncs cookie and `<html lang>`. Exposes `locale`, `setLocale`, and `t(key, params?)` via `useI18n()` hook. |

### UI Primitives

All UI primitives live in `src/components/ui/motion.tsx` (except ContextMenu).

| Component | File | Description |
|-----------|------|-------------|
| `MotionButton` | `src/components/ui/motion.tsx:60` | `<motion.button>` with `whileTap`/`whileHover` scale baked in. Drop-in for plain `<button>`. Disabled buttons never animate (motion skips `while*` when disabled). Forwards all standard button props. |
| `AnimateModal` | `src/components/ui/motion.tsx:90` | Animated modal shell. `AnimatePresence` + overlay (fade) + panel (fade-scale). Handles mount/unmount exit animation, click-outside-to-close. Renders `null` when closed. Configurable `panelClassName` and `ariaLabel`. |
| `Accordion` | `src/components/ui/motion.tsx:151` | Controlled accordion replacing native `<details>/<summary>`. Height animation via `AnimatePresence`. Chevron rotation handled by caller. Supports `defaultOpen` and controlled `open`/`onToggle`. |
| `ContextMenu` | `src/components/ContextMenu.tsx` | Right-click context menu rendered via `createPortal` to `document.body`. Clamps at viewport edges. Closes on click-outside, Esc, or scroll. Desktop only (no mobile long-press). Supports item and separator types. |

#### Shared Animation Variants

`src/components/ui/motion.tsx` exports reusable variant objects:

| Variant | Description |
|---------|-------------|
| `fadeScaleIn` | Modals/panels: fade + scale |
| `fadeSlideUp` | Message bubbles/list rows: slide up + fade |
| `overlayFade` | Modal backdrops/overlays: fade only |
| `accordionCollapse` | Accordion collapse: height + opacity |
| `easeOut` | Standard ease-out timing (0.2s) |
| `easeOutLong` | Longer ease-out timing (0.3s) |

### Feature Components

| Component | File | Description |
|-----------|------|-------------|
| `Markdown` | `src/components/Markdown.tsx` | LLM response markdown renderer. Memoized. See [Markdown Rendering](#markdown-rendering). |
| `SearchBar` | `src/components/SearchBar.tsx` | Cross-thread semantic search. Debounced input → POST `/api/search`. Displays memory results + page embedding results. AbortController for stale requests. Click result to navigate to thread. |
| `UrlInput` | `src/components/UrlInput.tsx` | URL import input. POST `/api/scrape` on Enter. Scrapes page and persists as permanent knowledge. Status states: idle/loading/done/error. |
| `AttachmentBar` | `src/components/AttachmentBar.tsx` | Attachment list display. Images: thumbnail. Text/PDF: file icon + filename. Optional remove button (for pending attachments before sending). |
| `McpPanel` | `src/components/McpPanel.tsx` | MCP server management panel. Server list with checkboxes (per-thread enable/disable) + server registration form (HTTP/stdio transport). Fetches from GET `/api/mcp-servers`. |

## Markdown Rendering

`src/components/Markdown.tsx` renders LLM responses using `react-markdown` with a plugin pipeline:

### Plugin Stack

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeHighlight, [rehypeKatex, { throwOnError: false }]]}
  components={{ ... }}
>
  {sanitized}
</ReactMarkdown>
```

| Plugin | Purpose |
|--------|---------|
| `remark-gfm` | GitHub Flavored Markdown: tables, strikethrough, task lists, autolinks |
| `rehype-highlight` | Syntax highlighting for code blocks via highlight.js |
| `rehype-katex` | Math rendering for `$...$` / `$$...$$` via KaTeX (no throw on errors) |

### PreBlock — Copy to Clipboard

The `pre` element is replaced with a custom `PreBlock` component that adds a copy-to-clipboard button:

```tsx
function PreBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const text = extractText(children);  // recursively extracts text from React node tree
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);  // 2s feedback
    }).catch(() => {});
  }, [children]);
  return (
    <pre className="relative my-2 overflow-x-auto rounded-2xl bg-muted p-3 text-xs ring-1 ring-border group">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
        aria-label="Copy code"
      >
        {copied ? "✓" : "Copy"}
      </button>
      {children}
    </pre>
  );
}
```

The copy button is invisible by default (`opacity-0`) and appears on hover (`group-hover:opacity-100`). Shows "✓" for 2 seconds after copying.

### Custom Element Renderers

All standard HTML elements have custom Tailwind-styled renderers:

| Element | Styling |
|---------|---------|
| `code` (inline) | `rounded bg-muted px-1 py-0.5 text-xs font-mono` |
| `code` (block) | Passes through `language-*` / `hljs` class from rehype-highlight |
| `table` | `my-2 w-full border-collapse text-xs` |
| `th` | `border px-2 py-1 text-left font-semibold` |
| `td` | `border px-2 py-1` |
| `a` | `text-accent underline hover:opacity-80`, opens in new tab (`target="_blank" rel="noopener noreferrer"`) |
| `ul` / `ol` | `list-disc` / `list-decimal`, `pl-5` |
| `p` | `my-1.5 first:mt-0 last:mb-0` |
| `blockquote` | `border-l-2 border-accent/40 pl-3 text-muted-foreground` |
| `h1`-`h4` | Bold, decreasing sizes |
| `hr` | `my-3 border-border` |

### Tool Call Sanitization

Before rendering, content is passed through `sanitizeToolCallMarkup(content)` from `src/lib/toolCallSanitizer.ts`. This strips or transforms any tool-call markup embedded in LLM responses.

### Memoization

The `Markdown` component is wrapped in `memo()` to prevent re-renders during streaming. Since `content` is a string prop, React's default shallow comparison is sufficient — the component only re-renders when the content string actually changes.

## Key Architectural Patterns

### Optimistic UI with ID Swapping

The chat uses an **optimistic ID swapping** pattern in `useChat` (`src/hooks/useChat.ts`). When a user sends a message, temporary IDs are generated and immediately inserted into the UI. When the server responds with real IDs via SSE, the temporary IDs are swapped in-place.

```
1. User sends message
   → optimisticUser.id = `optimistic-user-${Date.now()}`
   → assistantId = `optimistic-assistant-${Date.now()}`
   → Both added to byIdRef map immediately
   → UI shows user message + empty assistant bubble instantly

2. SSE "start" event arrives with real userMessageId
   → byIdRef.delete(optimisticUser.id)
   → byIdRef.set(realId, { ...oldMsg, id: realId })
   → Assistant's parentId updated to realId
   → setMessages(buildChain(assistantId))  // rebuild display chain

3. SSE "delta" events stream content
   → byIdRef.set(assistantId, { ...existing, content: existing.content + delta })
   → setMessages(buildChain(assistantId))

4. SSE "done" event arrives with real assistantMessageId
   → byIdRef.delete(assistantId)
   → byIdRef.set(realId, { ...oldMsg, id: realId, model, elapsedMs })
   → setThread({ ...thread, currentLeafId: realId })
   → setMessages(buildChain(realId))
```

The `byIdRef` is a `Map<string, RawMessage>` that holds **all branch nodes** (not just the visible chain). `buildChain(leafId)` walks `parentId` from leaf to root, building the linear `ChatMessage[]` for display. This allows instant branch switching without re-fetching.

### Branch Tree Model

Messages form a tree via `parentId`. The visible chain is determined by `thread.currentLeafId`:

```
root (parentId=null)
  └─ user A
       └─ assistant A1 (leaf)
       └─ assistant A2 (leaf) ← currentLeafId points here
```

`switchBranch(messageId)` updates `currentLeafId` and rebuilds the chain. Siblings are found by matching `parentId` (null parentId messages are only siblings of themselves, preventing all root messages from being treated as siblings).

### SSR-Safe Client State

Several components must render correctly during SSR while their real state is only available on the client (localStorage, `resolvedTheme`, etc.). The pattern is:

```tsx
const [mounted, setMounted] = useState(false);
useEffect(() => setMounted(true), []);

return mounted ? <RealContent /> : <Placeholder />;
```

This is used by:

| Component | What's deferred | Placeholder |
|-----------|-----------------|------------|
| `ThemeToggle` | `resolvedTheme` from next-themes | Animated pulse square |
| `LanguageToggle` | `locale` from localStorage | Animated pulse square |
| `I18nProvider` | Restored locale | `DEFAULT_LOCALE` ("en") |
| `ContextMenu` | `document` (portal target) | Returns `null` |

The `I18nProvider` uses the same pattern as `next-themes`: render with `DEFAULT_LOCALE` during SSR, then re-render on the client after restoring from `localStorage`. It also updates `<html lang>` on restore to prevent screen reader misreads.

### clientFetch Wrapper

`src/lib/clientFetch.ts` wraps `fetch` with automatic 401 handling:

```tsx
export async function clientFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    // Invalid session (JWT userId not found, e.g. after DB recreation)
    document.cookie.split(";").forEach((c) => {
      const name = c.split("=")[0].trim();
      if (name.startsWith("authjs") || name.startsWith("next-auth")) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    });
    window.location.href = "/login";
  }
  return res;
}
```

On 401, it deletes all `authjs`/`next-auth` cookies and redirects to `/login`. This prevents an infinite redirect loop (`/login` → `/` → API 401 → `/login`) that would occur if the old JWT were treated as valid by the authorized callback.

**All client-side API calls use `clientFetch`** instead of raw `fetch`.

### Fire-and-Forget Persistence

Some state changes update the UI instantly and persist to the server in the background without awaiting the response:

```tsx
// switchBranch in useChat.ts
const switchBranch = useCallback((messageId: string) => {
  if (thread) {
    setThread({ ...thread, currentLeafId: messageId });
    // Fire-and-forget: does not block instant UI switching
    clientFetch(`/api/threads?id=${encodeURIComponent(thread.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentLeafId: messageId }),
    }).catch(() => { /* silent: UI has already switched */ });
  }
  setMessages(buildChain(messageId));
}, [thread]);
```

This pattern is used for:
- **Branch switching** — UI switches instantly, `currentLeafId` persists in background
- **MCP server selection** — `void updateThread({ mcpServerIds: ids })`
- **Connection selection** — `void updateThread({ connectionIds: ids })`
- **Thread rename** — optimistic update in list, refresh after

### Auto-Scroll Behavior

`ChatWindow` only auto-scrolls to bottom when the user is near the bottom (within 150px). This prevents disrupting the user when they scroll up to read previous messages:

```tsx
useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  const nearBottom = distFromBottom < 150;
  if (!nearBottom) return;
  if (scrollAnimRef.current !== null) return;  // suppress duplicate smooth-scroll
  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  scrollAnimRef.current = window.setTimeout(() => {
    scrollAnimRef.current = null;
  }, 400);
}, [messages]);
```

### IME Composition Handling

Enter-to-send is suppressed during IME composition (critical for Japanese/Chinese input):

```tsx
function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key === "Enter" && !e.shiftKey) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  }
}
```

## Motion & Animations

### MotionConfig

The root layout wraps the entire app in `<MotionConfig reducedMotion="user">`. This globally respects the user's `prefers-reduced-motion` setting — when enabled, all Motion animations are automatically reduced.

### MotionButton

A drop-in replacement for `<button>` that adds press and hover scale animations:

```tsx
export function MotionButton({ disabled, whileTap, whileHover, ...rest }: MotionButtonProps) {
  return (
    <motion.button
      disabled={disabled}
      whileTap={disabled ? undefined : whileTap ?? { scale: 0.95 }}
      whileHover={disabled ? undefined : whileHover ?? { scale: 1.02 }}
      {...rest}
    />
  );
}
```

Disabled buttons never animate — `while*` props are set to `undefined` when `disabled` is true, preventing motion from triggering on non-interactive elements.

### AnimateModal

The standard modal shell used by all modals (SettingsModal, MemoryViewerModal, SkillManagerModal, HelpModal, FolderSettingsModal, MoveToFolderModal):

```tsx
export function AnimateModal({ open, onClose, children, ariaLabel, panelClassName = "max-w-2xl" }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            variants={overlayFade} initial="initial" animate="animate" exit="exit"
            onClick={onClose} />
          <motion.div role="dialog" aria-modal="true" aria-label={ariaLabel}
            className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ...`}
            variants={fadeScaleIn} initial="initial" animate="animate" exit="exit">
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
```

Key behaviors:
- **Exit animation**: `AnimatePresence` plays the exit animation before unmounting
- **Click-outside-to-close**: Clicking the overlay calls `onClose`
- **Null when closed**: Renders nothing when `open` is false
- **Accessible**: `role="dialog"`, `aria-modal="true"`, `aria-label`

### Animation Patterns Across Components

| Component | Animation | Variants |
|-----------|-----------|----------|
| MessageBubble | Slide-in on mount | `animate-[msg-in_0.3s_ease-out]` (CSS keyframe) |
| Streaming cursor | Blink | `animate-[blink_1s_ease-in-out_infinite]` (CSS keyframe) |
| Sidebar (mobile) | Slide in/out | `translate-x` transition |
| ContextMenu | Scale + fade in | `initial={{ opacity: 0, scale: 0.96 }}` |
| Input menu popover | Scale + slide up | `initial={{ opacity: 0, scale: 0.95, y: 8 }}` |
| MCP/connection panel | Height expand | `initial={{ height: 0, opacity: 0 }}` |
| Send/Stop button | Cross-fade scale | `AnimatePresence mode="wait"` |
| Error message | Spring slide | `initial={{ x: -8 }}` spring |
| Accordion | Height + opacity | `accordionCollapse` variant |

## CSS & Theming

### CSS Variables

Defined in `src/app/globals.css` with light (default `:root`) and dark (`.dark`) themes. Tailwind v4 consumes these as utility classes (`bg-background`, `text-foreground`, `border-border`, etc.).

Key variables: `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--border`, `--accent`, `--card`, `--glass-bg`, `--glass-border`, `--glow`.

### Glass Morphism

The `--glass-bg` and `--glass-border` variables enable a glass-morphism aesthetic. Components use `bg-[var(--glass-bg)]` with `backdrop-blur` for translucent panels (sidebar header, context menus, mobile header).

### Aurora Background

An aurora effect is applied via `body::before` in `globals.css`, creating a subtle animated gradient background.

### Scrollbar & Focus

Custom thin scrollbars and `focus-visible` ring styles are defined globally for consistent keyboard navigation accessibility.

See [i18n & Theming](./i18n-theming.md) for full theming details.

## See also

- [Hooks & State](./hooks.md) — `useChat`, `useThreads`, `useFolders` — state management patterns
- [i18n & Theming](./i18n-theming.md) — Translation dictionaries, CSS variables, dark/light themes
- [Chat & Streaming](./chat-streaming.md) — SSE streaming protocol, branching model, dual-model, rapid mode
- [API Routes Reference](./api-routes.md) — Every API endpoint called by these components
- [Architecture Overview](./architecture.md) — High-level system architecture and data flow
