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

## Code Quality Bar

- Before coding, look for the simplest behavior-preserving structure. Prefer changes that delete incidental branches, helper layers, modes, or wrappers over changes that merely rearrange them.
- Keep feature logic in the canonical owner and reuse existing helpers. Do not scatter one-off flags, special cases, or feature checks through unrelated shared paths.
- Treat new ad-hoc conditionals, pass-through abstractions, cast-heavy boundaries, `any`/`unknown`, unnecessary optionality, and silent fallbacks as design smells. Make the invariant explicit or isolate the concept behind a focused helper/model.
- Keep files cohesive. Do not push a file from under 1000 lines to over 1000 lines without a strong structural reason; extract focused modules or helpers first.
- Separate orchestration from business logic. Parallelize independent work when that also makes the flow clearer, and make related state updates atomic when partial state would be harder to reason about.

## Pre-Write Checks

Run these four lenses against code you're about to write — they're the same ones the `/simplify` review uses, applied earlier so they don't become rework.

1. **Reuse** — before writing a new helper, grep for an existing one. Shared utilities already cover common needs:
   - `src/util/fs.ts` — `isEnoent`, `readFileOrNull`, `atomicWriteJson`, `createWriteQueue`
   - `src/util/guards.ts` — `isRecord`, `readEnum`
   - `src/util/time.ts` — `formatLocalTimestamp`, `formatOffset`
   - `src/util/image-mime.ts` — `imageMimeTypeFromPath`, `sniffImageMimeType`
   - `src/memory/util.ts` — `positiveIntegerOrDefault`, `runInTransaction`
   - `src/models.ts` — `isThinkingLevel`, `parseModelRef`, `resolveProviderSetting`
   - Inline string manipulation, manual path handling, ad-hoc type guards, custom env checks, hand-rolled fetch where a client already exposes a REST handle: probably already a util or library call for it.
2. **Quality** — no redundant state (cached values that could be derived, observers that could be direct calls); no parameter sprawl (generalize or restructure instead of adding the seventh param); no copy-paste with slight variation (unify with a shared helper); no leaky abstractions; no stringly-typed code where constants/string unions/branded types exist; no nested conditionals 3+ deep (flatten with early returns, guard clauses, or lookup tables); no comments narrating WHAT the code does or referencing the task/caller (well-named identifiers carry the WHAT — keep only non-obvious WHY).
3. **Efficiency** — no redundant work (repeated file reads, duplicate API calls, N+1); no missed concurrency on independent ops; no hot-path bloat in startup or per-request paths; no recurring no-op store updates (add change-detection guards); no TOCTOU pre-existence checks (operate directly, handle the error); no unbounded data structures; no overly broad reads (load only what you filter for).
4. **Cross-write atomicity** — when one logical operation writes to multiple places (e.g. external service + durable record), they must commit together or roll back together. Persisted state must not claim a thing exists that wasn't successfully delivered.

## Project Rules

- Add concise comments that explain the non-obvious intent, invariants, or failure mode.
- Flexibly and proactively utilize the agent team/sub-agents to enhance work efficiency; when necessary, please review the changes made by the sub-agents.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`), which self-clean when given the node:test `t` context.

## Commit Messages

Start the title with a conventional header so the log is grep-able. Format: `<type>(<scope>): <subject>` — lowercase, no trailing period, under ~70 chars. Scope is optional but useful in large files (`discord`, `memory`, `web`, etc.).

Allowed types:

- `feat:` new user-visible feature
- `fix:` bug fix
- `refactor:` structural change with no behavior change
- `perf:` performance improvement
- `docs:` documentation only
- `test:` test changes only
- `chore:` tooling, deps, repo housekeeping

For nontrivial changes, follow the title with a blank line and a body. Explain the WHY and any non-obvious tradeoffs — the diff already shows the WHAT. Use bullets when the change has multiple coordinated pieces.

Example:

```text
refactor(discord): post attachments via client.rest, await delivery, persist ids

- Switch the attachment path off raw FormData/fetch onto discord.js's
  REST handle with RawFile, so the runtime owns retry/auth and the
  hop stays inside the client.
- Await delivery before persisting messageIds; never claim attachment
  delivery that didn't happen.
- Thread AbortSignal.timeout through the post so a stuck upload can
  be cancelled by the heartbeat slot.
```
