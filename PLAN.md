# familiar plan

Personal companion agent. Discord-first today, WebUI-first over time. Single-owner,
always-on, workspace-based, reactive in v0, with proactive scheduling and
pluggable browser/activity backends growing from the same runtime.

This is the session-start operating plan. Keep it compact: completed work is
archived by capability, active work stays in one backlog, and detailed history
lives in git.

## 0. Current Snapshot

Core v0 is largely landed.

- Runtime: direct upstream `Agent`, Discord adapter, WebUI adapter, append-only
  logs, per-channel settings, control commands, payload/transcript logging.
- Tools: upstream `bash`/`read`/`write`/`edit`; Familiar-owned `web_search`,
  `web_fetch`, `tts`, `image_gen`, `memory_recall`, `memory_open`, and compact
  `browser`.
- Memory: shared SQLite FTS/vector index, LCM context compaction, diary indexing,
  ambient diary recall, memory doctor/backfill/reindex/prune/backup.
- Scheduling: heartbeat and cron deliver in-band prompts with durable state.
- Release: `@qearlyao/familiar@0.1.1` is in release-candidate cleanup. npm
  packaging now builds before pack/publish so WebUI assets cannot be omitted by
  accident.

Near-term priorities:

- Finish 0.1.1 release checks, commit release notes/package guard, tag, publish.
- Add public-2fa login UI before any public WebUI deployment guide.
- Improve reload coverage for scheduler timers and other restart-required config.
- Continue optimization/extension work from the backlog below.

Important posture:

- Core v0 is feature-complete enough for trusted-friend testing. Most later work
  should optimize, harden, document, or extend rather than reopen foundations.
- Windows stays foreground/manual for now. Do not add Task Scheduler or service
  wrapping until there is real demand.

## 1. Locked Decisions

- Build on upstream packages. Do not fork or rebuild `pi-agent-core`, `pi-ai`, or
  `pi-coding-agent` primitives unless upstream cannot support the needed behavior.
- Keep direct `Agent` as Familiar's runtime. Do not reinstate `AgentSession` just
  to get skills or compaction.
- Do not use upstream lossy auto-compaction as Familiar's memory system.
  Familiar owns LCM plus diary RAG through `Agent.transformContext`.
- Reuse pi's standalone skill loader/formatter for progressive instructions.
  Skills are instruction loading, not conversation memory.
- Persona convention is Familiar-owned: `SOUL.md`, `USER.md`, `MEMORY.md`, and
  `INNER.md`. `SOUL.md` and `USER.md` are owner-edited; `MEMORY.md` and
  `INNER.md` are agent-edited.
- `MEMORY.md` holds durable load-bearing facts. `INNER.md` holds the agent's
  current carried interior. Episodic recall belongs in diary RAG.
- Tool surface stays small:
  - Use upstream `bash`, `read`, `write`, `edit`.
  - Use Familiar-owned `web_search` and `web_fetch` for server-side open web.
  - Keep `memory_recall`/`memory_open` as the agent-facing memory tools.
  - Keep one compact `browser` tool instead of exposing raw backend surfaces.
  - Put large or rare instructions in skills, not tool descriptions.
- Browser control is backend-pluggable. The model sees one Familiar `browser`
  contract; backend may be OpenCLI, browser-harness, sidecar, direct CDP,
  extension bridge, Tailscale/private HTTP, or future provider computer-use.
- Discord remains a clean chat delivery adapter by default: final text and media
  only, no reasoning/tool noise unless an explicit debug mode exists.
- WebUI is first-class beside Discord, not a debug side-door.
- Single-owner is locked. Extensibility means tools, channels, providers,
  triggers, memory adapters, sidecars, and subagent personas, not multi-user
  account isolation.
- Secrets stay in env or workspace `.env`, never in `config.toml`.

## 2. Runtime Shape

```text
Discord adapter       WebUI adapter       future event sources
      |                    |                    |
      v                    v                    v
            Familiar chat runtime
            - channel registry
            - append-only chat logs
            - attachment store
            - trigger/job slicing
            - control commands
            - dispatch modes
                    |
                    v
            Context and memory layer
            - Tier 1: SOUL.md + USER.md + MEMORY.md + INNER.md
            - Tier 2: LCM for recent factual continuity
            - Tier 3: diary RAG for cross-session felt memory
            - injected through Agent.transformContext
                    |
                    v
            upstream Agent + pi-ai + tools
            - prompt/steer/followUp/abort
            - provider/cache/session plumbing
            - workspace, web, media, memory, browser tools

Browser/activity backend abstraction
  - local backend when browser is on same host
  - future Mac sidecar when browser/activity lives on the owner's Mac
  - transport: direct private HTTP, reverse sidecar connection, SSH tunnel, or Tailscale
```

