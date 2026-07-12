---
alwaysApply: true
description: MANDATORY end-of-task checklist — review, test, commit/push, README sync, cleanup
---
# Work Completion Checklist — MANDATORY

Before yielding any task, run through ALL of the following.

## Checklist

1. **Testing**: Run `bun run test`. Confirm zero failures. Never delete or weaken an assertion to make a test pass.
2. **Typecheck**: Run `bun run typecheck` (`tsc --noEmit`). Confirm zero errors.
3. **No uncommitted files**: Run `git status --short`. It must show nothing. Every file you created must be either committed or added to `.gitignore`. Never leave untracked or modified files behind.
4. **No secrets staged**: Never commit `.env`, API keys, credentials, or user data. If you touched such a file, add it to `.gitignore` immediately.
5. **Commit + push**: One implementation = one commit. Commit message in English, describing changes and verification. Push to `develop`.
6. **README sync**: If the change affects user-facing behaviour, setup, configuration, environment variables, architecture, or deployment, update both `README.md` (EN) and `README.ja.md` (JA). Keep them aligned. Do not update for internal refactors or typo fixes.
7. **Report**: Include what changed, how it was verified (test pass/fail count, typecheck result), and any risks or follow-up tasks.

## Review before yielding

- Architecture: Did this make the design simpler or more tangled?
- Next.js correctness: App Router, Server/Client boundaries, route handlers, async APIs.
- UI/UX consistency: Does the result match existing product style and patterns?
- If issues found: fix correctness/build/runtime/data-loss issues now; defer polish.

## Detailed guidance

For the full checklist with examples and edge cases, read `skill://work-completion-checklist`.
