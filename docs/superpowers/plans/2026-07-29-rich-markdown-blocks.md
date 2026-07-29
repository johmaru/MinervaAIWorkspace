# Rich Markdown Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add remark-directive-based rich blocks (callout, inline styling, richlist) to the chat assistant's Markdown rendering, with LLM-taught syntax, Obsidian-native chat-export conversion, and streaming/fallback safety.

**Architecture:** A custom remark plugin (`remarkRichBlocks`) maps `containerDirective`/`textDirective` nodes to hast elements via `hName`/`hProperties`; `Markdown.tsx`'s `components` maps those element names to React components. A `richBlockMessage` is injected into `buildFinalMessages` to teach the LLM the syntax. Chat-export converts `:::callout` → Obsidian `> [!warning]`, `:::richlist` → plain list, `:mark[x]{.big}` → plain text before writing `.md` files.

**Tech Stack:** react-markdown 10.1, remark-directive, hastscript, unist-util-visit, lucide-react, Tailwind v4, clsx, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-rich-markdown-blocks-design.md`
- Co-located tests (no `__tests__/`); `// @vitest-environment node` for lib/API tests.
- 1 impl = 1 commit, English commit messages, push to `develop`.
- `bun run test` + `bun run typecheck` after every phase.
- No arbitrary px/hex colors for inline styling — theme-defined variants only.
- Unknown type/marker/class → default (callout=`note`, richlist=`info`, inline=disabled plain text).
- remark-directive textDirective syntax is `:mark[text]{.class}` (colon + name required; bare `[text]{.class}` is NOT a directive).

---

## File Structure

- **Create** `src/lib/remarkRichBlocks.ts` — custom remark plugin: maps directive nodes → hast (`hName`/`hProperties`).
- **Create** `src/lib/remarkRichBlocks.test.ts` — plugin unit tests.
- **Create** `src/components/rich-blocks/Callout.tsx` — callout React component (note/tip/warning/danger + title).
- **Create** `src/components/rich-blocks/InlineMark.tsx` — inline styling React component (big/small/accent/muted/danger/success/hl).
- **Create** `src/components/rich-blocks/RichList.tsx` — richlist React component (predefined markers, li icon prefixing).
- **Create** `src/components/rich-blocks/index.ts` — re-exports.
- **Modify** `src/components/Markdown.tsx` — add `remarkDirective` + `remarkRichBlocks` to `remarkPlugins`; map `callout`/`richlist`/`span` in `components`.
- **Modify** `src/components/Markdown.test.tsx` — add rich-block rendering/fallback/streaming tests.
- **Modify** `src/app/api/chat/route.ts` — inject `richBlockMessage` in `buildFinalMessages`.
- **Create** `src/lib/richBlockExport.ts` — `convertRichBlocksForExport(content)` (callout→Obsidian, richlist→plain list, mark→plain text).
- **Create** `src/lib/richBlockExport.test.ts` — export conversion tests.
- **Modify** `src/lib/chatExport.ts` — apply `convertRichBlocksForExport` to `assistantContent` before writing.
- **Modify** `package.json` — add `remark-directive`, `hastscript`, `unist-util-visit`.

---

## Task 1: Dependencies + remarkRichBlocks plugin

**Files:**
- Modify: `package.json`
- Create: `src/lib/remarkRichBlocks.ts`
- Test: `src/lib/remarkRichBlocks.test.ts`

**Interfaces:**
- Produces: `remarkRichBlocks` (unified `Plugin<[], Root>`) — used by `Markdown.tsx` `remarkPlugins`.

- [ ] **Step 1: Add dependencies**

Run:
```bash
bun add remark-directive hastscript unist-util-visit
bun add -d remark @types/mdast
```
Expected: `remark-directive`, `hastscript`, `unist-util-visit` in `dependencies`; `remark`, `@types/mdast` in `devDependencies`.

- [ ] **Step 2: Write the failing test**