Runtime and packaging:

- One `familiar` process owns Discord gateway, WebUI HTTP/WebSocket, agent,
  media workers, memory workers, embeddings, attachment writer, and queues.
- `familiar run [workspace]` defaults to `~/.familiar`.
- Workspace layout: `<workspace>/config.toml`, `.env`, persona files,
  `memories/`, `data/`, and `skills/`.
- npm package remains the primary distribution. Single-binary/Docker can be
  revisited after service/deploy paths are stable.

## 3. Memory Model

Stable prompt tier:

- `SOUL.md`: persona, owner-edited.
- `USER.md`: about the owner, owner-edited.
- `MEMORY.md`: durable load-bearing facts, agent-edited.
- `INNER.md`: short current interior, agent-edited.
- Failure mode is bloat; keep these files short and cache-stable.

LCM tier:

- Purpose: factual conversation continuity and context-window survival.
- Source of truth remains append-only `data/chat`, but LCM uses normalized
  records under `memories/lcm/`, not raw noisy chat logs.
- Keep inbound user text, useful attachment notes, outbound assistant text,
  selected useful tool/result facts, reset/control boundaries, timestamps, and
  provenance pointers.
- `Agent.transformContext` protects the fresh tail and replaces older raw context
  with generated summaries when leaf/budget pressure requires it.
- `/new` creates an LCM segment boundary. `newSessionRetainDepth` follows the
  upstream meaning: `-1` keeps all context, `0` drops raw messages but keeps
  summaries, positive values keep summaries at that depth or higher.
- Hybrid semantic/FTS recall is the primary factual search path; exact grep is
  debug/provenance fallback.

Diary tier:

- Purpose: private affective continuity and felt memory.
- Source: `memories/diaries/YYYY-MM-DD.md`.
- Stage 9 heartbeat instructions own diary voice/format/reflection policy.
  Stage 8 only assumes markdown files can be chunked and indexed.
- Empty or absent diary files are valid.
- Ambient recall is diary-first, conservative, and injected only into volatile
  current-turn context. LCM should not be automatically injected as private
  companion memory.
- Manual recall defaults to `all` scope so explicit agent searches can find both
  diary and factual conversation memory.

Shared index semantics:

- Physical reuse is allowed; semantic merging is not. Corpora include
  `lcm_record`, `lcm_summary`, `diary_chunk`, and future `atomic_fact`.
- Remote embeddings are primary. Local Transformers.js worker support can be
  added later from the `pi-lcm-memory` reference.
- Current Gemini embedding path is real; OpenAI/Voyage-style embedding config is
  not ready to document as usable until provider adapters are implemented.

## 4. Completed v0 Archive

Keep implementation details in source and git history. This archive is only the
capability map.

- Core runtime: direct upstream `Agent`, config/env/persona loading, Discord DM
  path, WebUI HTTP/WebSocket path, append-only logs, replay safety, trigger/job
  slicing, control commands, per-channel model/thinking/channel-trigger
  overrides, slash commands, silent response protocol, and payload inspection.
- Tool foundation: upstream `bash`, `read`, `write`, and `edit`; Familiar-owned
  web, media, memory, and browser tools.
- Web access: `web_search`/`web_fetch` with Brave/Tavily/Exa search routing,
  TinyFish/Jina markdown fetch, unsafe URL blocking, provider fallback, page
  cache, and untrusted-content wrapping.
- WebUI dashboard: session picker, shared Discord/Web runtime, live and durable
  thinking/tool/text events, generated media playback, and refresh-safe history.
- Media: Discord/Web attachment intake, image prompt assembly, automatic audio
  transcription, video understanding, image derivatives, TTS, image generation,
  generated-media storage/retention, and Discord/Web delivery.
- Skills: workspace `skills/` discovery, bundled `image-gen` skill seeding,
  compact available-skills injection, and reload refresh.
- Memory and LCM: shared memory index, normalized LCM records/summaries,
  automatic fresh-tail compaction, prompt-aware eviction, `/new` retention,
  memory operator commands, `memory_recall`/`memory_open`, diary indexing, and
  ambient diary recall.
- Scheduling: heartbeat/cron prompts through the main agent context,
  `HEARTBEAT.md` framing, idle-aware/restart-safe heartbeat cadence, durable
  scheduler state/logs, cron `queue`/`follow_up`, and ambient diary bypass for
  scheduled messages.
- Browser v0: compact browser tool, OpenCLI and browser-harness backends,
  screenshot attachment storage under workspace data, site-command allowlist,
  and read/write gating.
