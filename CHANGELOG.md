# Changelog

## 0.9.3 - 2026-08-22

### Added

- Add WebUI controls for Discord and QQ reply modes, channel triggers, and collect debounce timing.

## 0.9.2 - 2026-08-22

### Added

- Add WebUI toggles for enabling or disabling Discord and QQ connections, with changes applied after restart.

### Fixed

- Restore steer-mode interruptions for the shared owner conversation across WebUI, Discord, and QQ.
- Use each subscriber's HTTPS origin as the Web Push VAPID subject so Apple push endpoints accept notifications.

## 0.9.1 - 2026-08-21

### Changed

- Share a single owner conversation across every platform. Discord DMs, QQ private messages, and the WebUI now resolve to one session, so the companion keeps one continuous thread with its owner across devices. Group channels stay per-platform.
- Keep Main Chat first in the session list and always the default, instead of shifting with `default_platform`.

### Breaking

- The owner conversation moved to a shared session, so **existing Main Chat history no longer appears in Familiar**. Previous per-platform DM logs stay on disk under `data/chat/` and can still be read, but the companion starts the shared session empty. Before upgrading, ask your companion to write down anything from recent conversations it wants to keep — diaries and memories are stored separately and carry over untouched, but the unwritten context of the current conversation does not.

## 0.9.0 - 2026-08-21

### Added

- Add an optional QQ platform through OneBot 11, compatible with NapCat and Lagrange, including private messages, group messages, mentions, and image attachments.
- Add Web Push notifications for completed WebUI replies, with persistent per-device subscriptions and a settings toggle.
- Generate images through a provider's native image endpoint: `openai-images` (`/images/generations` and `/images/edits`, also used by xAI and OpenAI-compatible gateways) and `google-images` (`models/{id}:generateContent`), alongside the existing OpenRouter shape.

### Changed

- Replace the single `image_gen.api` setting with an `[image_gen.apis]` table keyed by provider or `provider/model`, so the primary and fallback image models can use different endpoints. Endpoints and credentials keep coming from `models.base_urls` and `models.api_key_envs`, and a base URL that already has a path is used as written.
- Make platforms independent so Familiar can run WebUI-only or combine WebUI, Discord, and QQ sessions while sharing memory and conversation state.
- Add explicit `enabled` switches for Discord and QQ, plus `default_platform` for heartbeat and scheduled delivery.
- Accept audio transcription from any OpenAI-compatible endpoint through configurable provider, model, base URL, and API key settings.
- Make OpenCLI upgrades opt-in with `familiar upgrade --with-opencli`, and report the installed version transition plus restart hint after upgrades.
- Bump the pi dependency set to `0.84.2`, bringing upstream request retries, provider compatibility fixes, OpenAI Responses namespace preservation, and a native Mistral HTTP transport.

### Fixed

- Clean expired inbound media and derived attachments across the entire attachments directory.

## 0.8.2 - 2026-08-12

### Added

- Add an `mcporter` skill with setup and command examples for calling configured MCP servers from the CLI.

### Changed

- Bump the pi dependency set to `0.84.1`, adding Qwen Token Plan Individual and Baseten provider support plus upstream authentication, streaming, and tool-validation fixes.

### Fixed

- Recover stale per-channel chat leases after crashes or restarts while preserving exclusive ownership by a running Familiar process.
- Detect the active pointer type for WebUI send-key behavior so touchscreen laptops used with a mouse keep desktop Enter handling.
- Update Discord and WebUI dependencies past `undici` and `nanoid` security advisories.

### Breaking

- Remove the one-time memory migrations shipped in 0.8.0. If upgrading from a version below 0.8.0, install and start 0.8.0 or 0.8.1 first, run `familiar memory reindex --force`, and only then upgrade to 0.8.2.

## 0.8.1 - 2026-07-26

### Fixed

- Keep reader page attachments aligned to the actually visible text so long opening paragraphs no longer lose text at the top of the captured page.
- Apply live changes to `memory.lcm.new_session_retain_depth` on the next `/new` session rotation without requiring a restart.
- Reject EPUB stylesheets containing HTML comment openers and update PostCSS past its source-map path traversal advisory.

## 0.8.0 - 2026-07-26

### Added

- Add a shared EPUB library and paginated WebUI reader with durable reading state, annotations, and book-scoped conversations.
- Let reader margin messages attach the visible page or selected passage with chapter and offset citations.

### Changed

- Preserve sanitized publisher styles, separate EPUB navigation contents from the reading spine, and adapt supported ornaments to reader themes.
- Make memory reindexing resumable across interruptions, with transient embedding retries, concurrent-run protection, and `--restart` for deliberate clean rebuilds.
- Bump the pi dependency set to `0.82.1`, bringing refreshed model and provider metadata plus upstream retry, caching, and OpenAI Codex WebSocket fixes.

