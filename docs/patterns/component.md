# Pattern: React Component

How to add or modify React components in `src/components/`.

## Server vs Client Component

```typescript
// ❌ Bad — adding "use client" when not needed
"use client";
export function ThreadList({ threads }: { threads: Thread[] }) {
  return <ul>{threads.map(t => <li key={t.id}>{t.title}</li>)}</ul>;
}
// This is a pure render — no hooks, no events, no browser APIs.
// It should be a Server Component (no "use client").
```

```typescript
// ✅ Good — "use client" only when needed
"use client";
import { useState } from "react";

export function ThreadEditor({ thread }: { thread: Thread }) {
  const [editing, setEditing] = useState(false);
  // useState, useEffect, event handlers → needs "use client"
  return (
    <button onClick={() => setEditing(true)}>Edit</button>
  );
}
```

**Rule:** Use `"use client"` only when the component uses hooks, event handlers,
browser APIs, or is imported by a Client Component. Pure render components stay
as Server Components.

## Component structure

```typescript
// src/components/Sidebar.tsx
"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  threads: Thread[];
  onSelect: (threadId: string) => void;
  className?: string;
}

export function Sidebar({ threads, onSelect, className }: SidebarProps) {
  // 1. Hooks first
  const [activeId, setActiveId] = useState<string | null>(null);

  // 2. Callbacks
  const handleSelect = useCallback((threadId: string) => {
    setActiveId(threadId);
    onSelect(threadId);
  }, [onSelect]);

  // 3. Render
  return (
    <aside className={cn("w-64 border-r border-border", className)}>
      <nav aria-label="Thread list">
        <ul role="list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                onClick={() => handleSelect(thread.id)}
                aria-current={activeId === thread.id ? "page" : undefined}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md text-sm",
                  activeId === thread.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted"
                )}
              >
                {thread.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
```

## ✅ Good patterns

### Semantic HTML

```typescript
// ✅ Good — semantic elements with ARIA
<nav aria-label="Main navigation">
  <button aria-label="Open menu" aria-expanded={isOpen} aria-controls="menu">
    Menu
  </button>
</nav>
```

```typescript
// ❌ Bad — div soup, no semantics
<div className="nav">
  <div className="btn" onClick={toggle}>Menu</div>
</div>
```

### Tailwind theme tokens

```typescript
// ✅ Good — uses theme tokens (border-border, bg-muted, text-accent-foreground)
<button className="bg-accent text-accent-foreground hover:bg-muted">
```

```typescript
// ❌ Bad — hardcoded colours
<button className="bg-[#3b82f6] text-white hover:bg-[#2563eb]">
```

### Reuse existing UI primitives

Prefer a plain semantic `<button>` with Tailwind tokens for most cases.
Use `MotionButton` (from `src/components/ui/motion.tsx`) only when you
genuinely need tap/hover motion that matches existing interactive elements.

```typescript
// ✅ Good — plain semantic button with theme tokens (no motion needed)
<button
  type="button"
  onClick={handleSave}
  disabled={isSaving}
  className="bg-accent text-accent-foreground hover:bg-muted rounded-md px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
>
  Save
</button>
```

```typescript
// ✅ Good — MotionButton when motion is already part of the design
import { MotionButton } from "@/components/ui/motion";
<MotionButton type="button" onClick={handleSave} disabled={isSaving} whileTap={{ scale: 0.95 }}>
  Save
</MotionButton>
```

```typescript
// ❌ Bad — reinvents button styling from scratch with hardcoded colours
<button className="px-4 py-2 bg-blue-500 rounded hover:bg-blue-600 text-white font-medium">
  Save
</button>
```

Available UI primitives in `src/components/ui/motion.tsx`:
`MotionButton`, `AnimateModal`, `Accordion`, plus animation variants
(`fadeScaleIn`, `fadeSlideUp`, `overlayFade`, `accordionCollapse`).
Do not add unnecessary animations to streaming text or chat messages
(see `AGENTS.md` → Frontend Quality Rules).

### Accessible interactive elements

```typescript
// ✅ Good — button with aria-current, keyboard accessible
<button
  onClick={handleSelect}
  aria-current={isActive ? "page" : undefined}
  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  {thread.title}
</button>
```

### Loading / empty / error states

```typescript
// ✅ Good — all three states handled
if (isLoading) return <ThreadListSkeleton />;
if (error) return <ErrorMessage error={error} onRetry={refetch} />;
if (threads.length === 0) return <EmptyState message="No threads yet" />;
return <ThreadList threads={threads} />;
```

```typescript
// ❌ Bad — no states, crashes on undefined
return <ThreadList threads={data.threads} />;
// If data is undefined or data.threads is undefined → crash
```

### Split large JSX

```typescript
// ✅ Good — extracted sub-components
function ChatWindow({ messages }: { messages: Message[] }) {
  return (
    <main>
      <MessageList messages={messages} />
      <Composer onSubmit={handleSend} />
    </main>
  );
}
```

```typescript
// ❌ Bad — 200-line JSX block
function ChatWindow({ messages }: { messages: Message[] }) {
  return (
    <main>
      {/* 150 lines of inline JSX */}
      <div className="...">
        <div className="...">
          {/* nested 8 levels deep */}
        </div>
      </div>
    </main>
  );
}
```

## Chat UX rules (from AGENTS.md)

When working on chat UI:

- Enter sends, Shift+Enter inserts newline
- Composer should not jump during typing or streaming
- Keep sensible scroll behaviour during streaming
- Latest assistant response should remain easy to follow
- Copy buttons should not disturb text selection
- Stop / retry / regenerate actions only appear when relevant
- No unnecessary animations on streaming text
- User and assistant messages should be visually distinct
- Code blocks should be readable, copyable, horizontally scrollable

## Test pattern

```typescript
// src/components/Sidebar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";

afterEach(() => cleanup());

describe("Sidebar", () => {
  it("renders thread titles", () => {
    render(<Sidebar threads={[{ id: "1", title: "Hello" }]} onSelect={vi.fn()} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("calls onSelect when clicking a thread", async () => {
    const onSelect = vi.fn();
    render(<Sidebar threads={[{ id: "1", title: "Hello" }]} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("Hello"));
    expect(onSelect).toHaveBeenCalledWith("1");
  });

  it("marks active thread with aria-current", () => {
    render(<Sidebar threads={[{ id: "1", title: "Hello" }]} onSelect={vi.fn()} />);
    // After click, aria-current="page" should be set
    const button = screen.getByText("Hello");
    // Initially no aria-current
    expect(button).not.toHaveAttribute("aria-current");
  });
});
```

See also: [Frontend Components](../frontend.md), [Hooks & State](../hooks.md)
