# Repository Instructions

## Upstream Check

Before implementing features in subsequent development, first verify the latest status of the upstream projects (`earendil-works/pi` and relevant `pi-chat` refs) to avoid reinventing capabilities that upstream already added or is about to publish.

Use existing local reference clones when available; do not create fresh clones for routine research.

- `earendil-works/pi`: `/Users/qearl/pi`. Remote is `upstream`.
- `earendil-works/pi-chat`: `/Users/qearl/pi-chat`. Remote is `origin`.

When latest upstream context is needed, update these references in place:

```sh
git -C /Users/qearl/pi fetch --prune upstream
git -C /Users/qearl/pi reset --hard upstream/main
git -C /Users/qearl/pi-chat fetch --prune origin
git -C /Users/qearl/pi-chat reset --hard origin/main
```

These directories are reference clones, not Familiar worktrees. It is fine to overwrite them with upstream state. Avoid cloning duplicate copies into `/tmp`; clean up any accidental duplicate upstream clones when noticed.

For high-value upstream/local file references, check `PLAN.md` section `## 6. Reference Index`

## Core Prompt

Start from this baseline:

> Think how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

## Code Quality Bar

- Before coding, look for the simplest behavior-preserving structure. Prefer changes that delete incidental branches, helper layers, modes, or wrappers over changes that merely rearrange them.
- Keep feature logic in the canonical owner and reuse existing helpers. Do not scatter one-off flags, special cases, or feature checks through unrelated shared paths.
- Treat new ad-hoc conditionals, pass-through abstractions, cast-heavy boundaries, `any`/`unknown`, unnecessary optionality, and silent fallbacks as design smells. Make the invariant explicit or isolate the concept behind a focused helper/model.
- Keep files cohesive. Do not push a file from under 1000 lines to over 1000 lines without a strong structural reason; extract focused modules or helpers first.
- Separate orchestration from business logic. Parallelize independent work when that also makes the flow clearer, and make related state updates atomic when partial state would be harder to reason about.

## Project Rules

- Add concise comments that explain the non-obvious intent, invariants, or failure mode.
- Flexibly and proactively utilize the agent team/sub-agents to enhance work efficiency; when necessary, please review the changes made by the sub-agents.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`), which self-clean when given the node:test `t` context.

## Commit Messages

When writing commit messages for this repo, prefer the detailed style, example shape:

```text
Add namespaced Discord slash controls

- Register /familiar without bulk-overwriting existing bot commands
- Add native status/stop/new/model/thinking/channel-trigger controls
- Support model autocomplete from models.allow
- Reply ephemerally for native control acknowledgements
- Keep legacy text slash commands as fallback
```