### Fixed

- Rebuild uploaded EPUB markup through strict allowlists so executable content cannot survive ingestion.
- Close and repair stale active memory segments so completed backfills do not block explicit pruning.

### Breaking

- The memory index schema has changed and upgraded indexes are marked for a full rebuild. **Run `familiar memory reindex --force` as soon as possible after upgrading to `0.8.0`, before relying on memory recall.** Reindexing is resumable; rerun the same command after an interruption, or use `--restart` only to discard partial progress and rebuild from scratch.
- Remove legacy manual agent endpoint fields and deprecated config aliases. Migrate `agent.api`, `agent.model_id`, `agent.base_url`, and `agent.api_key_env` to `agent.model` plus `models.providers`, `models.base_urls`, and `models.api_key_envs`; rename `agent.cacheRetention` to `agent.cache_retention` and `memory.embedding.api` to `memory.embedding.format`.

## 0.7.1 - 2026-07-21

### Added

- Add Cartesia as a second TTS provider, with live WebUI controls for provider, voice, and model settings.

### Changed

- Refresh the README as a product introduction with WebUI, mobile, and Discord screenshots while keeping setup and operator guidance easy to reach.
- Bump the pi dependency set to `0.80.10`, adding Kimi K3 and Grok 4.5 model support and improving Kimi thinking and deferred-tool compatibility.

### Fixed

- Serialize concurrent chat-history writes so large records cannot interleave and corrupt JSONL logs, especially on Windows.

## 0.7.0 - 2026-07-16

### Added

- Add a beginner and advanced setup guide covering first-time setup, mobile WebUI access, heartbeat, upgrades, and optional media and browser integrations.
- Add provider- and model-scoped OpenRouter routing preferences for Anthropic Messages requests, including normal agent turns and LCM summaries.
- Tell the companion where its configured diary directory is located.

### Changed

- Show only the thinking levels supported by the active model across Discord and the WebUI, including `max` where available.
- Keep heartbeat disabled in new workspace configuration until `HEARTBEAT.md` is reviewed, with clearer starter persona templates.
- Bump the pi dependency set to `0.80.7`, bringing current model and provider metadata plus upstream runtime fixes.

### Fixed

- Apply ambient diary recall setting changes on the next message without requiring a restart.
- Enforce ambient recall `min_query_length` against raw inbound text instead of author and timestamp prompt wrappers.
- Resolve uncataloged `xai/*` fallback models through xAI's standard API endpoint.

## 0.6.3 - 2026-07-09

### Added

- Add `time_range` metadata to injected `<from_earlier>` memory summary blocks so the model sees the local-time span each summary covers.

### Changed

- Keep the WebUI installable as a PWA while removing Web Push notifications and their settings.
- Use platform-specific composer Enter behavior: mobile Enter inserts a newline, while desktop Enter sends and Shift+Enter inserts a newline.
- Update the WebUI site favicon.

## 0.6.2 - 2026-07-06

### Added

- Add installable WebUI PWA support with a manifest, service worker, and full-bleed app icons.
- Add Web Push notifications for completed assistant replies when no authenticated WebUI tab is active on the channel, with per-device controls in settings.

### Fixed

- Keep WebUI session cookies sliding with authenticated activity instead of expiring by the original login time.
- Ignore Enter key submits while IME composition is active in WebUI inputs.

## 0.6.1 - 2026-07-03

### Fixed

- Keep marker-only silent text from splitting adjacent WebUI thinking and tool streams while a reply is still streaming.

## 0.6.0 - 2026-07-03

### Added

- Add context usage rings to the WebUI session picker so sessions show recent token use against the active model window.
- Let expanded WebUI thinking and tool event streams collapse directly from the open body.

### Changed

- Bump the pi dependency set to `0.80.3`, bringing refreshed model metadata and upstream runtime fixes.
- Treat `[[FAMILIAR_SILENT]]` anywhere in an assistant reply as silence, keeping the private reflection out of Discord while rendering it muted in the WebUI.

### Fixed

- Route DM-backed WebUI sends through the same steer path used by Discord DMs when the active turn is still running.
- Remove the light-mode audio attachment bloom hotspot.

## 0.5.7 - 2026-06-24

### Added

- Add explicit Anthropic-compatible provider metadata for custom providers that need upstream session-affinity and tool-field compatibility behavior.

### Changed

- Bump the pi dependency set to `0.80.2` and move legacy pi-ai imports to the temporary compatibility entrypoint required by the 0.80 series.

