<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:umanschat-debug-skill -->
# UmansChat Debug Guide

Before debugging SSE streaming, Docker build, transformers.js, pgvector, or
Next.js 16 issues in this project, read `skill://umanschat-debug`
for known pitfalls and solutions discovered during development.

Key pitfall: `generateMemories` in `src/app/api/chat/route.ts` must run via
`after()` (not bare fire-and-forget, not blocking `await`), and `after()`
must be called in the POST handler body (request scope), NOT inside the
`ReadableStream` `start()` callback. A blocking `await` before
`controller.close()` keeps the client's `isStreaming` high and freezes the
UI after the answer. A bare `void` after `close()` is cancelled by the
Next.js runtime. Calling `after()` inside `start()` silently fails because
the request context (waitUntil) is already gone — the callback never runs.
Use a Promise bridge (`streamDone`) so the `after()` callback in the POST
body can await stream completion and read the final `assistantContent`.
<!-- END:umanschat-debug-skill -->

<!-- BEGIN:frontend-quality-rules -->
# Frontend Quality Rules

This project is an AI chat platform built with React / Next.js App Router.

Before editing Next.js code, follow the Next.js agent rules above and check the relevant local documentation in `node_modules/next/dist/docs/` when needed.

When editing frontend UI:
- Improve clarity and usability before decoration.
- Use semantic HTML.
- Use Tailwind CSS consistently.
- Prefer accessible primitives/components when suitable.
- Keep spacing, typography, borders, shadows, and radius consistent.
- Make layouts responsive for mobile, tablet, and desktop.
- Avoid random gradients, excessive shadows, inconsistent spacing, and visually noisy UI.
- Avoid generic SaaS landing-page styling unless working on a marketing page.
- Split large JSX into smaller components when readability suffers.
- Keep loading, empty, error, and disabled states polished.
- Preserve existing product behaviour unless the task explicitly asks to change it.
- After editing, check TypeScript, lint, layout issues, and console errors where possible.

AI chat product UX:
- Chat should feel fast, calm, and readable.
- Prioritise message readability, input ergonomics, and conversation navigation.
- Make streaming states clear without being distracting.
- Keep user messages and assistant messages visually distinct.
- Make code blocks readable, copyable, and horizontally scrollable when needed.
- Handle long messages, markdown, lists, tables, and inline code gracefully.
- Ensure the composer works well with multiline input, attachments if present, and keyboard shortcuts.
- Important actions such as send, stop, retry, edit, copy, and regenerate should be easy to find.
- Empty states should guide the user without looking like a generic template.
- Error states should explain what happened and offer a clear next action.
- Settings, model selection, and conversation controls should be discoverable but not visually loud.
- Do not add unnecessary animations to streaming text or chat messages.

Design direction:
- Clean, focused, modern chat interface.
- Similar quality bar to ChatGPT / Claude / Perplexity style products, but do not blindly clone them.
- Prioritise legibility, low visual noise, and smooth daily use.
- Prefer restrained polish over decorative UI.
<!-- END:frontend-quality-rules -->

Implementation Review Loop

For every non-trivial feature, bug fix, or UI change, follow this loop:

Plan before editing
Briefly identify the files likely to change.
Explain the intended component/data/API boundaries.
Check whether the change fits the existing app structure.
Check whether the change requires reading local Next.js docs from node_modules/next/dist/docs/.
Avoid broad refactors unless explicitly requested.
Implement in small, reversible steps
Prefer focused changes over sweeping rewrites.
Preserve existing product behaviour unless the task explicitly asks to change it.
Reuse existing components, utilities, naming, spacing, and data flow where possible.
Do not introduce one-off patterns unless there is a clear reason.
Review after editing
After implementation, review the diff from these perspectives:
Architecture: Did this make the overall design simpler or more tangled?
Next.js correctness: Are App Router, Server/Client Component boundaries, route handlers, redirects, params/searchParams, caching, and async APIs used correctly for this installed Next.js version?
UI/UX consistency: Does the result match the existing product style, spacing, states, and interaction patterns?
Future extensibility: Will likely next features be easier or harder after this change?
AGENTS.md rules: Did this task reveal a repeated pitfall or project rule that should be added here?
Report clearly
When finishing, include:
What changed.
How it was verified.
Any risks or follow-up tasks.
Whether AGENTS.md or README files were updated, and why.

If issues are found during review, separate them into:

Fix now: correctness, build, runtime, data loss, accessibility, or obvious UX breakage.
Follow up later: polish, optional refactors, or larger design improvements.

## Chat Interaction Details

- Enter should send the message.
- Shift+Enter should insert a newline.
- The composer should not jump around during typing or streaming.
- The page should keep sensible scroll behaviour during streaming.
- The latest assistant response should remain easy to follow.
- Copy buttons should not disturb text selection.
- Stop / retry / regenerate actions should only appear when relevant.
- Long conversations should remain navigable.

## Git Workflow

- 実装が1つ完了したら、`develop` に commit して `git push` する。
  1実装 = 1コミットを基本とする。
- 過去コミットの修正依頼が来たら、`git commit --amend` で前回コミットを
  書き換えて `git push --force-with-lease` で再 push する。
  （共同作業者がいる場合は履歴書き換えの同意を確認してから）
- コミットメッセージは英語で、変更内容・検証結果を簡潔に記載する。

## Project Rule Memory
When the user says 「今度覚えといて」「これ覚えといて」 or similar, decide whether the content is a durable project rule, workflow rule, known pitfall, or implementation convention.
Add it to AGENTS.md only when it should affect future work in this repository.
Do not add personal preferences, temporary notes, random reminders, or unrelated facts to AGENTS.md.
When adding a rule, place it in the most relevant existing section when possible.
After editing, check for duplication, contradiction, or overly specific rules that should be generalized.
If the instruction is ambiguous, ask whether it should be stored as a project rule before editing AGENTS.md.

## Documentation Sync
Update README.md (EN) and README.ja.md (JA) when a change affects documented user-facing behaviour, setup, configuration, environment variables, architecture, usage, deployment, or major features.
Do not update README files for purely internal refactors, small visual polish, typo fixes, or implementation details that users do not need to know.
Keep both README files aligned. The English and Japanese versions should not drift in meaning.
When README updates are needed, include them in the same commit as the related implementation unless explicitly asked to split them.

