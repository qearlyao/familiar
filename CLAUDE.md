# Core Prompt

- Before coding, look for the simplest behavior-preserving structure. Prefer changes that delete incidental branches, helper layers, modes, or wrappers over changes that merely rearrange them.
- Keep feature logic in the canonical owner. Do not scatter one-off flags, special cases, or feature checks through unrelated shared paths.
- Make invariants explicit. Treat new ad-hoc conditionals, pass-through abstractions, cast-heavy boundaries, `any`/`unknown`, unnecessary optionality, and silent fallbacks as design smells.
- Keep files cohesive. Do not push a file from under 1000 lines to over 1000 lines without a strong structural reason; extract focused modules or helpers first.
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.

## Project Rules

- Flexibly and proactively utilize the agent team/sub-agents to enhance work efficiency; when necessary, please review the changes made by the sub-agents.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`), which self-clean when given the node:test `t` context.