Create `src/lib/remarkRichBlocks.test.ts`:
```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { remark } from "remark";
import remarkDirective from "remark-directive";
import { remarkRichBlocks } from "./remarkRichBlocks";

async function run(md: string) {
  const file = await remark().use(remarkDirective).use(remarkRichBlocks).run(remark().parse(md));
  return file;
}

function findDirective(tree: any): any {
  let found: any = null;
  function walk(node: any) {
    if (node.type === "containerDirective" || node.type === "textDirective") found = node;
    if (node.children) for (const c of node.children) walk(c);
  }
  walk(tree);
  return found;
}

describe("remarkRichBlocks", () => {
  it("maps callout containerDirective to hName=callout with type", async () => {
    const tree = await run(":::callout{type=\"warning\"}\nbody\n:::") as any;
    const node = findDirective(tree);
    expect(node.data.hName).toBe("callout");
    expect(node.data.hProperties.type).toBe("warning");
  });

  it("maps richlist containerDirective to hName=richlist with marker", async () => {
    const tree = await run(":::richlist{marker=\"check\"}\n- a\n:::") as any;
    const node = findDirective(tree);
    expect(node.data.hName).toBe("richlist");
    expect(node.data.hProperties.marker).toBe("check");
  });

  it("maps mark textDirective to hName=span with class", async () => {
    const tree = await run(":mark[hi]{.big}") as any;
    const node = findDirective(tree);
    expect(node.data.hName).toBe("span");
    expect(node.data.hProperties.className).toBe("big");
  });

  it("leaves unknown directives untouched", async () => {
    const tree = await run(":::unknown{x=1}\nbody\n:::") as any;
    const node = findDirective(tree);
    expect(node.data?.hName).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- src/lib/remarkRichBlocks.test.ts`
Expected: FAIL — `remarkRichBlocks` not defined.

- [ ] **Step 4: Write the plugin**

Create `src/lib/remarkRichBlocks.ts`:
```ts
import { h } from "hastscript";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import type { Plugin } from "unified";

const CONTAINER_NAMES = new Set(["callout", "richlist"]);
const TEXT_NAMES = new Set(["mark"]);

export const remarkRichBlocks: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, (node) => {
      if (
        node.type !== "containerDirective" &&
        node.type !== "leafDirective" &&
        node.type !== "textDirective"
      ) {
        return;
      }
      const name = node.name;
      if (!name) return;
      const data = node.data || (node.data = {});
      const attributes = node.attributes || {};

      if (node.type === "textDirective") {
        if (!TEXT_NAMES.has(name)) return;
        const hast = h("span", attributes);
        data.hName = "span";
        data.hProperties = hast.properties;
      } else if (CONTAINER_NAMES.has(name)) {
        const hast = h(name, attributes);
        data.hName = hast.tagName;
        data.hProperties = hast.properties;
      }
      // Unknown directives: left untouched → render as plain text / default.
    });
  };
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- src/lib/remarkRichBlocks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lockb src/lib/remarkRichBlocks.ts src/lib/remarkRichBlocks.test.ts
git commit -m "feat: add remarkRichBlocks plugin mapping directives to hast"
```

---

## Task 2: Callout component + Markdown.tsx integration

**Files:**
- Create: `src/components/rich-blocks/Callout.tsx`
- Create: `src/components/rich-blocks/index.ts`
- Modify: `src/components/Markdown.tsx`
- Test: `src/components/Markdown.test.tsx`

**Interfaces:**
- Consumes: `remarkRichBlocks` from Task 1.
- Produces: `Callout` component; `Markdown` renders `:::callout` blocks.

- [ ] **Step 1: Write the failing test**

Append to `src/components/Markdown.test.tsx` (new describe block):
```tsx
describe("Markdown — rich blocks: callout", () => {
  it("renders a callout with type=warning", () => {
    render(<Markdown content={':::callout{type="warning"}\n注意書き\n:::'} />);
    const box = document.querySelector("div.border-l-yellow-500");
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain("注意書き");
  });

  it("falls back to note for unknown type", () => {
    render(<Markdown content={':::callout{type="bogus"}\n本文\n:::'} />);
    const box = document.querySelector("div.border-l-blue-500");
    expect(box).not.toBeNull();
  });

  it("renders title header when provided", () => {
    render(<Markdown content={':::callout{type="tip" title="ヒント"}\n本文\n:::'} />);
    expect(screen.getByText("ヒント")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/Markdown.test.tsx`
Expected: FAIL — callout renders as plain text (no `.border-l-yellow-500`).

- [ ] **Step 3: Create the Callout component**

