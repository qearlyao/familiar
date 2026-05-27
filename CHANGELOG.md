# Changelog

## 0.2.4 - 2026-05-27

### Added

- Add a step-based WebUI timeline that preserves interleaved thinking, tool calls, and text during live streaming and history reloads.
- Support pasted and dropped file attachments in the WebUI composer.
- Include stored attachment paths and bounded plain-text previews in prompt context so non-media attachments are visible to the agent without dumping full files.
- Accept valid UTF-8 text attachments, including non-ASCII Discord `message.txt` uploads.

### Changed

- Rename Familiar's open-web tools to `search_web` and `fetch_web` to avoid provider tool-name collisions.
- Keep browser tool success output focused on page content while preserving command diagnostics in failure/details paths.
- Refresh workspace defaults after `familiar upgrade [workspace]` without overwriting existing config, Markdown, or skills.
- Keep LCM restart replay summary-only and preserve raw transcript history as the canonical restart record.
- Refine heartbeat guidance to make silent turns less strict and more conversational.

### Fixed

- Preserve heartbeat-triggered silent turns in WebUI history and render silent markers inline with the timeline.
- Hide local text attachment previews from visible WebUI message text while retaining attachment cards and prompt context.
- Fix WebUI/backend edge cases around malformed cookies, stale WebSocket channel lookups, page-cache TTL/LRU behavior, and in-flight message cleanup.
- Improve memory hot-path performance during retrieval, compaction, indexing, backfill, and retention.
- Stabilize browser, hot-reload, memory, WebUI history, and attachment tests with self-cleaning temporary workspaces.

### Maintenance

- Consolidate shared filesystem, guard, time, image MIME, model, config, and memory helper logic.
- Reduce duplicated model/config handling and shared utility code across backend modules.

## 0.2.3 - 2026-05-24

### Changed

- Pin the pi dependency set to `0.75.5` and publish `npm-shrinkwrap.json` so global upgrades use the tested dependency graph.
- Send Discord generated audio attachments through direct REST multipart delivery while keeping the text reply path unblocked.
- Render silent WebUI replies as real silent turns instead of showing the marker text.

### Fixed

- Fix Windows Discord TTS delivery with pi `0.75.5`; generated audio now reaches Discord without leaving the agent stuck typing.
- Preserve recovery from jobs that wrote an outbound record before a crash but did not append `job_completed`.
- Add byte-range support for served WebUI attachments so generated audio metadata requests work reliably.

## 0.2.2 - 2026-05-22

### Fixed

- Pre-read Discord attachments to Buffer to fix the Windows TTS hang.
- Fix Windows OpenCLI cmd shim spawning for spaced `.cmd` paths.

## 0.2.1 - 2026-05-22

### Changed

- Count provider replay signatures in LCM leaf-compaction pressure while keeping signature metadata out of summary prompts.
- Improve payload diff inspection for current `<from_earlier>` LCM summaries.
- Refresh the WebUI favicon.

### Fixed

- Fix browser helper spawning on Windows, including `.cmd` OpenCLI paths.
- Fix WebUI meme rendering when meme labels contain parentheses.
- Fix README credits and add upstream memory/LCM references.

## 0.2.0 - 2026-05-21

### Added

- Add runtime config registry and WebUI controls for heartbeat, memory, image generation, model management, and per-channel overrides, mostly across `3d1246a`, `295db84`, `ae36e65`, and `3db2ea0`.
- Add contact-note support plus the new memes skill and related WebUI polish, spanning `158b331`, `3ed19ff`, `d7a5680`, and `d662269`.

### Changed

- Expand browser site command handling and model override plumbing, with site-command exposure and OpenCLI trace hints landing in `d01841f` and `538b006`.
- Refine WebUI layout and streaming behavior for the latest config and media surfaces, including `01ca43e`, `9900f7c`, `73017d2`, `eda2691`, `fe889b6`, and `50b3549`.
- Tidy release-adjacent config and dependency churn, including `3eb67f6`, `2274591`, and `bfb0010`.

