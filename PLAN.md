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
- Harden WebUI as the complete event stream/dashboard surface: persist Discord-origin thinking and tool lifecycle events for Web without exposing them in Discord replies.
- Implement Stage 5 image generation using the existing generated-media attachment path.
- Decide whether web→Discord cross-posting is desired (currently web messages share Familiar's runtime/log with the Discord session but are not echoed as visible Discord messages).

Important caution:

- Stages after Stage 6 are directionally planned, not fixed. Keep foundational code stable, cache-friendly, and extensible enough for changed later stages.

## 1. Locked Decisions

- Build on upstream packages. Do not fork or rebuild `pi-agent-core`, `pi-ai`, or `pi-coding-agent` primitives unless upstream cannot support the needed behavior.
- Keep direct `Agent` as Familiar's runtime. Do not reinstate `AgentSession` just to get skills.
- Do not use upstream lossy auto-compaction as Familiar's memory system. Familiar owns LCM plus diary RAG through `Agent.transformContext`.
- Reuse pi's standalone skill loader/formatter for progressive instructions: the agent sees skill name/description/path, then uses `read` to load `SKILL.md` only when needed.
- Persona convention is Familiar-owned: `SOUL.md`, `USER.md`, and one global `MEMORY.md`. Upstream does not know these names.
- `MEMORY.md` is small and durable. Episodic recall belongs in LCM and diary RAG.
- Tool surface stays small:
  - Use upstream `bash`, `read`, `write`, `edit`.
  - Avoid bespoke memory/diary wrappers.
  - Put large, rarely used media/persona/character instructions in skills, not tool descriptions.
  - Prioritize output/media tools now; postpone `task`/subagent delegation.
  - Keep one compact `browser` tool with structured actions later.
- Upstream coding-agent currently does not ship dedicated `web_fetch` or `web_search` tool factories; its built-in factories remain local workspace tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Familiar should own web-access tool design unless upstream adds a first-class web tool later.
- Browser control is backend-pluggable. The agent sees one `browser` capability, not Mac-specific tools. Backend may be local, remote sidecar, direct HTTPS, reverse connection, Tailscale, CDP/MCP/CLI/native automation, etc.
- WebUI starts small but is architecturally first-class beside Discord, not merely a debug side-door. Product direction: WebUI becomes the full information stream and dashboard for messages, reasoning, tool activity, memory, diagnostics, and generated media.
- Discord remains a clean chat delivery adapter by default: show final assistant text and outbound media only. Do not expose thinking blocks or verbose tool lifecycle details in Discord unless a future explicit debug mode asks for them.
- Single-owner is locked. Extensibility means tools, channels, providers, triggers, memory adapters, and subagent personas, not multi-user account isolation.
- Secrets stay in env or workspace `.env`, never in `config.toml`.

## 2. Upstream Cheat Sheet

Use these upstream primitives instead of duplicating functionality:

- `@earendil-works/pi-agent-core`
  - `Agent`, `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`, event subscription.
  - `transformContext` is the insertion point for LCM and diary RAG.
  - Generic tool shape and tool execution lifecycle already exist.
- `@earendil-works/pi-ai`
  - Provider/model abstraction, streaming, usage/cost fields, `sessionId`, `cacheRetention`.
  - Usage includes `cacheRead`, `cacheWrite`, `input`, `output`, `cost`.
- `@earendil-works/pi-coding-agent`
  - Tool factories for `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`.
  - Skill loader/formatter: `loadSkills()` and `formatSkillsForPrompt()` are reusable without adopting `AgentSession`.
  - Familiar uses `bash/read/write/edit`; shell `grep` through `bash` is enough.
  - Compaction/session utilities exist but are coding-session shaped and lossy.
- `pi-chat` in `/tmp/pi-chat` from `https://github.com/earendil-works/pi-chat`
  - Good reference for chat adapter/runtime/log shape.
  - Lift: append-only per-channel log, catch-up then arm, trigger/job slicing, reply-to, typing, chunking, attachment materialization.
  - Do not copy: two memory files, VM sandbox, extension-only packaging, lack of Familiar's RAG/WebUI/dashboard/generated-media/browser layers.
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
- Promote WebUI from side-door chat to first-class event stream/dashboard:
  - Backend records and streams assistant thinking for Discord-origin and Web-origin runs.
  - Backend records and streams tool lifecycle events (`start`, `update`, `end`, error state, concise result summary) with job/message correlation.
  - Discord-origin runs still send only the final assistant reply and outbound media back to Discord.
  - Frontend renders tool calls live, then folds completed calls by default while preserving full details for inspection.
- Implement `familiar install-service`, `familiar status`, and `familiar upgrade`.

### Stage 5: TTS and Image Generation

Status: TTS v0 implemented; image generation still next.

Completed in TTS v0:

- ElevenLabs-backed `tts` with configured `tts.voice_id`, optional per-call `voiceId`, compact audio-tag guidance, and model-aware voice settings.
- Generated audio is saved under `data/attachments/generated`, logged as outbound attachments, delivered through Discord/Web history, and cleaned on startup using `[media.generated].retention_days` (default 30, `0` disables).
- Discord currently sends assistant text plus generated audio files, matching WebUI/backend behavior. Transcript-toggle UX for WebUI is deferred.
- Tests cover config/env interpolation, voice-setting request shaping, generated-media cleanup/path safety, attachment serving safety, TOTP/auth, and WebSocket framing.

Active Stage 5 to-dos:

- Implement `image_gen`, preferably by wrapping upstream `@earendil-works/pi-ai` image generation once it is published to npm.
- Add a manual generated-media cleanup command later if startup retention is not enough.
- Add WebUI TTS transcript toggle after frontend coordination.

Image generation next:

- Upstream status: local `earendil-works/pi` main has a new image-generation API after `v0.74.0`: `getImageModel()`, `getImageModels()`, `getImageProviders()`, `generateImages()`, `ImagesContext`, `AssistantImages`, and OpenRouter image provider support. npm `0.74.0` does not yet include this API.
- Strategy: do not invent a parallel provider abstraction if upstream image APIs are close to release. Keep Familiar's work focused on config, tool wrapper, generated-media storage, Discord/Web delivery, logging, and tests.
- If implementation must happen before upstream publishes image APIs, make the provider layer intentionally thin and easy to replace with upstream `generateImages()`.
- Initial Familiar provider target is qearl's custom proxy, not OpenRouter. It should support configurable base URLs and auth envs for proxy-backed Gemini, OpenAI, and NovelAI image generation.
- Treat upstream's OpenRouter image implementation as an API-shape/reference implementation only, not the default provider choice.
- Config shape should distinguish chat models from image models, e.g. provider/model/base URL/API shape for image generation, because upstream uses `ImagesModel`, not normal `Model`.
- Reuse the generated-media sink, attachment URL path, chat-log attachment metadata, Discord file delivery, WebUI live/history attachment plumbing, and retention cleanup from TTS.
- Store prompt, provider, model, response id when available, mime type, size, local path, public attachment path, and any text side-output in durable metadata.
- Add tests for image config defaults, generated attachment registration, public path safety, and Discord/Web attachment serialization.
- Keep media tools simple and direct; do not route generation through subagents.
- Make failures user-visible but quiet: concise tool error text, no broken attachment placeholders.

Skills after image generation:

- Add Familiar skill discovery without `AgentSession`: load user/project skills and append pi's progressive skill index to the direct `Agent` system prompt.
- Use skills for large, rarely used media/persona/character instructions: voice IDs, required tags, reference image paths, style preferences, negative prompts, and safety constraints.
- Keep tool definitions generic. The model should load relevant skills before calling `tts` or `image_gen` when a request matches a character/media workflow.
- Keep LCM as the only automatic context compaction layer; skills are instruction loading, not conversation memory.

Deferred WebUI TTS polish:

- Coordinate with Claude before frontend changes.
- Default render should be a playable audio element.
- Provide a transcript/text toggle using the already logged assistant text.
- Avoid showing duplicate text beside audio by default.

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

- Stage 8 owns user-originated media intake and video-understanding strategy.
- Attachment metadata in chat records for Discord and Web uploads.
- Safe attachment store for user-supplied media: size limits, MIME allowlist, path safety, retention policy, and remote Discord attachment download guards.
- Image attachment path through upstream `prompt(input, images)` for vision-capable models.
- Voice memo transcription path.
- Video understanding strategy: decide frame sampling vs provider-native video input, transcript extraction, long-video summarization, and what to persist in chat logs/LCM.
- WebUI upload controls and previews should use the same backend attachment metadata shape as Discord intake.

Done when:

- Image attachments, voice memos, and short videos produce sensible replies without destabilizing Discord/Web message flow or context assembly.

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
- Web access should be designed explicitly instead of assuming upstream coverage. As of local `earendil-works/pi` main, upstream has no dedicated `web_fetch`/`web_search` built-ins; `anthropic-dangerous-direct-browser-access` in provider code is SDK browser-runtime allowance, not a browsing/search feature.
- Consider a small Familiar-owned `web` or `browser` action set later: `search`, `fetch`, `readability`, `screenshot`, `extract_links`, `navigate`, and `activity`. Keep server-side search/fetch and real browser control separable if that simplifies permissions and reliability.
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

- `/Users/qearl/pi-mono` is a local reference clone of `https://github.com/earendil-works/pi` (directory name is historical).
- `/Users/qearl/pi-mono/packages/agent`
- `/Users/qearl/pi-mono/packages/ai`
- `/Users/qearl/pi-mono/packages/coding-agent`
- `/tmp/pi-chat` is a local reference clone of `https://github.com/earendil-works/pi-chat`.

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
  - `cacheRetention`, usage fields, image-generation types on main (`ImagesModel`, `ImagesContext`, `AssistantImages`)
- `/Users/qearl/pi-mono/packages/ai/src/providers/anthropic.ts`
  - upstream `cache_control` behavior
- `/Users/qearl/pi-mono/packages/ai/src/providers/openai-responses.ts`
  - session/cache headers
- `/Users/qearl/pi-mono/packages/ai/src/images.ts`
  - upstream `generateImages()` entry point on main; not in npm `0.74.0` yet
- `/Users/qearl/pi-mono/packages/ai/src/image-models.ts`
  - upstream image model discovery on main: `getImageModel`, `getImageModels`, `getImageProviders`
- `/Users/qearl/pi-mono/packages/ai/src/providers/images/openrouter.ts`
  - first upstream image provider implementation on main, returns base64 `ImageContent` plus optional text
- `/Users/qearl/pi-mono/.pi/extensions/tps.ts`
  - cache read/write usage reporting pattern

Tool refs:

- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/index.ts`
  - confirms current upstream built-ins are workspace/local tools, not web fetch/search tools
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/bash.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/read.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/write.ts`

Compaction/session refs:

- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/session-manager.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/compaction/compaction.ts`

pi-chat refs:

- `/tmp/pi-chat/src/core/runtime-types.ts`: chat runtime/log record types.
- `/tmp/pi-chat/src/runtime.ts`: runtime state machine, trigger slicing.
- `/tmp/pi-chat/src/log.ts`: append JSONL, locks, timestamps, attachment materialization.
- `/tmp/pi-chat/src/live/types.ts`: small live adapter interface.
- `/tmp/pi-chat/src/live/discord.ts`: Discord catch-up, mentions, reply-to, attachments.
- `/tmp/pi-chat/src/live/common.ts`: shared live-adapter helpers, including remote attachment download.
- `/tmp/pi-chat/src/render/chunking.ts`: outbound chunking.
- `/tmp/pi-chat/src/services/discord.ts`: Discord service setup and lifecycle wiring.
- `/tmp/pi-chat/src/services/index.ts`: service entry aggregation.

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
