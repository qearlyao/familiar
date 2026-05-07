# familiar plan

Personal companion agent for qearl. Discord-first in the early stages, but designed for a first-class WebUI chat surface later. VPS-hosted, always on, single-owner, reactive in v0, with later proactive check-ins and pluggable browser/activity backends.

This is the session-start operating plan. It keeps only the decisions, stage map, and high-value references needed when Codex starts with no memory. Older investigative detail was intentionally compressed to save context.

## 0. Current Snapshot

Implemented or recently added:

- Stage 0 and Stage 1 are effectively done: direct upstream `Agent`, Discord DM path, persona files, stable session/cache logging.
- Stage 2 is partially done: chat runtime, append-only logs, transcript/payload logs, control commands, model/thinking controls, provider/base-url config, reply/chunk config, dispatch modes, group collection, per-channel agent transcripts, and payload inspection tooling.
- Stage 3 v0 is shipped: WebUI at `web/` (React+Vite+Tailwind v4+shadcn, warm sepia tweakcn theme), side-door HTTP+WebSocket server in `src/web.ts`, three auth modes scaffolded, session picker exposing owner DM + allowed Discord channels, web tabs share runtime/transcript with their Discord counterpart so Discord-originated messages stream live into open web tabs, persona name auto-detected from SOUL.md `**Name:**`, streaming thinking blocks (collapsible, italic Lora serif).
- Stage 5 TTS v0 is implemented: ElevenLabs-backed `tts` tool with configurable `voice_id`, generated audio saved under `data/attachments/generated`, outbound attachment logging, Discord file delivery, and WebUI audio playback/history.
- Anthropic cache normalization is implemented in `src/agent.ts`: Familiar strips extra upstream `cache_control` points and keeps the latest user-message checkpoint, matching Claude Code's stable cache shape.
- Payload inspection exists: `npm run payload:pretty -- --messages 12`, `--full`, `--date`, `--model`.
- `familiar install-service`, `familiar status`, and `familiar upgrade` are still not implemented.

Next implementation chunks:

