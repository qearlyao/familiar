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

## Project Rules

- Add concise comments that explain the non-obvious intent, invariants, or failure mode.
- Flexibly and proactively utilize the agent team/sub-agents to enhance work efficiency; when necessary, please review the changes made by the sub-agents.
- Any test that creates temporary files or directories must register cleanup in the same test (`t.after(() => rm(dir, { recursive: true, force: true }))`). Prefer the helpers in `test/helpers.ts` (`createTempDataDir`, `createWorkspace`, `configWithDataDir`) — they self-clean when given the node:test `t` context.

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
