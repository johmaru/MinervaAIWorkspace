<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:umanschat-debug-skill -->
# UmansChat Debug Guide

Before debugging SSE streaming, Docker build, transformers.js, pgvector, or
Next.js 16 issues in this project, read `skill://umanschat-debug`
for known pitfalls and solutions discovered during development.
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

## Memory Directives

- ユーザーが「今度覚えといて」「これ覚えといて」等の指示を出した場合、
  その内容を `AGENTS.md` に追記する（適切な既存セクションがあればそこへ、
  なければ新規セクションを作成）。
- 追記後、整理して重複や矛盾がないか確認し、必要があれば既存内容を統合・整理する。
- 追記・整理が終わったら Git Workflow に従って commit + push する。

## Documentation Sync

- 機能を追加・変更・削除した場合は、`README.md`（EN）と `README.ja.md`（JA）の
  両方に反映する。Features リスト、Configuration の env 変数表、Usage、
  Architecture など該当セクションを更新する。
- 両ファイルで同一情報を保ち、EN と JA で内容が乖離しないこと。
- README 更新も実装の一部として扱い、1コミットに含める（別コミットに分けない）。