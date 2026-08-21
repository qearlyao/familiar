# Repository Instructions

## Upstream Check

Before implementing features in subsequent development, first verify the latest status of the upstream projects (`earendil-works/pi`) to avoid reinventing capabilities that upstream already added or is about to publish.

Use existing local reference clones when available; do not create fresh clones for routine research.

- `earendil-works/pi`: `/Users/qearl/pi`. Remote is `upstream`.

These directories are reference clones, not Familiar worktrees. It is fine to overwrite them with upstream state. Avoid cloning duplicate copies into `/tmp`; clean up any accidental duplicate upstream clones when noticed.

For high-value upstream/local file references, check `PLAN.md` section `## 6. Reference Index`

## Core Prompt

1. Fail Fast / Errors Never Pass Silently: Don’t hide logic in the code to swallow up errors and hide problems. If something goes wrong, you should let it out, otherwise you will never find the real problem.
2. Fix the Cause, Not the Symptom / Don't Paper Over Bugs: When a problem occurs, don't cover it up with various small fixes and targeted patches. The true root cause must be located and completely repaired. Placing paper over bugs will only cause the system to accumulate dangerous hidden diseases that you don't know about.
3. Make It Observable: Even if the problem is difficult to locate, never be lazy to make superficial repairs. Sufficient logs and observability should be added to the project to ensure that you have enough information to locate the problem next time it reoccurs. When the problem cannot be fixed, just tell me honestly that the information is insufficient and new logs need to be added, and don't pretend to fix it.
4. Design for Debugging / Traceability: Always pay attention to leaving enough troubleshooting logs on the critical path to ensure that every key node is traceable.
5. Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.

## Project Rules

- Flexibly and proactively utilize the agent team/sub-agents to enhance work efficiency; when necessary, please review the changes made by the sub-agents.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`), which self-clean when given the node:test `t` context.

## Commit Messages

Start the title with a conventional header so the log is grep-able. Format: `<type>(<scope>): <subject>` — lowercase, no trailing period, under ~70 chars. Scope is optional but useful in large files (`discord`, `memory`, `web`, etc.).

For nontrivial changes, follow the title with a blank line and a body. Explain the WHY and any non-obvious tradeoffs — the diff already shows the WHAT. Use bullets when the change has multiple coordinated pieces.