- Finish tests/log probes and Stage 2 polish cleanup.
- Prioritize Stage 5 media output: TTS and image generation tools with Discord/WebUI attachment delivery.
- Decide whether web→Discord cross-posting is desired (currently web messages share Familiar's runtime/log with the Discord session but are not echoed as visible Discord messages).

Important caution:

- Stages after Stage 6 are directionally planned, not fixed. Keep foundational code stable, cache-friendly, and extensible enough for changed later stages.

## 1. Locked Decisions

- Build on upstream packages. Do not fork or rebuild `pi-agent-core`, `pi-ai`, or `pi-coding-agent` primitives unless upstream cannot support the needed behavior.
- Use direct `Agent` first. Reconsider `AgentSession` only if upstream JSONL session branching/compaction becomes valuable.
- Do not use upstream lossy auto-compaction as Familiar's memory system. Familiar owns LCM plus diary RAG through `Agent.transformContext`.
- Persona convention is Familiar-owned: `SOUL.md`, `USER.md`, and one global `MEMORY.md`. Upstream does not know these names.
- `MEMORY.md` is small and durable. Episodic recall belongs in LCM and diary RAG.
- Tool surface stays small:
  - Use upstream `bash`, `read`, `write`, `edit`.
  - Avoid bespoke memory/diary wrappers.
  - Prioritize output/media tools now; postpone `task`/subagent delegation.
  - Keep one compact `browser` tool with structured actions later.
- Browser control is backend-pluggable. The agent sees one `browser` capability, not Mac-specific tools. Backend may be local, remote sidecar, direct HTTPS, reverse connection, Tailscale, CDP/MCP/CLI/native automation, etc.
- WebUI starts small but is architecturally first-class beside Discord, not merely a debug side-door.
- Single-owner is locked. Extensibility means tools, channels, providers, triggers, memory adapters, and subagent personas, not multi-user account isolation.
- Secrets stay in env or workspace `.env`, never in `config.toml`.

## 2. Upstream Cheat Sheet

Use these upstream primitives instead of duplicating functionality:

- `@mariozechner/pi-agent-core`
  - `Agent`, `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`, event subscription.
  - `transformContext` is the insertion point for LCM and diary RAG.
  - Generic tool shape and tool execution lifecycle already exist.
- `@mariozechner/pi-ai`
  - Provider/model abstraction, streaming, usage/cost fields, `sessionId`, `cacheRetention`.
  - Usage includes `cacheRead`, `cacheWrite`, `input`, `output`, `cost`.
- `@mariozechner/pi-coding-agent`
  - Tool factories for `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`.
  - Familiar uses `bash/read/write/edit`; shell `grep` through `bash` is enough.
  - Compaction/session utilities exist but are coding-session shaped and lossy.
- `pi-chat` in `/tmp/pi-chat`
  - Good reference for chat adapter/runtime/log shape.
  - Lift: append-only per-channel log, catch-up then arm, trigger/job slicing, reply-to, typing, chunking, attachment materialization.
  - Do not copy: two memory files, VM sandbox, extension-only packaging, lack of RAG/WebUI/media/browser features.
  - Its heartbeat is only worker/status snapshots every 15s, not proactive check-ins.

High-value local files:

- `src/agent.ts`: upstream `Agent` wrapper, model/thinking controls, Anthropic payload normalization, transcript/payload logging.
- `src/runtime.ts`: `ConversationRuntime`, control parsing, trigger/job slicing.
- `src/discord.ts`: Discord intake, runtime cache, replies, queue draining.
- `src/chat-log.ts`: channel log paths and append-only chat records.
- `src/config.ts`, `src/models.ts`: config schema, provider/model/base-url/auth behavior.
- `scripts/pretty-payload.ts`: current payload inspection tool.

## 3. Architecture

```
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
            - Tier 1: SOUL.md + USER.md + MEMORY.md
            - Tier 2: LCM for today's in-session context
            - Tier 3: diary RAG for cross-session recall
            - injected through Agent.transformContext
                    |
                    v
            upstream Agent + pi-ai + tools
            - prompt/steer/followUp
- per-channel transcripts/sessions before LCM
            - usage/cache telemetry
            - bash/read/write/edit
            - media tools now; task/browser tools later

Browser/activity backend abstraction
  - local backend when browser is on same host
  - remote sidecar when browser is on qearl's Mac
  - transport: direct HTTPS, reverse sidecar connection, or Tailscale/private network
  - implementation choice deferred: Chrome DevTools MCP/CDP, CLI repo, native automation, Playwright only if still best
```

Runtime and packaging:

- Main daemon: one `familiar` process owns Discord gateway, WebUI HTTP/WebSocket, main agent, media workers, memory workers, embeddings, attachment writer, queues. Subagents can be added later.
- Dev: `familiar run <workspace>`.
- Prod: `familiar install-service <workspace>` eventually writes systemd or launchd config.
- Workspace layout: `<workspace>/config.toml`, `.env`, `SOUL.md`, `USER.md`, `MEMORY.md`, `data/`, `attachments/`, `logs/`.
- Prefer npm package first. Single-binary/Docker can be revisited later.

## 4. Memory Model

Tier 1: stable prompt files.

- `SOUL.md`: persona, qearl-edited.
- `USER.md`: about qearl, qearl-edited.
- `MEMORY.md`: durable load-bearing facts, agent may edit via upstream filesystem tools.
- Failure mode: bloat. Keep it short.

Tier 2: LCM, today's lossless-ish context engine.

- Source: per-channel append-only chat logs.
- Summaries: markdown leaf/condensed summary DAG with provenance frontmatter.
- Index: SQLite vectors for raw and summary records, internal only.
- Assembly: `Agent.transformContext` selects fresh tail plus minimal useful summaries. LCM may build a global companion-brain daily view, but raw source records stay per-channel.
- Agent access: `read` and `bash grep` over logs/summaries, no special memory tool.
- Replaces upstream auto-compaction for Familiar.

Tier 3: diary RAG, previous days.

- Source: `data/diaries/YYYY-MM-DD.md`, reflective markdown, editable by qearl.
- Written by a diary worker at end-of-day, on "good night", or explicit signal.
- Index: diary chunks plus atomic facts, hybrid FTS/vector with recency.
- Injection: top-K diary context through `Agent.transformContext`.
- Durable facts discovered from diary can be promoted to `MEMORY.md`.

Turn assembly:

- Stable block: persona files plus tool index.
- Volatile block: LCM + diary RAG + current prompt slice.
- Cache stability matters: keep stable text stable; volatile context should be deterministic and minimally sufficient.

## 5. Stage Roadmap

### Stage 0: Upstream Integration Decision

Status: done.

- Use direct `Agent` for v0 daemon simplicity.
- Reuse `pi-coding-agent` tool factories.
- Log `cacheRead/cacheWrite`.

### Stage 1: Bootstrap Daemon and Discord DM

Status: done enough for v0.

- Config loader, env loading, persona files.
- Discord DM adapter.
- Basic reply pipeline.
- Stable `sessionId` and cache usage logging.

Done when:

- qearl can DM the bot and get a persona-aware reply after restart.

### Stage 2: Chat Runtime, Logs, Control Commands, and Dispatch Modes

Status: partially done. This is the active stage.

Already in place:

- `ConversationRuntime`.
- Append-only chat/transcript/payload logs.
- Replay/catch-up safety.
- `stop`, `status`, `new`, `compact` style control path.
- Model and thinking-level controls, currently runtime-only.
- Default model config uses `agent.model = "provider/model"` and resolves through pi-ai built-ins; legacy manual `agent.api` config is only an escape hatch.
- Reply/chunk config.
- Discord dispatch modes: `steer`, `queue`, `collect`.
- Group collect debounce and mention/always trigger policy.
- Optional other-bot ingestion with self-bot loop prevention.
- Per-channel live upstream `Agent` transcripts/sessions before LCM, while sharing global persona/memory.
- Durable per-channel overrides for `/model`, `/thinking`, and `/channel-trigger`.
- Native Discord `/familiar` command with subcommands, model autocomplete, and ephemeral control replies. It is namespaced
  under `/familiar` to avoid clobbering OpenClaw's existing `/model`, `/new`, `/stop`, and `/status` commands on the same bot.
- Silent response protocol: the agent may output `[[FAMILIAR_SILENT]]` on the first line to suppress Discord output while
  recording a silent outbound log event for WebUI/internal visibility.
- Payload inspection.

Still needed:

- Focused tests/log probes.

Done when:

- Reconnect replay does not re-trigger old messages.
- Logs survive restart.
- Control commands work from Discord.
- DMs can steer active work.
- Group/channel dispatch can be switched between mention-gated collect and always-on collection.

#### Stage 2 Follow-Up: Dispatch Modes and Group Collection

Status: implemented in code; keep this as a behavior reference.

Config to add under `[discord]`:

```toml
dm_mode = "steer"             # steer | queue | collect
channel_mode = "collect"      # collect | queue | steer
channel_trigger = "mention"   # mention | always
collect_debounce_ms = 4000
allow_bot_messages = false
```

Implementation checklist:

- Extend `Config.discord` and `config.example.toml`.
- Update Discord intake so `allow_bot_messages` admits other bots' messages, while always ignoring Familiar's own Discord user id.
- Update group/channel triggering to honor `channel_trigger = "mention" | "always"`.
- Implement group/channel collect mode with 3-5s debounce, then dispatch one prompt slice.
- Implement DM active-work steering: if owner DM arrives while the agent is active and `dm_mode = "steer"`, call upstream `Agent.steer(...)` instead of queuing a separate job.
- Keep `queue` mode as current independent serialized job behavior.
- Keep `collect` mode append-only and log-backed, not only in memory.
- Format collected prompt lines with `authorName`, stable `authorId`, ISO timestamp, and text:
  `[qearlyao uid:... @ 2026-05-04T13:50:24.126Z] hello`
- Bot messages use normal Discord username; no extra bot marker needed.
- Add probes/tests for DM steer during active job, group mention collect, group always collect, other-bot ingestion, and self-bot prevention.

#### Stage 2 Polish: Durable Settings

Status: implemented in code; keep this as a behavior reference.

Durable settings:

- Settings live in `data/settings/channel-overrides.json`.
- Config remains fallback/default. Durable overrides win when present.
- Per-channel overrides:
  - current model
  - current thinking level
  - `channel_trigger`
  - later `channel_mode`, reply/chunk preferences, and WebUI channel settings
- Update `/model` and `/thinking` so successful changes persist across restart.
- Add `/channel-trigger mention|always` with durable per-channel persistence.
- `status` should show effective values and whether each came from config or override.

Per-channel agent transcript/session history:

Status: implemented; keep this as a behavior reference.

- Stop sharing one raw live `Agent.state.messages` transcript across DM and group channels.
- Keep one global stable persona/memory layer: `SOUL.md`, `USER.md`, `MEMORY.md`.
- Create or hydrate a channel-scoped agent transcript/session for each conversation channel.
- Keep provider/cache session ids stable per channel, with a deterministic workspace/channel-based id.
- Keep chat JSON logs per-channel as the raw source of truth.
- Leave cross-channel companion-brain continuity to Stage 6 LCM and Stage 7 diary RAG. Those stages can inject relevant cross-channel context through `transformContext` without merging raw logs.
- Model/thinking are per-channel overrides, not global, so different channels can use different providers and reasoning levels.

Done when:

- Restart preserves `/model`, `/thinking`, and `/channel-trigger` changes. (Implemented.)
- DM and group channels no longer share the same live transcript, but both still share persona and durable memory. (Implemented.)
- Existing chat logs remain compatible.

### Stage 3: WebUI v0 and Side-Door Transport

Status: v0 shipped. Keep this section as a behavior/design reference.

Implemented:

- HTTP + WebSocket side-door server in `src/web.ts`, no new runtime deps (hand-rolled WS framing).
- Three auth modes scaffolded: `tailscale-only`, `bearer`, `public-2fa` (TOTP via `/api/web/control` `login` command).
- Frontend at `web/`: React+Vite+TypeScript+Tailwind v4+shadcn/ui+tweakcn theme `cmokic2d8000304jo55ca0sy3` (warm sepia/literary, Libre Baskerville/Lora/IBM Plex Mono).
- Wire protocol documented at `web/PROTOCOL.md`: HTTP for handshake/history/control/sessions, WebSocket for live deltas, `delta.part: "thinking" | "text"` discriminator, `lastEventId` reconnect with `replay_window_lost` fallback.
- Session picker: web tabs do not own a separate runtime; `GET /api/web/sessions` returns owner DM + configured allowed Discord channels, and web requests share the same `ConversationRuntime`/transcript/agent session as their Discord counterpart. Discord-originated messages stream into web tabs viewing that channel via `ConversationRuntime.subscribe()`.
- Streaming thinking blocks: collapsible, italic serif body, "thought for Xs" trigger (lighter color than the assistant name to avoid visual collision).
- Persona name is auto-detected from `SOUL.md` `**Name:**` field via `parsePersonaName()` and surfaced in `/api/web/auth/mode`; the wordmark and assistant labels track the active persona.
- Symmetric plain-text message style (alignment + name label only, no asymmetric bubbles) — fits the literary aesthetic.

Done when:

- Phone/browser can talk to Familiar without Discord through configured auth/access. ✅

Deferred / open questions:

- Cross-posting: web messages currently share Familiar's runtime/log with the Discord session but are NOT echoed as visible Discord messages. Decide later whether to mirror them.
- Public-2fa login UI: protocol path is wired (`POST /api/web/control` with `command: "login"`), but no login screen exists in the frontend yet.
- Attachments (images, audio) on either direction.
- Rich panes (memory/diary/transcript/payload inspection) — left for later iterations.
- Token-level usage and cost surfacing in the UI (only final usage on `message_completed` is captured today).

### Stage 4: Tools

- Register upstream `bash`, `read`, `write`, `edit` with workspace root and Familiar policy.
- YOLO bash on VPS is allowed for qearl's install.
- No memory/diary wrapper tools.
- Agent can inspect logs/summaries/diaries through filesystem tools.

Done when:

- Agent can use bash, read/edit persona files, and grep/read `data/`.

### Stage 5: TTS and Image Generation

Status: TTS v0 implemented; image generation still next.

- Add a `tts` tool for generating speech audio from requested text. (Implemented with ElevenLabs.)
- Add an `image_gen` tool for generating image attachments from prompts.
- Add provider/config plumbing for media models, API keys, output formats, and per-tool limits. (TTS implemented.)
- Store generated assets under the workspace attachment/data area with durable metadata in chat logs. (TTS implemented.)
- Integrate attachment queue delivery for Discord replies and WebUI live events/history. (TTS implemented.)
- Discord TTS delivery should send only the generated audio attachment; keep transcript text in logs for later WebUI toggle.
- TODO WebUI TTS display: default to playable audio with an optional transcript/text view after frontend design settles.
- Add generated-media retention/cleanup policy before high-volume production use.
- Keep the tools simple and direct; do not route media generation through subagents.
- Make failures user-visible but quiet: concise tool error text, no broken attachment placeholders.

Done when:

- "say this out loud" returns an audio attachment in Discord and WebUI.
- "draw X" returns an image attachment in Discord and WebUI.
- Generated media paths are logged and survive restart/history replay.

### Stage 6: LCM

- Per-channel raw logs under `data/chat/{channel}/{date}.jsonl`.
- Summary DAG under `data/lcm/{date}/`.
- SQLite vector index internal to assembler.
- Deferred compaction worker; do not block active turn by default.
- `Agent.transformContext` assembles fresh tail plus summary coverage around 75% window threshold.
- Raw logs stay per-channel and greppable. LCM can build a global daily companion-brain summary/index with channel/source provenance instead of merging raw DM/group logs.
- File watcher re-embeds edited summaries.

Done when:

- Long same-day conversations avoid context overflow.
- Agent can grep raw chat and read summary provenance.

### Stage 7: Daily Diary and Cross-Session RAG

- Diary files at `data/diaries/YYYY-MM-DD.md`.
- Diary-writer worker uses chat logs and previous diary through upstream tools. It may become a `task` subagent later, but should not block on the subagent tool.
- Trigger at end of day, on "good night", or explicit command/signal.
- Embed diary chunks and atomic facts.
- Inject relevant diary context through `Agent.transformContext`.
- File watcher re-embeds edits.

Done when:

- New-day conversations recall relevant past diary excerpts and manual diary edits update retrieval.

### Stage 8: Media Intake

- Attachment metadata in chat records.
- Gemini voice transcription.
- Gemini video description.
- Image attachment path through upstream `prompt(input, images)`.

Done when:

- Voice memos and short videos produce sensible replies.

### Stage 9: Heartbeat, Scheduler, and Active Check-Ins

- Internal scheduler with workspace timezone, durable state, missed-run handling, append-only scheduler records.
- pi-chat heartbeat is only worker/status snapshot reference, not proactive behavior.
- Event-aware wake policy: interval triggers, event triggers, or both.
- External event inbox for iOS Shortcuts/webhooks, presence/activity, app open/close, user-defined events, manual notes.
- Wake prompt includes idle time, recent events, last conversation state, quiet/cooldown state, diary/RAG snippets.
- Default delivery is primary DM only. Never surprise-post to group channels unless explicitly configured.
- Guardrails: quiet hours, cooldowns, daily max, "stop checking in" command/state.

Done when:

- Familiar can send a tasteful proactive DM, ingest idle-period events, persist scheduler state, and log why it spoke or stayed quiet.

### Stage 10: Subagent Delegation Tool

- Revisit the deferred `task` tool after media output, LCM/diary, and proactive scheduling have enough shape to justify delegation.
- Subagent remains a fresh upstream `Agent` with focused system prompt, scoped tools, isolated transcript, same provider/cache plumbing.
- Arguments: `goal`, `context`, `allowedTools`, `timeoutMs`, `maxSteps`, `maxToolCalls`, `returnShape`, `allowMemory`, `allowRag`, `attachmentPolicy`.
- Mirror subagent events to the current channel log.
- Enforce depth/time/tool/output guards and cancellation.

Done when:

- Main agent can delegate a bounded task, show what happened, receive structured result, and continue.

### Stage 11: Browser/Activity Backend and Mac Sidecar

- Define browser/activity backend contract, not Mac-specific.
- Local backend for Windows/Linux/macOS installs where browser is on same host.
- Optional `familiar-mac` sidecar for qearl's Mac.
- Transport options: direct HTTP, reverse sidecar connection to VPS, or private networking such as Tailscale.
- Keep implementation undecided until build time: Chrome DevTools MCP/CDP, mature CLI repos, native automation, Playwright only if best.
- Activity signals can include foreground app/window, idle/lock state, screen summary, and safe user-defined automation events.

Done when:

- Same browser/activity interface works against local backend or qearl's Mac sidecar.

### Stage 12: Browser Tool Client

- One `browser` tool with structured actions like `navigate`, `eval`, `read_visible`, `screenshot`, `screen_read`, `activity`.
- Prefer one tool with actions over many narrow browser tools.
- Backend adapters for local host mode and remote sidecar mode.
- Activity reads for Stage 9 should usually be scheduler context, but may be exposed through the compact `browser` surface if useful.
- Conservative truncation and attachment handling.

Done when:

- Familiar can inspect and operate the configured real browser from Discord or WebUI.

### Stage 13: Install, Service, and Docs

- `familiar init <workspace>`.
- `familiar run <workspace>`.
- `familiar install-service <workspace>`.
- systemd unit.
- launchd plist where useful.
- nginx/public-2fa deployment example.
- deploy README.

Done when:

- A fresh Debian VPS can run Familiar in under 10 minutes after secrets are provided.

## 6. Reference Index

Use `rg` first. Open only the target file/range you need.

Upstream package roots:

- `/Users/qearl/pi-mono/packages/agent`
- `/Users/qearl/pi-mono/packages/ai`
- `/Users/qearl/pi-mono/packages/coding-agent`
- `/tmp/pi-chat`

Agent/runtime refs:

- `/Users/qearl/pi-mono/packages/agent/src/agent.ts`
  - constructor/state/options: search `constructor`
  - `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`
- `/Users/qearl/pi-mono/packages/agent/src/agent-loop.ts`
  - `transformContext`
  - tool execution
  - steering/follow-up timing
- `/Users/qearl/pi-mono/packages/agent/src/types.ts`
  - `AgentMessage`, tool shape, events, usage-bearing messages

Provider/cache refs:

- `/Users/qearl/pi-mono/packages/ai/src/types.ts`
  - `cacheRetention`, usage fields
- `/Users/qearl/pi-mono/packages/ai/src/providers/anthropic.ts`
  - upstream `cache_control` behavior
- `/Users/qearl/pi-mono/packages/ai/src/providers/openai-responses.ts`
  - session/cache headers
- `/Users/qearl/pi-mono/.pi/extensions/tps.ts`
  - cache read/write usage reporting pattern

Tool refs:

- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/index.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/bash.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/read.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/write.ts`

Compaction/session refs:

- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/session-manager.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/compaction/compaction.ts`

pi-chat refs:

- `/tmp/pi-chat/src/runtime.ts`: runtime state machine, trigger slicing.
- `/tmp/pi-chat/src/log.ts`: append JSONL, locks, timestamps, attachments.
- `/tmp/pi-chat/src/live/types.ts`: small live adapter interface.
- `/tmp/pi-chat/src/live/discord.ts`: Discord catch-up, mentions, reply-to, attachments.
- `/tmp/pi-chat/src/render/chunking.ts`: outbound chunking.
- `/tmp/pi-chat/index.ts`: control commands, dispatch, worker/status loop.

Local refs:

- `src/agent.ts`: Familiar agent wrapper, cache normalization, transcript/payload logging.
- `src/runtime.ts`: conversation runtime, control parser, trigger records.
- `src/discord.ts`: Discord glue, runtime promise cache, replies, queue draining.
- `src/chat-log.ts`: channel log layout.
- `src/config.ts`: config schema and defaults.
- `src/models.ts`: model/provider auth/base-url mapping.
- `scripts/pretty-payload.ts`: payload inspection.

Useful local commands:

```sh
npm run typecheck
npm run lint
npm run build
npm run payload:pretty -- --messages 12
npm run payload:pretty -- --full
```

## 7. Maintenance Posture

- Pin pi packages with normal semver ranges; on upgrade, run typecheck/build, send a known-good prompt, and verify cache telemetry.
- Write tests for runtime state machine, dispatch modes, media attachment delivery, LCM assembly/scoring, subagent guards when revived, and browser backend adapters. Skip thin wrappers over upstream.
- Use Biome formatting.
- Keep commits atomic and explain why.
- Log token usage and cost per turn; aggregate daily later. No external telemetry sink.
