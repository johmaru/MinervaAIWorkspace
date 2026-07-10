---
name: readme-update-guide
description: >
  Procedure for keeping README.md and README.ja.md in sync with recent
  code changes. Read this before updating the READMEs — it defines what
  to check, where to look, and the dual-file parity rule.
origin: session-readme-sync
---

# Skill: README Update Guide

Procedure for keeping both READMEs current after feature work. Read this before editing READMEs.

## When to use

- Triggered by "README更新して" or any request to update the READMEs.
- After a feature ships without a README update.
- Before a release when READMEs may have drifted from code.

## Dual-file parity rule

`README.md` (en) and `README.ja.md` (ja) MUST stay in sync. Every feature, config row, or usage instruction added to one file is mirrored in the other. The user writes in Japanese; ja parity is not optional.

## Change discovery procedure

Run these commands to find what changed since the last README update:

```bash
# List commits since the last README touch
git log --oneline $(git log -1 --format="%H" -- README.md)..HEAD

# Find the last README commit date
git log -1 --format="%ci" -- README.md

# Commit bodies + file stats (reverse chronological = oldest first)
git log --format="=== %h %s ===%n%b" --stat $(git log -1 --format="%H" -- README.md)..HEAD --reverse

# Uncommitted work
git status --short
git diff --stat HEAD

# New env vars (need config-table rows in BOTH READMEs)
git diff $(git log -1 --format="%H" -- README.md)..HEAD -- .env.example
```

## README section map

| Change type | Target section | Both files |
|---|---|---|
| New user-visible feature | **Features** list | Yes |
| New env var | **Configuration** table | Yes |
| New usage instruction | **Usage** section | Yes |
| New API route or page | Features + Usage (if user-facing) | Yes |

## Stale-content check

Before adding, grep the README for the topic keyword. If an existing description is stale (e.g. `AUTH_URL` was rewritten in `.env.example` but not in README), update the stale text in place rather than appending a duplicate.

## Verification

1. Grep the new keyword in both READMEs to confirm parity:
   ```bash
   grep -c "REGISTRATION_LOCKED" README.md README.ja.md
   ```
   Both must return the same count.
2. Grep for old/stale wording to confirm removal:
   ```bash
   grep "must match the Notion OAuth" README.md README.ja.md
   ```
   Should return nothing.
3. Visually scan the Features/Config/Usage sections in both files for completeness.