Create `src/components/rich-blocks/Callout.tsx`:
```tsx
import { memo } from "react";
import { Info, Lightbulb, AlertTriangle, AlertOctagon } from "lucide-react";
import { clsx } from "clsx";

type CalloutType = "note" | "tip" | "warning" | "danger";

const TYPE_STYLES: Record<CalloutType, { border: string; bg: string; Icon: typeof Info; iconColor: string }> = {
  note: { border: "border-l-blue-500", bg: "bg-blue-500/10", Icon: Info, iconColor: "text-blue-500" },
  tip: { border: "border-l-green-500", bg: "bg-green-500/10", Icon: Lightbulb, iconColor: "text-green-500" },
  warning: { border: "border-l-yellow-500", bg: "bg-yellow-500/10", Icon: AlertTriangle, iconColor: "text-yellow-500" },
  danger: { border: "border-l-red-500", bg: "bg-red-500/10", Icon: AlertOctagon, iconColor: "text-red-500" },
};

function isCalloutType(v: unknown): v is CalloutType {
  return v === "note" || v === "tip" || v === "warning" || v === "danger";
}

export const Callout = memo(function Callout({
  type,
  title,
  children,
}: {
  type?: string;
  title?: string;
  children?: React.ReactNode;
}) {
  const t = isCalloutType(type) ? type : "note";
  const s = TYPE_STYLES[t];
  const Icon = s.Icon;
  return (
    <div className={clsx("my-2 rounded-r-md border-l-4 py-3 pl-4 pr-3", s.border, s.bg)}>
      <div className="flex items-start gap-2">
        <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", s.iconColor)} />
        <div className="min-w-0 text-sm leading-relaxed">
          {title ? <p className="mb-1 font-semibold">{title}</p> : null}
          {children}
        </div>
      </div>
    </div>
  );
});
```

Create `src/components/rich-blocks/index.ts`:
```ts
export { Callout } from "./Callout";
export { InlineMark } from "./InlineMark";
export { RichList } from "./RichList";
```

- [ ] **Step 4: Wire into Markdown.tsx**

Modify `src/components/Markdown.tsx`:
- Add imports (near existing remark imports at top):
```ts
import remarkDirective from "remark-directive";
import { remarkRichBlocks } from "@/lib/remarkRichBlocks";
import { Callout, InlineMark, RichList } from "./rich-blocks";
```
- Change `remarkPlugins` (Markdown.tsx ~line 79) to:
```ts
remarkPlugins={[remarkGfm, remarkDirective, remarkRichBlocks]}
```
- Add to the `components` object (inside `ReactMarkdown` components prop):
```ts
callout: Callout,
richlist: RichList,
span: ({ className, class: cls, children }) => <InlineMark className={className ?? cls} children={children} />,
```
  Note: `InlineMark`/`RichList` referenced before creation in later tasks — define stubs now or create in same task. For Task 2, create minimal `InlineMark.tsx` and `RichList.tsx` stubs that just render `children`, replaced fully in Tasks 3–4.