## 0.5.6 - 2026-06-23

### Added

- Add WebUI voice recording from the composer, including recording controls and browser audio upload handling.
- Add WebUI editing for the latest assistant reply, with persisted history and replay support.

### Changed

- Bump the pi dependency set to `0.79.10`, bringing upstream AI reasoning preservation and coding-agent fixes.

### Fixed

- Keep retry, edit, and delete actions targeting the full failed assistant turn instead of an error tail.
- Allow manually added WebUI models to use configured custom providers.
- Align audio attachment transcripts in WebUI messages.

## 0.5.5 - 2026-06-22

### Fixed

- Forward Familiar's stable owner id to Anthropic requests as `metadata.user_id` so provider-specific cache and abuse-tracking hints are preserved.

## 0.5.4 - 2026-06-21

### Added

- Add custom model provider configuration, with per-model provider overrides plus endpoint and API key wiring for non-default providers.

### Changed

- Bump the pi dependency set to `0.79.9`, picking up the current upstream provider metadata and runtime updates.

### Fixed

- Keep the latest assistant retry and delete actions disabled while a send or recovery is in flight, with fallback recovery so stale streams do not leave the UI stuck.
- Prevent diary list text clipping in the WebUI.

## 0.5.3 - 2026-06-14

### Added

- Stream Gemini video uploads through the Files API instead of reading whole video files into memory.
- Add a video-only Gemini base URL override for deployments where the shared Google model endpoint cannot handle Files API uploads.

### Fixed

- Align WebUI video attachment summaries with the rest of the message content.

## 0.5.2 - 2026-06-14

### Added

- Add browser-harness target configuration for local browsers, configured CDP endpoints, and Browser Use cloud provisioning.
- Add WebUI composer slash-command completion and route recognized attachmentless slash commands through the control endpoint.

### Changed

- Bump the pi dependency set to `0.79.3`, bringing upstream provider metadata fixes including safer OpenAI/Codex context-window limits.

### Fixed

- Keep manual retry targets chained to their original conversation branch.

## 0.5.1 - 2026-06-13

### Changed

- Update the bundled example config to use `anthropic/claude-fable-5` as the default Claude model reference.
- Bump the pi dependency set to `0.79.1`, bringing newer provider metadata, Claude Fable 5 support, and upstream SDK/runtime fixes.

### Fixed

- Recover stale WebUI realtime streams after long idle periods or proxy/browser connection timeouts.
- Give WebUI chat and workspace pages more room on wide low-DPI displays without changing the existing Retina laptop layout.
- Restore the custom gallery audio progress bar while keeping accessible range input behavior.

## 0.5.0 - 2026-06-09

### Added

- Add a WebUI Skills room for browsing and editing workspace skills, previewing Markdown, toggling whether each skill is listed for Familiar, and surfacing skill diagnostics.
- Add a WebUI Makings gallery for generated images and audio, with grouped media tiles, lightbox viewing, audio playback, and per-item notes.
- Group image attachments in WebUI chat messages so multi-image outputs read as a single visual set.

### Changed

- Share the Markdown editor shell between Keepsakes and Skills for a more consistent edit/preview workflow.
- Move gallery audio playback into the lightbox so the Makings grid stays compact.

### Fixed

- Keep right-aligned WebUI media messages on a simpler CSS-driven layout that avoids fragile measurement behavior.
- Keep gallery note edits local until saved and validate note writes against real generated media items.

## 0.4.5 - 2026-06-06

### Added