- Installer v0.1.1: macOS/Linux shell script and Windows PowerShell script that
  check Node/npm, install the npm package, initialize the workspace, optionally
  install OpenCLI/browser-harness helpers, and leave existing workspaces intact.
- Service v0.1.1: macOS user `launchd` and Linux user `systemd` install,
  uninstall, status, and npm-package upgrade commands; service logs under
  `<workspace>/logs`; Windows remains manual.

## 5. Active Backlog

### Release And Packaging

- Installer tests are intentionally light for now. Shell `--help` is covered;
  PowerShell is not locally tested because this is not a Windows development
  environment.
- browser-harness has no release tags today. Keep installing from upstream main
  via clone plus `uv tool install -e .` until upstream publishes stable tags.

### Service, Status, Upgrade

- Service install/uninstall/status and global npm upgrade are implemented for the
  0.1.1 release path.
- Improve `familiar status` with richer live service health: running pid/process,
  WebUI URL, last reload time/error, and Discord connection state when available.
- Add deploy docs after trusted-friend service usage shakes out.
- Keep Windows foreground/manual restart mode until real demand appears.
- Add an explicit workspace refresh path for bundled default skills/templates.
  Do not silently overwrite existing workspace files during `init`.

### Reload And Runtime Config

- Automatic reload is implemented for `config.toml`, `.env`, persona files,
  `skills/`, and `HEARTBEAT.md`.
- Keep manual `/reload` as a debug fallback.
- Mark restart-required fields explicitly in operator output/docs: WebUI
  port/bind address, Discord token, workspace/data directories, database paths
  or schema-affecting config, and package upgrades.
- Scheduler timer reload remains open: cron/heartbeat enabled-state and interval
  changes need a dedicated scheduler reload path or restart.
- Add runtime cron management so user/agent can create, inspect, pause, edit,
  and delete scheduled jobs without hand-editing `config.toml`; persist those
  jobs in scheduler state while keeping config-defined jobs as boot defaults.

### WebUI And Auth

- Add public-2fa login UI.
- Add nginx/public-2fa deployment example after public-2fa UI is complete.
- Add richer WebUI panes for memory, diary, transcript, payload, scheduler, and
  service-status inspection.
- Rework live agent-event rendering so streamed assistant text is preserved
  across subsequent thinking/tool calls instead of being cleared by the next
  tool event. Aim for a coherent step timeline like Codex for VS Code, or a
  closer-to-current Claude web-style transcript with durable intermediate text,
  tool cards, and final text in one readable flow.
- Virtualize or trim the WebUI message list only after real long-tab jank shows
  up. `react-virtuoso` is the likely fix for dynamic-height bubbles.

### Media Follow-Ups

- Add model capability gating for image attachments; skip or warn for non-vision
  active models instead of relying on upstream errors.
- Replace multipart upload string splitting with byte-wise scanning or a small
  parser before real upload volume.
- Move Discord attachment materialization off the message hot path into job
  draining.
- Audit auth coverage for `/api/web/attachments/*` in bearer and public-2fa
  modes.
- Broaden media tests: magic-byte sniff paths, total-byte cap, pure-attachment
  queue/drain routing, and oversize-base64 drop behavior.
- Add a manual generated-media cleanup command if startup retention is not
  enough.

### Memory And LCM Follow-Ups

- Add optional age-based LCM segment backstop for segments that never cross a
  later `/new` boundary.
- Cascade-delete shared-index rows when LCM records or diary chunks are deleted
  through ad-hoc paths outside retention.
- Add deeper `memory_open` expansion, `memory_expand`, or `memory_similar` once
  summary DAG compression needs deterministic drill-down.
- Add a lightweight tool-output reference path if tool results need to become
  searchable. Index concise placeholders/summaries, not raw giant outputs.
- Tune the diary-writing prompt toward memory-shaped markdown: dated files,
  topical headings, and short bullet items that chunk naturally.
- Re-evaluate heartbeat-triggered LCM compaction before building more machinery;
  keep it only if usage proves value.
- Render deterministic retained-summary headers from metadata: covered date range
  and generated time, with model-generated summary text as the body.
- Document and assert the cache-boundary contract for ambient injection: ambient
  text mutates only the current user turn, never the assistant tail.
- Add a doctor finding for sqlite-vec capability gaps where `memory_vec` rows lag
  behind `memory_chunks`.
- Implement non-Gemini embedding provider adapters before documenting those
  formats as usable.
- Revisit multimodal memory indexing. Today attachments enter memory through
  derived text notes; real multimodal embeddings need explicit media inputs,
  metadata, hashing, and tests.
- Fix `/new` transcript reset marker persistence so a reset marker can be written
  even before an agent session is loaded in memory.
- Add bounded in-memory chat-log windows or cold archive once months of logs make
  startup/RAM noticeably scale.