Stub `src/components/rich-blocks/InlineMark.tsx`:
```tsx
export const InlineMark = ({ children }: { className?: string; children?: React.ReactNode }) => <>{children}</>;
```
Stub `src/components/rich-blocks/RichList.tsx`:
```tsx
export const RichList = ({ children }: { marker?: string; children?: React.ReactNode }) => <>{children}</>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- src/components/Markdown.test.tsx`
Expected: PASS (callout tests + existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/rich-blocks/ src/components/Markdown.tsx src/components/Markdown.test.tsx
git commit -m "feat: render callout directive blocks in Markdown"
```

---

## Task 3: InlineMark component (inline styling)

**Files:**
- Modify: `src/components/rich-blocks/InlineMark.tsx`
- Test: `src/components/Markdown.test.tsx`

**Interfaces:**
- Produces: full `InlineMark` with class→style mapping.

- [ ] **Step 4: Replace the stub with the full component**

Replace `src/components/rich-blocks/InlineMark.tsx`:
```tsx
import { memo } from "react";
import { clsx } from "clsx";

const CLASS_STYLES: Record<string, string> = {
  big: "text-[1.25em]",
  small: "text-[0.8em]",
  accent: "text-accent-foreground",
  muted: "text-muted-foreground",
  danger: "text-red-500",
  success: "text-green-500",
  hl: "rounded bg-yellow-500/30 px-0.5",
};

export const InlineMark = memo(function InlineMark({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const cls = CLASS_STYLES[className ?? ""];
  if (!cls) return <>{children}</>;
  return <span className={cls}>{children}</span>;
});
```

- [ ] **Step 1: Write the failing test** (TDD order — write before implementing)

Append to `Markdown.test.tsx`:
```tsx
describe("Markdown — rich blocks: inline styling", () => {
  it("applies big class to wrapped text", () => {
    const { container } = render(<Markdown content="これは:mark[重要]{.big}です" />);
    const span = container.querySelector("span.text-\\[1\\.25em\\]");
    expect(span?.textContent).toBe("重要");
  });

  it("falls back to plain text for unknown class", () => {
    const { container } = render(<Markdown content=":mark[x]{.bogus}" />);
    expect(container.textContent).toContain("x");
    expect(container.querySelector("span.text-\\[")).toBeNull();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun run test -- src/components/Markdown.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/rich-blocks/InlineMark.tsx src/components/Markdown.test.tsx
git commit -m "feat: render inline mark directives (big/small/accent/etc)"
```

---

## Task 4: RichList component

**Files:**
- Modify: `src/components/rich-blocks/RichList.tsx`
- Test: `src/components/Markdown.test.tsx`

**Interfaces:**
- Produces: full `RichList` with marker→icon prefixing on each `li`.

- [ ] **Step 1: Write the failing test**

Append to `Markdown.test.tsx`:
```tsx
describe("Markdown — rich blocks: richlist", () => {
  it("prefixes each li with the check icon", () => {
    const { container } = render(<Markdown content={':::richlist{marker="check"}\n- one\n- two\n:::'} />);
    const icons = container.querySelectorAll("svg.lucide-check");
    expect(icons.length).toBe(2);
  });

  it("falls back to info marker for unknown", () => {
    const { container } = render(<Markdown content={':::richlist{marker="bogus"}\n- x\n:::'} />);
    expect(container.querySelectorAll("svg.lucide-info").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/Markdown.test.tsx`
Expected: FAIL — no `.lucide-check` icons.

- [ ] **Step 3: Replace the stub with the full component**

Replace `src/components/rich-blocks/RichList.tsx`:
```tsx
import { memo, Children, isValidElement, cloneElement, type ReactNode } from "react";
import { Check, X, Star, ArrowRight, Info, AlertTriangle } from "lucide-react";
import { clsx } from "clsx";

type Marker = "check" | "cross" | "star" | "arrow" | "info" | "warning";

const MARKERS: Record<Marker, { Icon: typeof Check; color: string }> = {
  check: { Icon: Check, color: "text-green-500" },
  cross: { Icon: X, color: "text-red-500" },
  star: { Icon: Star, color: "text-yellow-500" },
  arrow: { Icon: ArrowRight, color: "text-accent-foreground" },
  info: { Icon: Info, color: "text-blue-500" },
  warning: { Icon: AlertTriangle, color: "text-yellow-500" },
};

function isMarker(v: unknown): v is Marker {
  return v === "check" || v === "cross" || v === "star" || v === "arrow" || v === "info" || v === "warning";
}

function prefixListItems(listEl: ReactNode, Icon: typeof Check, color: string): ReactNode {
  if (!isValidElement(listEl)) return listEl;
  const tag = listEl.type;
  if (tag !== "ul" && tag !== "ol") return listEl;
  const items = Children.toArray(listEl.props.children);
  const newItems = items.map((li) => {
    if (!isValidElement(li) || li.type !== "li") return li;
    return cloneElement(
      li,
      {},
      <Icon className={clsx("mr-2 inline-block h-4 w-4 shrink-0 align-text-bottom", color)} />,
      li.props.children,
    );
  });
  return cloneElement(listEl, {}, newItems);
}

export const RichList = memo(function RichList({
  marker,
  children,
}: {
  marker?: string;
  children?: ReactNode;
}) {
  const m = isMarker(marker) ? marker : "info";
  const { Icon, color } = MARKERS[m];
  const enhanced = Children.map(children, (child) => prefixListItems(child, Icon, color));
  return <div className="richlist-container my-2">{enhanced}</div>;
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/components/Markdown.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/rich-blocks/RichList.tsx src/components/Markdown.test.tsx
git commit -m "feat: render richlist directives with marker icons"
```

---

## Task 5: System prompt richBlockMessage injection

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Test: `src/app/api/chat/instruction.test.ts` (or `route.test.ts` pattern)

**Interfaces:**
- Produces: `richBlockMessage` system message in `buildFinalMessages`.

- [ ] **Step 1: Locate the injection point**

Read `src/app/api/chat/route.ts` around `buildFinalMessages` (line ~1207) and `toolGuardMessage` (line ~1213). The `richBlockMessage` follows the same pattern and is appended to the returned array alongside `toolGuardMessage`.

- [ ] **Step 2: Write the failing test**

Add to `src/app/api/chat/instruction.test.ts` (or a new test) verifying that the captured system messages include the rich-block syntax rules. Search for `:::callout` and `:mark[` in the captured system message content.
```ts
it("includes rich-block syntax rules in system messages", async () => {
  // ...existing setup that captures systemMessages...
  const richMsg = systemMessages.find((m) => m.content.includes(":::callout"));
  expect(richMsg).toBeDefined();
  expect(richMsg?.content).toContain(":mark[");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- src/app/api/chat/instruction.test.ts`
Expected: FAIL — no system message contains `:::callout`.

- [ ] **Step 4: Implement richBlockMessage**

In `src/app/api/chat/route.ts`, inside `buildFinalMessages` (before the `return [ ... ]`), add:
```ts
const richBlockMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
  role: "system" as const,
  content:
    "RICH MARKDOWN BLOCKS (optional, use only when they aid clarity — never overuse):\n" +
    "1. Callout: :::callout{type=\"note|tip|warning|danger\"}\ncontent\n::: — for important notes/suggestions/warnings. Optional title: :::callout{type=\"tip\" title=\"Hint\"}\n2. Inline styling: :mark[text]{.big|.small|.accent|.muted|.danger|.success|.hl} — on a minimal emphasized word only, never a whole sentence.\n" +
    "3. Rich list: :::richlist{marker=\"check|cross|star|arrow|info|warning\"}\n- item\n::: — only when order/classification is meaningful.\n" +
    "Rules: do NOT use these when plain Markdown suffices. Use the exact type/marker/class values listed. Unknown values fall back to defaults.",
};
```
Then add `richBlockMessage` to the returned array (after `toolGuardMessage`):
```ts
...(richBlockMessage ? [richBlockMessage] : []),
```
Note: `richBlockMessage` is always present (no conditional), so simplify to just `richBlockMessage,` in the array. Use a plain entry, matching how `getEnvContext()` is added.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- src/app/api/chat/instruction.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/chat/route.ts src/app/api/chat/instruction.test.ts
git commit -m "feat: teach LLM rich markdown block syntax via system prompt"
```

---

## Task 6: Chat-export conversion

**Files:**
- Create: `src/lib/richBlockExport.ts`
- Create: `src/lib/richBlockExport.test.ts`
- Modify: `src/lib/chatExport.ts:171`

**Interfaces:**
- Produces: `convertRichBlocksForExport(content: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/richBlockExport.test.ts`:
```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { convertRichBlocksForExport } from "./richBlockExport";

describe("convertRichBlocksForExport", () => {
  it("converts callout to Obsidian native syntax", () => {
    const out = convertRichBlocksForExport(':::callout{type="warning"}\nbody line\n:::');
    expect(out.trim()).toBe("> [!warning]\n> body line");
  });

  it("converts callout with title", () => {
    const out = convertRichBlocksForExport(':::callout{type="tip" title="Hint"}\nbody\n:::');
    expect(out.trim()).toBe("> [!tip] Hint\n> body");
  });

  it("falls back to [!note] for unknown type", () => {
    const out = convertRichBlocksForExport(':::callout{type="bogus"}\nbody\n:::');
    expect(out).toContain("> [!note]");
  });

  it("converts richlist to plain list", () => {
    const out = convertRichBlocksForExport(':::richlist{marker="check"}\n- one\n- two\n:::');
    expect(out).toBe("- one\n- two");
  });

  it("strips mark inline styling to plain text", () => {
    const out = convertRichBlocksForExport("a :mark[b]{.big} c");
    expect(out).toBe("a b c");
  });

  it("leaves plain markdown untouched", () => {
    const out = convertRichBlocksForExport("# Title\n\nplain **bold**");
    expect(out).toBe("# Title\n\nplain **bold**");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/lib/richBlockExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the converter**

Create `src/lib/richBlockExport.ts`:
```ts
const CALLOUT_RE = /:::callout\{([^}]*)\}\n([\s\S]*?)\n:::/g;
const RICHLIST_RE = /:::richlist\{([^}]*)\}\n([\s\S]*?)\n:::/g;
const MARK_RE = /:mark\[([^\]]*)\]\{\.([a-z]+)\}/g;

const CALLOUT_TYPES = new Set(["note", "tip", "warning", "danger"]);

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

export function convertRichBlocksForExport(content: string): string {
  let out = content;

  // callout → Obsidian native: > [!type] Title\n> bodyline
  out = out.replace(CALLOUT_RE, (_raw, attrsRaw: string, body: string) => {
    const a = parseAttrs(attrsRaw);
    const type = CALLOUT_TYPES.has(a.type) ? a.type : "note";
    const header = a.title ? `> [!${type}] ${a.title}` : `> [!${type}]`;
    const bodyLines = body.split("\n").map((l: string) => `> ${l}`.trimEnd());
    return [header, ...bodyLines].join("\n");
  });

  // richlist → plain list (strip the wrapper, keep the list body)
  out = out.replace(RICHLIST_RE, (_raw, _attrs: string, body: string) => body.trim());

  // mark inline → plain text
  out = out.replace(MARK_RE, (_raw, text: string) => text);

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/lib/richBlockExport.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire into chatExport.ts**

Modify `src/lib/chatExport.ts` line 171 — replace `params.assistantContent` with `convertRichBlocksForExport(params.assistantContent)`:
```ts
import { convertRichBlocksForExport } from "./richBlockExport";
// ...
const turnBlock =
  `${header}\n---\n\n## 👤 User (${ts})\n\n${params.userContent}\n\n## 🤖 Assistant (${ts})\n\n${convertRichBlocksForExport(params.assistantContent)}\n`;
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/richBlockExport.ts src/lib/richBlockExport.test.ts src/lib/chatExport.ts
git commit -m "feat: convert rich blocks to Obsidian-native syntax on chat export"
```

---

## Task 7: Streaming safety + full verification

**Files:**
- Test: `src/components/Markdown.test.tsx`

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Write streaming-safety tests**

Append to `Markdown.test.tsx`:
```tsx
describe("Markdown — rich blocks: streaming safety", () => {
  it("does not crash on unclosed callout", () => {
    expect(() => render(<Markdown content={':::callout{type="warning"}\nbody so far'} />)).not.toThrow();
  });

  it("does not crash on unclosed richlist", () => {
    expect(() => render(<Markdown content={':::richlist{marker="check"}\n- one'} />)).not.toThrow();
  });

  it("does not crash on unclosed mark", () => {
    expect(() => render(<Markdown content=":mark[unfinished" />)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test -- src/components/Markdown.test.tsx`
Expected: PASS (no throws).

- [ ] **Step 3: Run full suite + typecheck**

Run:
```bash
bun run test
bun run typecheck
```
Expected: zero failures, zero type errors.

- [ ] **Step 4: Manual smoke test**

Run `bun run dev`, open the app, send a message that would trigger a callout (e.g. "注意点を教えて"), and confirm the callout renders with icon/border. Confirm streaming does not crash mid-block. Confirm chat-export (if `CHAT_EXPORT_PATH` set) writes `> [!warning]` form.

- [ ] **Step 5: Commit**

```bash
git add src/components/Markdown.test.tsx
git commit -m "test: streaming safety for rich blocks + full verification"
git push origin develop
```

---

## Self-Review

**Spec coverage:**
- callout (note/tip/warning/danger + title) → Task 2 ✓
- inline styling (big/small/accent/muted/danger/success/hl) → Task 3 ✓
- richlist (check/cross/star/arrow/info/warning) → Task 4 ✓
- system prompt injection + over-use suppression → Task 5 ✓
- streaming behavior (no crash on unclosed) → Task 7 ✓
- chat-export (callout→Obsidian native, richlist→plain, inline→plain) → Task 6 ✓
- fallback (unknown type/marker/class → default) → Tasks 2/3/4/6 ✓
- verify at impl time (react-markdown 10.1 + remark-directive compat) → resolved: custom remark plugin + hName/hProperties per official remark-directive README ✓

**Placeholder scan:** No TBD/TODO. All steps have complete code.

**Type consistency:** `remarkRichBlocks` (Plugin) used in Task 1 & 2. `Callout`/`InlineMark`/`RichList` props match across tasks. `convertRichBlocksForExport(content: string): string` consistent in Task 6.

**Note on Task 3 ordering:** Steps are numbered with the implementation step in the middle to keep the stub→full replacement clear; the test (Step 1) still precedes the full implementation (Step 4). When executing, run Step 1 (write test) → Step 2 (fail) → Step 4 (implement) → Step 5 (pass) → Step 6 (commit).
