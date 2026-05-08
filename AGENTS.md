# Repository Instructions

## Upstream Check

Before implementing features in subsequent development, first verify the latest status of the upstream projects (`earendil-works/pi` and relevant `pi-chat` refs) to avoid reinventing capabilities that upstream already added or is about to publish.

## Commit Messages

When writing commit messages for this repo, prefer the detailed style:

- Use a specific imperative summary line.
- Add a blank line, then bullets for the concrete changes.
- Mention behavior, persistence/config changes, verification-relevant details, and important caveats when they matter.
- Prefer useful detail over short mystery labels.

Example shape:

```text
Add namespaced Discord slash controls

- Register /familiar without bulk-overwriting existing bot commands
- Add native status/stop/new/model/thinking/channel-trigger controls
- Support model autocomplete from models.allow
- Reply ephemerally for native control acknowledgements
- Keep legacy text slash commands as fallback
```
