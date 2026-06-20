# Repository Instructions

## Upstream Check

Before implementing features in subsequent development, first verify the latest status of the upstream projects (`earendil-works/pi` and relevant `pi-chat` refs) to avoid reinventing capabilities that upstream already added or is about to publish.

Use existing local reference clones when available; do not create fresh clones for routine research.

- `earendil-works/pi`: `/Users/qearl/pi`. Remote is `upstream`.
- `earendil-works/pi-chat`: `/Users/qearl/pi-chat`. Remote is `origin`.

These directories are reference clones, not Familiar worktrees. It is fine to overwrite them with upstream state. Avoid cloning duplicate copies into `/tmp`; clean up any accidental duplicate upstream clones when noticed.

For high-value upstream/local file references, check `PLAN.md` section `## 6. Reference Index`

## Core Prompt

Start from this baseline:

> Think how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

Run these four lenses before writing code so `/simplify` review concerns do not become rework:

1. **Reuse**: rg for an existing helper before adding one. Shared utilities already cover common needs:
   - `src/util/fs.ts` — `isEnoent`, `readFileOrNull`, `atomicWriteJson`, `createWriteQueue`
   - `src/util/guards.ts` — `isRecord`, `readEnum`
   - `src/util/time.ts` — `formatLocalTimestamp`, `formatOffset`
   - `src/util/image-mime.ts` — `imageMimeTypeFromPath`, `sniffImageMimeType`
   - `src/memory/util.ts` — `positiveIntegerOrDefault`, `runInTransaction`
   - `src/models.ts` — `isThinkingLevel`, `parseModelRef`, `resolveProviderSetting`
   - Inline string manipulation, manual path handling, ad-hoc type guards, custom env checks, hand-rolled fetch where a client already exposes a REST handle: probably already a util or library call for it.
2. **Quality**: avoid redundant state, parameter sprawl, copy-paste variation, leaky abstractions, stringly typed code where constants or unions exist, nested conditionals 3+ deep.
3. **Efficiency**: avoid repeated reads, duplicate API calls, N+1 work, missed concurrency on independent operations, startup or hot-path bloat, recurring no-op store updates, TOCTOU pre-existence checks, unbounded data structures, and overly broad reads.
4. **Cross-write atomicity**: when one logical operation writes to multiple places, make those writes commit together or roll back together. Persisted state must not claim a thing exists that was not successfully delivered.

## Project Rules

- Flexibly and proactively utilize the agent team/sub-agents to enhance work efficiency; when necessary, please review the changes made by the sub-agents.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`), which self-clean when given the node:test `t` context.

## Commit Messages

Start the title with a conventional header so the log is grep-able. Format: `<type>(<scope>): <subject>` — lowercase, no trailing period, under ~70 chars. Scope is optional but useful in large files (`discord`, `memory`, `web`, etc.).

For nontrivial changes, follow the title with a blank line and a body. Explain the WHY and any non-obvious tradeoffs — the diff already shows the WHAT. Use bullets when the change has multiple coordinated pieces.