- Add a WebUI keepsakes room for editing `SOUL.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, and `CONTACT.md` from the browser, with per-note draft retention, edit/preview modes, and companion-aware save feedback.
- Add weekly service log rotation for installed Familiar services.

### Changed

- Align the Diaries and Keepsakes room headers around the same warm, compact visual treatment.
- Share the WebUI Markdown renderer across chat, diaries, and keepsakes so prose, links, code, lists, tables, and media render more consistently.

### Fixed

- Prevent oversized chat media preview triggers from breaking the composer layout.
- Prevent long WebUI chat content from causing horizontal overflow.

## 0.4.2 - 2026-06-06

### Fixed

- Keep WebUI history loading after moving a workspace between machines when older attachments still point at stale local paths.
- Preserve compact right-aligned WebUI user message width when Markdown rendering adds inline wrappers.

## 0.4.1 - 2026-06-05

### Added

- Add short `familiar start`, `familiar stop`, and `familiar restart` service commands for installed macOS and Linux user services.
- Preserve ordered sticker drafts in the WebUI composer so image/sticker snippets stay in place while editing mixed text and media messages.

### Fixed

- Hug right-aligned WebUI user message bubbles to their longest rendered line for cleaner wrapping.

## 0.4.0 - 2026-06-05

### Added

- Add bearer-token WebUI login with HttpOnly device-session cookies, persistent device history, logout, device revocation, and sign-out-others controls.
- Add a WebUI room switcher with Chat and Diaries rooms while keeping the chat session mounted across page changes.
- Add a WebUI diaries reader for `memories/diaries/YYYY-MM-DD.md`, with dated excerpts, Markdown prose, refresh/empty/loading states, and a mobile master-detail layout.
- Render WebUI chat replies as Markdown, including lists, code, links, tables, images, and existing `meme: ... (url)` media links.

### Changed

- Document loopback reverse-proxy bearer deployments for the WebUI and trust forwarded IP/proto headers only from loopback proxy connections.
- Raise inbound attachment limits to 32MB per file and 96MB total, accept QuickTime/MOV videos, and route video understanding through Gemini Files API for large uploads.
- Keep attachment summaries and media-understanding failure notes attached to attachment metadata instead of mixing them into user-authored WebUI text.
- Polish WebUI settings and navigation, including clearer settings sections, compact thinking controls, inline page navigation, and a responsive diary reader.
- Ask heartbeat-written diary entries to include meaningful Markdown titles so the WebUI diaries list shows readable day names.

### Fixed

- Restore Discord delivery for generated attachments by using direct multipart uploads with a longer per-upload timeout.
- Surface WebUI send failures in the composer and restore the unsent draft when a send attempt fails.
- Release the WebUI composer after Discord or heartbeat turns finish, even when no separate idle status frame arrives.
- Use cross-platform spawning for browser helpers so Windows `.cmd` paths and special characters in arguments work reliably.

## 0.3.0 - 2026-06-02

### Added

- Run the WebUI without a live Discord connection, including Discord-outage boot paths and no-cached-identity startup.
- Add live WebUI model-error notices in the message timeline.
- Add WebUI retry and delete actions for the latest assistant reply.
- Preview chat images inline in the WebUI composer.
- Add `familiar --version` and `familiar --help`.
- Persist the Discord owner identity cache after DM resolution.

### Changed

- Bump the pi dependency set to `0.78.0`.
- Update the default Claude Opus example model to `claude-opus-4-8`.
- Improve WebUI history loading with paginated transcript reads.
- Make WebUI config commits atomic across config and override writes.
- Keep Discord attachment delivery tied to direct REST delivery, awaited sends, and persisted message IDs.
- Cache static WebUI paths, attachment roots, trigger lookups, and hot-path prompt/transcript reads more efficiently.
- Consolidate WebUI config inputs, request state, event streams, and error handling.

### Fixed

- Install OpenCLI during `familiar upgrade` when browser helper setup is requested.
- Serve built WebUI assets correctly from the backend.
- Return `400` or `413` for malformed WebUI request bodies instead of `500`.
- Hard-abort WebUI stop requests instead of leaving turns running.
- Hide retry controls until a message has an interaction.
- Wrap long URLs and right-anchor user messages in the WebUI.
- Prevent WebUI dialog focus outlines after close and quiet detector animation warnings.
- Stop LCM async queues from becoming poisoned after a failed link.
- Release memory subscriptions while holding the chat-log lock.
- Split Discord messages without breaking surrogate pairs and make reply-fallback logging accurate.
- Bump WebUI `qs` past the security advisory.

### Maintenance

- Decompose the large Discord, Web, web-tool, config, agent, and LCM store modules into focused owners while preserving compatibility exports.
- Extract shared agent-core, runtime-manager, scheduler-runner, agent-work-queue, transcript-log, owner-identity, and Web stream/event plumbing.
- Share test helpers for environment setup, media fixtures, memory fakes, transcript replay, Web HTTP handling, runtime-manager cleanup, and Discord chunking.
- Reduce duplicate backend hot-path code across browser tools, web tools, memory index storage, scheduler prompts, and agent payload normalization.

## 0.2.5 - 2026-05-28

### Changed

- Accept `~/` paths in `image_gen` reference images.
- Recover hosted image outputs returned as Markdown image links, with remote image fetches capped at 12MB.
- Harden OpenCLI site command discovery when JSON metadata is missing or malformed.

### Fixed

- Fix atomic JSON writes on Windows by fsyncing the parent directory only when the platform supports it.

### Maintenance

- Add an opt-in image generation fetch trace preloader for debugging OpenRouter-style image responses.
- Expand focused coverage for image generation recovery, OpenCLI site command discovery, and atomic JSON writes.

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
