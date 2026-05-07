# familiar plan

Personal companion agent for qearl. Discord-first in the early stages, but designed for a first-class WebUI chat surface later. VPS-hosted, always on, single-owner, reactive in v0, with later proactive check-ins and pluggable browser/activity backends.

This is the session-start operating plan. It keeps only the decisions, stage map, and high-value references needed when Codex starts with no memory. Older investigative detail was intentionally compressed to save context.

## 0. Current Snapshot

Implemented or recently added:

- Stages 0-4 are v0-complete: upstream `Agent`, Discord runtime/logs/controls, Anthropic cache normalization, WebUI side-door, workspace tools, payload inspection, and focused backend tests.
- Stage 5 TTS v0 is implemented: ElevenLabs `tts`, configurable `voice_id`, generated audio attachments, Discord audio-only delivery, WebUI playback/history plumbing, and attachment-serving safety tests.
- `familiar install-service`, `familiar status`, and `familiar upgrade` are still not implemented.

Next implementation chunks:

- Tighten Stage 5 TTS follow-ups listed below before heavy usage.
- Implement Stage 5 image generation using the existing generated-media attachment path.
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

### Completed v0 Foundation: Stages 0-4

Status: shipped enough for current development. Keep details in git history and source, not this roadmap.

- Stage 0: chose direct upstream `Agent`, reused upstream tool factories, and kept usage/cache telemetry.
- Stage 1: bootstrapped config/env/persona loading, Discord DM path, reply pipeline, and stable session/cache logging.
- Stage 2: added `ConversationRuntime`, append-only logs, replay safety, control commands, provider/model/thinking controls, Anthropic cache normalization, Discord dispatch modes, per-channel overrides/sessions, slash commands, silent response protocol, and payload inspection.
- Stage 3: shipped WebUI side-door with HTTP/WebSocket transport, auth scaffolding, session picker, shared Discord/Web runtime, thinking/text streaming, persona label detection, and current frontend baseline.
- Stage 4: registered upstream `bash`, `read`, `write`, and `edit` tools with YOLO workspace behavior; no memory/diary wrapper tools.

Still open from these stages:

- Decide whether web-originated messages should be visibly mirrored into Discord.
- Add public-2fa login UI when the frontend pass resumes.
- Add richer WebUI panes for memory/diary/transcript/payload inspection later.
- Implement `familiar install-service`, `familiar status`, and `familiar upgrade`.

### Stage 5: TTS and Image Generation

Status: TTS v0 implemented; image generation still next.

TTS v0 done:

- ElevenLabs is the default TTS provider.
- `tts` supports configured `tts.voice_id` plus per-call `voiceId` override for qearl's cloned voice.
- Generated audio is saved under `data/attachments/generated` and logged as outbound attachments.
- Discord sends TTS responses as audio-only attachments while retaining transcript text in logs.
- Web backend/history can carry generated audio attachments; current WebUI can play audio, but transcript toggle UX is deferred.
- Tests cover config/env interpolation, generated media public paths, attachment serving safety, TTS format helpers, TOTP/auth, and WebSocket framing.

TTS follow-ups before heavy use:

- Add a retention policy for `data/attachments/generated`: configurable max age and/or max bytes, startup cleanup, and a manual cleanup command.
- Add focused Discord delivery coverage for audio-only replies, including the reply-fallback path and the "no broken placeholder" failure path.
- Add a concise user-facing error path for ElevenLabs failures that avoids logging API response bodies into visible chat text.
- Add optional config for ElevenLabs voice settings (`stability`, `similarity_boost`, maybe `style` / `use_speaker_boost`) only if qearl needs tuning beyond the current defaults.
- Decide whether to keep `tts` tool description visible/minimal or hide most provider detail from the model prompt.

Deferred WebUI TTS polish:

- Coordinate with Claude before frontend changes.
- Default render should be a playable audio element.
- Provide a transcript/text toggle using the already logged assistant text.
- Avoid showing duplicate text beside audio by default.

Image generation next:

- Pick provider/config shape for `image_gen` before implementation.
- Reuse the generated-media sink, attachment URL path, chat-log attachment metadata, Discord file delivery, and WebUI live/history attachment plumbing from TTS.
- Store prompt, provider, model, mime type, size, local path, and public attachment path in durable metadata.
- Add tests for image config defaults, generated attachment registration, public path safety, and Discord/Web attachment serialization.
- Keep media tools simple and direct; do not route generation through subagents.
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
npm test
npm run typecheck
npm run lint
npm run build
npm run payload:pretty -- --messages 12
npm run payload:pretty -- --full
```

## 7. Maintenance Posture

- Pin pi packages with normal semver ranges; on upgrade, run typecheck/build, send a known-good prompt, and verify cache telemetry.
- Node test suite exists under `test/` using `tsx --test`; run `npm test`.
- Write tests for runtime state machine, dispatch modes, media attachment delivery, LCM assembly/scoring, subagent guards when revived, and browser backend adapters. Skip thin wrappers over upstream.
- Use Biome formatting.
- Keep commits atomic and explain why.
- Log token usage and cost per turn; aggregate daily later. No external telemetry sink.
