# Rich Markdown Blocks — Design Spec (Batch 1)

Date: 2026-07-29
Status: Approved (brainstorming complete)

## Background

LLM outputs Markdown; `src/components/Markdown.tsx` renders it to HTML client-side via `react-markdown` (remark-gfm + rehype-highlight + rehype-katex). The display the user sees is already rendered HTML, not raw `#`/`**`. The goal of this work is to add **expressiveness beyond plain Markdown** — callouts, inline styling, rich lists — while keeping the safe client-rendered model: no raw LLM-emitted HTML, no XSS surface, streaming-tolerant.

The user's intent (from brainstorming): predefine a set of "typical shapes" as program-side components; the LLM only selects a shape via a lightweight syntax and fills in the content. The LLM never writes raw HTML.

## Method: remark-directive (option B)

Chosen over custom-fence (option A, e.g. ```` ```callout{type="warning"} ````) because option A is more entangled in this pipeline, not less:

- `rehype-highlight@7` runs in the rehype stage (`Markdown.tsx:80`) **before** the `code` component. For ```` ```callout ````, highlight.js finds no "callout" language → with `detect=false` (default) it leaves content but injects the `hljs` class and wraps in `<pre><code>`. `CodeBlock` (`Markdown.tsx:59`) treats `hljs`/`language-` as `isBlock=true`, so it renders as a plain code block, not a callout. Avoiding this requires branching inside `CodeBlock` **and** overriding `pre` (`PreBlock` wraps at `Markdown.tsx:42`) **and** a remark plugin to lift fence meta → hProperties.
- Fence meta `{type="warning",title="..."}` is NOT reachable from `className`; `remark-rehype` does not transfer fenced-code meta to hast by default.

`remark-directive` sidesteps all three:

- `:::callout{type="warning"}` becomes a `containerDirective` → `<div>` (never `<pre>`, never seen by `rehype-highlight`, attributes carried natively via hProperties).
- The same plugin's `textDirective` also covers the inline-styling layer the user asked for (font size/color) — option A would need a separate inline mechanism on top.

Net: B is the genuinely simpler path against this pipeline and unifies both the block and inline layers.

## Architecture

1. Add `remark-directive` to `Markdown.tsx` `remarkPlugins` (alongside `remarkGfm`).
2. Map `containerDirective`/`textDirective` to hast elements. Two implementation candidates, to be decided at impl time after verifying react-markdown 10.1 compatibility:
   - (a) `remark-rehype` `handlers` option mapping directive nodes → custom element names.
   - (b) A small custom remark plugin mapping directive → hast.
   - `containerDirective` → `<div>` (e.g. `data-directive="callout"`), attributes via hProperties.
   - `textDirective` → `<span>` (e.g. `data-directive="mark"`), attributes via hProperties.
3. `Markdown.tsx` `components` maps element names (`callout`/`richlist`/`mark` or the `div`/`span` with data attributes) to dedicated React components styled with Tailwind (theme-aware, dark-mode supported; reuse existing `clsx`/`tailwind-merge`/`class-variance-authority` and `lucide-react` icons).
4. Inject `richBlockMessage` into `buildFinalMessages` (`src/app/api/chat/route.ts:1207`) alongside `toolGuardMessage`, teaching the LLM the syntax and the over-use suppression rules.

## Block specs

### callout (containerDirective)

```
:::callout{type="warning"}
複合インデックスは WHERE 句の順序に合わせる
:::
```

| type | color | icon (lucide-react) | use |
|---|---|---|---|
| `note` | blue | Info | supplementary info |
| `tip` | green | Lightbulb | suggestion / best practice |
| `warning` | yellow | AlertTriangle | caution |
| `danger` | red | AlertOctagon | warning / prohibition |

Default `note` when `type` omitted. Optional `title` attribute for a header label (`:::callout{type="warning" title="注意"}`); when omitted, no text header (icon + border only). Style: left border + background (theme-aware, dark-mode).

### inline styling (textDirective)

```
この部分は:mark[重要]{.accent}です。
```

| class | effect |
|---|---|
| `.big` | 1.25em |
| `.small` | 0.8em |
| `.accent` | theme accent color |
| `.muted` | muted color |
| `.danger` | red |
| `.success` | green |
| `.hl` | background highlight (yellow) |

No arbitrary px or hex colors; theme-defined variants only (prevents LLM over-coloring and keeps XSS/validation surface flat).

### richlist (containerDirective)

```
:::richlist{marker="check"}
- 複合インデックスは WHERE 順
- カバリングインデックスで I/O 削減
:::
```

Predefined marker set (user chose predefined markers over raw lucide names to prevent LLM writing non-existent icons):

- `check` (green) / `cross` (red) / `star` (yellow) / `arrow` (accent) / `info` (blue) / `warning` (yellow)

Body is a normal Markdown list; the marker replaces each `li` bullet with the corresponding lucide icon. 1-level nesting allowed.

## System prompt injection (`richBlockMessage`)

Injected in `buildFinalMessages` (`route.ts:1207`) alongside `toolGuardMessage`. Rules:

- callout: only for important notes/tips. If a normal paragraph suffices, do not use it.
- richlist: only when order or classification is meaningful.
- inline styling: on the minimal emphasized word(s) only, never over a whole sentence.
- Do not use extended syntax when plain Markdown suffices.
- Lists the valid type/marker/class sets explicitly to prevent the LLM writing unknown variants.

## Streaming behavior

- **containerDirective (callout/richlist):** until the closing `:::` arrives, `remark-directive` may not recognize the directive → content shows as paragraphs/text → switches to the rich component once `:::` arrives. Content is text (not raw JSON), so less ugly than data-content blocks, but a visual jump exists.
- **textDirective (inline):** `:mark[text]{.big}` is not recognized until `]{.big}` arrives; unclosed shows as plain text. Relatively tolerant because the close is unambiguous.
- Verify in real streaming at impl time. If the jump is unacceptable, consider a loading-placeholder on fence-close (deferred out of batch 1).

This is distinct from the HTML incomplete-tag problem (already dismissed): that was about raw HTML, which we are not emitting. The directive streaming concern is a recognition-timing issue and is tolerable for text content.

## chat-export

The export pipeline (`appendChatExport`, `route.ts:741`; `.md` files; Obsidian-compatibility value stated at `dictionaries.ts:755`) converts extended syntax on export to preserve Obsidian semantics rather than leaving raw `:::` (ugly literal) or stripping (lossy):

- **callout → Obsidian native callout syntax** `> [!warning] Title\n> content` when `title` present, else `> [!warning]\n> content` (1:1 mapping for `note`/`tip`/`warning`/`danger`). This renders callouts natively in Obsidian, preserving semantics.
- **richlist → plain Markdown list** (no Obsidian equivalent).
- **inline styling → plain text** (strip the class wrapper, keep the text).

Captured here to prevent a future agent from defaulting to the lossy plain-strip.

## Fallback

- Unknown `type`/`marker`/`class` → default (callout=`note`, richlist=`info`, inline=disabled → plain text).
- Malformed syntax → `react-markdown` shows plain text (no crash).
- The system prompt lists valid sets to prevent the LLM writing unknown variants; fallback handles the residual cases.

## Testing (`Markdown.test.tsx`, co-located)

Add cases following the existing `describe` groups:

- callout: each `type` renders with the expected icon/border; optional `title` renders as header.
- inline: each class applies the expected style hook.
- richlist: each marker renders the expected icon per `li`.
- fallback: unknown `type` → default; unknown class → plain text.
- streaming: incomplete `:::callout` (no closing `:::`) does not crash.
- malformed syntax → plain text, no crash.
- chat-export: `:::callout{type="warning"}` → `> [!warning]`; `:::richlist` → plain list; `:mark[x]{.big}` → `x`.

## Verify at impl time

1. `react-markdown@10.1.0` + `remark-directive` compatibility.
2. How `containerDirective`/`textDirective` nodes surface in `components` (expected: `div`/`span` with `node.data.hProperties`).
3. Streaming behavior of `containerDirective` before the closing `:::` arrives (visual jump acceptability).

## Out of scope (batch 2+)

`chart` and `dbtable` are deferred. Data-content blocks cannot render until the fence closes → users see raw partial JSON mid-stream, then a visual jump on ```` ``` ```` arrival. This is a distinct problem from the HTML incomplete-tag issue and is a concrete reason to defer beyond just dependency weight. Investigate line-oriented formats or a loading-placeholder on fence-close before batch 2.