### Fixed

- Include `CONTACT.md` in the published package so fresh installs can initialize workspaces without missing-file errors.
- Reapply Web UI config overrides after reload, so settings changes survive a base config refresh.
- Resolve the meme catalog from the workspace path instead of `process.cwd()`, so the meme picker works outside the repo root.
- Remove the published `browser.sites.*` config shape and reject it as a breaking change instead of carrying legacy compatibility forward.

### Breaking

- Remove the legacy `browser.sites.*` config shape entirely; browser site allowlisting now uses the current top-level browser settings only.

## 0.1.2 - 2026-05-18

### Changed

- Refresh missing workspace defaults during installer runs, so existing workspaces can receive newly bundled skills without overwriting local files.
- Make optional browser-helper setup friendlier by prompting to install missing `uv` or Python 3.11+ dependencies, with non-interactive install flags for scripted setup.
- Document supported installer options for macOS/Linux and Windows PowerShell.

## 0.1.1 - 2026-05-18

### Added

- Add macOS/Linux and Windows installer scripts that check Node/npm, install `@qearlyao/familiar@latest`, and initialize the default workspace.
- Add optional installer browser-helper setup for OpenCLI and browser-harness. The browser-harness path checks for `git`, `uv`, and Python 3.11+ before cloning and installing from upstream.
- Add automatic hot reload for workspace config, `.env`, persona files, and skills.
- Add `/reload` and `/restart` control handling for Discord and WebUI sessions.
- Add macOS user `launchd` and Linux user `systemd` service management through `familiar install-service`, `familiar uninstall-service`, and `familiar status`.
- Add `familiar upgrade` for updating the global npm package.
- Seed the bundled `image-gen` skill during `familiar init`.

### Changed

- `familiar init` now fills missing default files and directories without overwriting existing workspace files.
- Node.js 22 remains supported, while Node.js 24 is documented as the recommended and primary tested runtime.
- Browser screenshots are documented as workspace-scoped generated attachments.

### Fixed

- Avoid exiting too quickly after `/restart`, giving Discord and WebUI acknowledgements time to send.
- Prevent new sessions from being created against stale config while a reload is in progress.
- Reduce unnecessary skill-directory watcher refreshes during ordinary file saves.
- Harden installer packaging and help output, including a warning for custom npm package specs.

## 0.1.0 - 2026-05-17

First public release of Familiar.

### Added

- Discord-first single-owner companion daemon with per-channel runtime state, append-only logs, control commands, and model/thinking overrides.
- Local WebUI with shared Discord sessions, live text/thinking/tool streaming, session picker, settings controls, attachments, and generated media playback.
- Workspace initialization through `familiar init`, with `config.toml`, `.env`, persona files, data directories, and memory directories.
- Native open-web tools: `web_search` and `web_fetch`, with provider routing, page cache, URL safety guards, and untrusted-content wrapping.
- Media intake for Discord/Web attachments, including image prompt assembly, audio transcription, video understanding, and bounded image derivatives.
- TTS and image generation tools with generated-media storage, retention, and Discord/Web delivery.
- Skills v0 through workspace `skills/` discovery and lazy instruction loading.
- Memory foundation with shared SQLite FTS/vector index, LCM context compaction, `memory_recall`, `memory_open`, diary indexing, ambient diary recall, doctor/reindex/backfill/prune/backup operator commands, and restart-safe LCM state.
- Heartbeat and cron scheduling through in-band prompts with durable scheduler state and logs.
- Optional real-browser backend plumbing through OpenCLI and browser-harness, behind a disabled-by-default `browser` tool.

### Notes

- The package publishes as `@qearlyao/familiar`; install with `npm install -g @qearlyao/familiar@latest`.
- Browser helpers are optional; the installer can set up OpenCLI and browser-harness with `--with-browser`.
