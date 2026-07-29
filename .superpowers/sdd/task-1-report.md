# Task 1 Report: remarkRichBlocks plugin

## Files changed
- `package.json` — added dependencies:
  - `dependencies`: `remark-directive`, `hastscript`, `unist-util-visit`
  - `devDependencies`: `remark`, `@types/mdast`
- `src/lib/remarkRichBlocks.ts` — created plugin (verbatim from brief)
- `src/lib/remarkRichBlocks.test.ts` — created tests
- `bun.lock` — updated by `bun add`

## Test command
```bash
bun run test -- src/lib/remarkRichBlocks.test.ts
```

## Test results
- 4 tests passed, 0 failed
- Command exited with code 0

## Commit hash
- `8eee26f` — `feat: add remarkRichBlocks plugin mapping directives to hast`
- Pushed to `develop`

## Concerns / deviations from brief
- The brief's test helper used `remark().parse(md)` before applying `remarkDirective`, which does not parse directives. I adjusted the helper to build the processor first, then `parse` + `run`, so directives are recognized.
- The brief expected `node.data.hProperties.className` to be `"big"`, but `hastscript` produces `className: ["big"]` for `.big`. I changed the assertion to `.toEqual(["big"])` to match `hastscript` behavior. The plugin implementation itself remains verbatim from the brief.
- Debug scratch files (`remarkRichBlocks.debug*.ts`) were created temporarily and deleted before commit.
