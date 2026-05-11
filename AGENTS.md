# Repository Instructions

## Upstream Check

Before implementing features in subsequent development, first verify the latest status of the upstream projects (`earendil-works/pi` and relevant `pi-chat` refs) to avoid reinventing capabilities that upstream already added or is about to publish.

Use the existing local reference clones; do not create fresh clones for routine research.

- `earendil-works/pi`: `/Users/qearl/pi-mono` (historical directory name). Remote is `upstream`.
- `earendil-works/pi-chat`: `/tmp/pi-chat`. Remote is `origin`.

When latest upstream context is needed, update these references in place:

```sh
git -C /Users/qearl/pi-mono fetch --prune upstream
git -C /Users/qearl/pi-mono reset --hard upstream/main
git -C /tmp/pi-chat fetch --prune origin
git -C /tmp/pi-chat reset --hard origin/main
```

These directories are reference clones, not Familiar worktrees. It is fine to overwrite them with upstream state. Avoid cloning duplicate copies into `/tmp`; clean up any accidental duplicate upstream clones when noticed.

For high-value upstream/local file references, check `PLAN.md` section `## 6. Reference Index`

## Project Rules

- For complex code, add concise comments that explain the non-obvious intent, invariants, or failure mode. Do not comment trivial assignments.
- For broad reviews, large migrations, or multi-part implementation work, use an agent team when helpful and delegate focused subtasks to subagents to improve speed and coverage.

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
