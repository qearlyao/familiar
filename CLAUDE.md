# Core Prompt

Start from this baseline:

> Think how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

## Code Quality Bar

- Before coding, look for the simplest behavior-preserving structure. Prefer changes that delete incidental branches, helper layers, modes, or wrappers over changes that merely rearrange them.
- Keep feature logic in the canonical owner. Do not scatter one-off flags, special cases, or feature checks through unrelated shared paths.
- Make invariants explicit. Treat new ad-hoc conditionals, pass-through abstractions, cast-heavy boundaries, `any`/`unknown`, unnecessary optionality, and silent fallbacks as design smells.
- Keep files cohesive. Do not push a file from under 1000 lines to over 1000 lines without a strong structural reason; extract focused modules or helpers first.

Run these four lenses before writing code so `/simplify` review concerns do not become rework:

1. **Reuse**: grep for an existing helper before adding one. Shared utilities already cover common needs:
   - `src/util/fs.ts` — `isEnoent`, `readFileOrNull`, `atomicWriteJson`, `createWriteQueue`
   - `src/util/guards.ts` — `isRecord`, `readEnum`
   - `src/util/time.ts` — `formatLocalTimestamp`, `formatOffset`
   - `src/util/image-mime.ts` — `imageMimeTypeFromPath`, `sniffImageMimeType`
   - `src/memory/util.ts` — `positiveIntegerOrDefault`, `runInTransaction`
   - `src/models.ts` — `isThinkingLevel`, `parseModelRef`, `resolveProviderSetting`
   - Inline string manipulation, manual path handling, ad-hoc type guards, custom env checks, hand-rolled fetch where a client already exposes a REST handle: probably already a util or library call for it.
2. **Quality**: avoid redundant state, parameter sprawl, copy-paste variation, leaky abstractions, stringly typed code where constants or unions exist, nested conditionals 3+ deep, and comments that narrate what well-named code already says.
3. **Efficiency**: avoid repeated reads, duplicate API calls, N+1 work, missed concurrency on independent operations, startup or hot-path bloat, recurring no-op store updates, TOCTOU pre-existence checks, unbounded data structures, and overly broad reads.
4. **Cross-write atomicity**: when one logical operation writes to multiple places, make those writes commit together or roll back together. Persisted state must not claim a thing exists that was not successfully delivered.

## Project Rules

- Flexibly and proactively utilize the agent team/sub-agents to enhance work efficiency; when necessary, please review the changes made by the sub-agents.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`), which self-clean when given the node:test `t` context.