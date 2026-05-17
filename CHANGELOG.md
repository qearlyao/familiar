# Changelog

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
- Browser helpers are optional and must be installed separately: `@jackwener/opencli` and/or `browser-harness`.
- `install-service`, `status`, and `upgrade` are reserved CLI commands but are not implemented yet.
