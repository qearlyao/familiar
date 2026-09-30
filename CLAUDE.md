# Core Prompt

- Keep files cohesive. Do not push a file from under 1000 lines to over 1000 lines without a strong structural reason; extract focused modules or helpers first.
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`), which self-clean when given the node:test `t` context.

## Upstream Check

Use existing local reference clones when available; do not create fresh clones for routine research.

- `earendil-works/pi`: `/Users/qearl/pi`. Remote is `upstream`.

These directories are reference clones, not Familiar worktrees. It is fine to overwrite them with upstream state.