### Browser And Activity Expansion

- Preserve the model-facing compact `browser` contract while swapping backend
  implementations underneath.
- Keep OpenCLI for site adapters, owned sessions, and unattended Browser Bridge.
- Keep browser-harness for attaching to the already-running local Chrome via CDP.
- Current remote-browser bridge: Chrome, OpenCLI extension, and OpenCLI daemon
  live on the Mac; use an SSH reverse tunnel so VPS-local `127.0.0.1:19825`
  reaches the Mac daemon. Remote VPS OpenCLI cannot bootstrap the Mac daemon.
- Future `familiar-mac` sidecar owns Mac-local dependencies and permissions:
  OpenCLI, Chrome extension, desktop adapters, AppleScript/Accessibility,
  screen/camera capture, and computer-use primitives.
- Do not expose raw CDP, OpenCLI daemon ports, or browser extension endpoints
  publicly; require private networking, reverse tunnel, sidecar connection, or
  equivalent auth.
- Add local/remote backend adapters without changing the Familiar-facing browser
  schema.
- Preserve room for OpenCLI desktop app adapters and CLI Hub later through
  allowlisted backend commands, not wholesale OpenCLI exposure.
- Activity signals can include foreground app/window, idle/lock state, screen
  summary, and safe user-defined automation events.

### Subagent Delegation

- Revisit the deferred `task` tool only after media, memory, scheduling, and
  browser workflows show concrete delegation pressure.
- Subagent should be a fresh upstream `Agent` with focused system prompt, scoped
  tools, isolated transcript, same provider/cache plumbing, and mirrored events.
- Guardrails: depth, time, allowed tools, output shape, cancellation, and memory
  access policy.

## 6. Reference Index

Use `rg` first. Open only the target file/range you need.

Local Familiar files:

- `src/agent.ts`: direct `Agent` wrapper, model/thinking controls, reload,
  transcript/payload logging, `transformContext` integration.
- `src/runtime.ts`: `ConversationRuntime`, control parsing, trigger/job slicing.
- `src/discord.ts`: Discord intake, runtime cache, replies, queue draining.
- `src/web.ts`, `web/src/`: WebUI API/WebSocket and frontend.
- `src/chat-log.ts`: append-only channel log paths and records.
- `src/config.ts`, `src/models.ts`: config schema, provider/model/base-url/auth.
- `src/hot-reload.ts`: workspace file watcher and reload debounce.
- `src/web-tools.ts`: server-side web search/fetch providers and cache.
- `src/browser-tools.ts`: compact browser tool and OpenCLI/browser-harness
  adapters.
- `src/memory/**`: shared index, LCM, diary, memory service and operator tools.
- `scripts/install.sh`, `scripts/install.ps1`: npm installer entrypoints.
- `scripts/pretty-payload.ts`: payload inspection.

Upstream package roots:

- `/Users/qearl/pi`: local reference clone of `earendil-works/pi`.
- `/Users/qearl/pi/packages/agent/src/agent.ts`: `Agent`, state/options,
  `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`.
- `/Users/qearl/pi/packages/agent/src/agent-loop.ts`: `transformContext`, tool
  execution, steering/follow-up timing.
- `/Users/qearl/pi/packages/agent/src/types.ts`: `AgentMessage`, tool shape,
  events, usage-bearing messages.
- `/Users/qearl/pi/packages/ai/src/types.ts`: provider/cache/image-generation
  types.
- `/Users/qearl/pi/packages/ai/src/images.ts` and `image-models.ts`: upstream
  image-generation entry points.
- `/Users/qearl/pi/packages/ai/src/providers/images/openrouter.ts`: first
  upstream image provider reference.
- `/Users/qearl/pi/packages/coding-agent/src/core/tools/*`: upstream local tool
  factories.
- `/Users/qearl/pi/packages/coding-agent/src/utils/mime.ts` and
  `image-resize.ts`: media sniff/resize references.
- `/Users/qearl/pi-chat`: local reference clone of `earendil-works/pi-chat`; useful for
  runtime/log/adapter patterns, not memory/WebUI/browser design.

Useful commands:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm pack --dry-run
npm run payload:pretty -- --messages 12
npm run payload:pretty -- --full
```

## 7. Maintenance Posture

- Before feature work, check upstream status when it may have changed. Reuse the
  existing local reference clones; do not create duplicate upstream clones.
- On pi package upgrades, run typecheck/build/tests, send a known-good prompt,
  and verify cache telemetry.
- Write tests for behavioral contracts and risky adapters. Skip thin wrappers
  over upstream.
- Keep commits atomic and explain why.
- Keep README/CHANGELOG user-facing. Do not add development plan logs there.
