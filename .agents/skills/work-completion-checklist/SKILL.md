---
name: work-completion-checklist
description: >
  MANDATORY checklist to run AFTER finishing any implementation work and
  BEFORE yielding to the user. Covers review, testing, git commit/push,
  README sync, and cleanup. Also enforces the no-uncommitted-files rule:
  every file you create must be either committed or added to .gitignore.
  Read this at the end of every task.
origin: session-work-completion
---

# Skill: Work Completion Checklist

**This skill is the single source of truth for what happens AFTER implementation
is complete.** The AGENTS.md points here as the top-priority end-of-work gate.

Read this skill at the end of every task — after implementation, before yielding.

## 1. Review after editing

After implementation, review the diff from these perspectives:

- **Architecture:** Did this make the overall design simpler or more tangled?
- **Next.js correctness:** Are App Router, Server/Client Component boundaries,
  route handlers, redirects, params/searchParams, caching, and async APIs used
  correctly for this installed Next.js version?
- **UI/UX consistency:** Does the result match the existing product style,
  spacing, states, and interaction patterns?
- **Future extensibility:** Will likely next features be easier or harder
  after this change?
- **AGENTS.md rules:** Did this task reveal a repeated pitfall or project rule
  that should be added to AGENTS.md?

If issues are found during review, separate them into:

- **Fix now:** correctness, build, runtime, data loss, accessibility, or
  obvious UX breakage.
- **Follow up later:** polish, optional refactors, or larger design improvements.

## 2. Report clearly

When finishing, include:

- What changed.
- How it was verified.
  - Test results: what `bun run test` reported (pass/fail count), and which
    new test files were added.
- Any risks or follow-up tasks.
- Whether AGENTS.md or README files were updated, and why.

## 3. Testing — Before claiming work is done

- Run `bun run test` and confirm zero failures.
- If a test needs an external API (LLM, embedder) that is unavailable, gate it
  behind a helper like the existing `itReal()` pattern or skip with a clear
  reason.
- **Never delete or weaken an assertion to make a test pass.**

## 4. No uncommitted files — MANDATORY

**Every file you create or modify must end up in one of two states:**

1. **Committed** to git (staged + committed in the same commit as the related
   implementation), OR
2. **Explicitly ignored** via `.gitignore` (if it's a build artifact, env file,
   log file, or other non-source artifact).

### Rules

- **Never leave untracked or modified files behind.** Before yielding, run
  `git status --short` and confirm it shows nothing (or only files that are
  intentionally ignored).
- **`.env` and secret files:** If you create or touch a file containing
  credentials, API keys, or user data, add it to `.gitignore` immediately —
  before committing anything. Never commit secrets.
- **Build artifacts:** `dist/`, `build/`, `.next/`, `coverage/` are already in
  `.gitignore`. If you introduce a new artifact directory (e.g. `data/cache/`),
  add it.
- **Test scratch files:** If you create a temporary file for debugging (e.g.
  `query_vec.json`, `sim_test.sql`), delete it or add it to `.gitignore`.
  Do not leave scratch files in the working tree.
- **If unsure whether a file should be committed:** ask whether it's source
  code / config / docs (commit it) or a generated artifact (ignore it).

### Verification

```bash
# After all commits, this must show nothing:
git status --short
```

## 5. Git Workflow

- Commit and `git push` to `develop` after completing each implementation.
  One implementation = one commit is the rule.
- If asked to amend a past commit, rewrite the previous commit with
  `git commit --amend` and re-push with `git push --force-with-lease`.
  (If collaborators exist, confirm consent for history rewriting first.)
- Commit messages must be in English, briefly describing the changes and
  verification results.

## 6. Documentation Sync

- Update `README.md` (EN) and `README.ja.md` (JA) when a change affects
  documented user-facing behaviour, setup, configuration, environment
  variables, architecture, usage, deployment, or major features.
- Do not update README files for purely internal refactors, small visual
  polish, typo fixes, or implementation details that users do not need to know.
- Keep both README files aligned. The English and Japanese versions should
  not drift in meaning.
- When README updates are needed, include them in the same commit as the
  related implementation unless explicitly asked to split them.

## 7. Skill Creation After Implementation

When you get stuck or make a mistake during development, after all
implementation is complete, create a dedicated skill or edit an existing
skill to record it. This reduces diagnosis time when encountering the same
problem again.

## Checklist (run through at the end of every task)

- [ ] `bun run test` passes with zero failures
- [ ] `git status --short` shows nothing (all files committed or ignored)
- [ ] No secrets or `.env` files are staged
- [ ] Commit pushed to `develop`
- [ ] README.md and README.ja.md updated if user-facing behaviour changed
- [ ] Report includes: what changed, how verified, risks/follow-ups
