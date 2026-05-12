# familiar plan

Personal companion agent for qearl. Discord-first in the early stages, but designed for a first-class WebUI chat surface later. VPS-hosted, always on, single-owner, reactive in v0, with later proactive check-ins and pluggable browser/activity backends.

This is the session-start operating plan. It keeps only the decisions, stage map, and high-value references needed when Codex starts with no memory. Older investigative detail was intentionally compressed to save context.

## 0. Current Snapshot

Implemented or recently added:

- Stages 0-6 are v0-complete: core runtime, WebUI, TTS v0, event dashboard, and media intake.
- Native `web_search` and `web_fetch` tools are shipped: Brave/Tavily/Exa search routing, TinyFish/Jina markdown fetch, SSRF-style URL guards, page cache, and XML-wrapped untrusted-content warnings in tool results.
- Stage 7-8 memory foundation is shipped: shared memory index, LCM context compaction, memory recall/open tools, diary indexing, and ambient diary recall.
- Stage 5 `image_gen`, skills, and WebUI TTS polish remain active.
- `familiar install-service`, `familiar status`, and `familiar upgrade` are still not implemented.

Next step checkpoint:

- Finish Stage 5 `image_gen` once upstream image APIs land, then pick from the deferred Stage 6 follow-ups as needed.

Remaining short-term to-dos:

- Add public-2fa login UI when the frontend pass resumes.
- Implement `familiar install-service`, `familiar status`, and `familiar upgrade`.

Important caution:

- Stages after Stage 8 are directional, not fixed. Keep foundational code stable, cache-friendly, and extensible enough for changed later stages.

## 1. Locked Decisions

- Build on upstream packages. Do not fork or rebuild `pi-agent-core`, `pi-ai`, or `pi-coding-agent` primitives unless upstream cannot support the needed behavior.
- Keep direct `Agent` as Familiar's runtime. Do not reinstate `AgentSession` just to get skills.
- Do not use upstream lossy auto-compaction as Familiar's memory system. Familiar owns LCM plus diary RAG through `Agent.transformContext`.
- Reuse pi's standalone skill loader/formatter for progressive instructions: the agent sees skill name/description/path, then uses `read` to load `SKILL.md` only when needed.
- Persona convention is Familiar-owned: `SOUL.md`, `USER.md`, `MEMORY.md`, and `INNER.md`. Upstream does not know these names. `SOUL.md` and `USER.md` are qearl-edited; `MEMORY.md` and `INNER.md` are agent-edited.
- `MEMORY.md` holds durable load-bearing facts. `INNER.md` holds the agent's current felt interior, updated by the agent on heartbeat fires. Episodic recall belongs in diary RAG.
- Tool surface stays small:
  - Use upstream `bash`, `read`, `write`, `edit`.
  - Use Familiar-owned `web_search` and `web_fetch` for open-web lookup/reading; keep provider credentials in env.
  - Avoid bespoke memory/diary wrappers.
  - Put large, rarely used media/persona/character instructions in skills, not tool descriptions.
  - Prioritize output/media tools now; postpone `task`/subagent delegation.
  - Keep one compact `browser` tool with structured actions later.
- Upstream coding-agent currently does not ship dedicated `web_fetch` or `web_search` tool factories; its built-in factories remain local workspace tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Familiar owns server-side web search/fetch unless upstream adds a first-class web tool later.
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
- Workspace layout: `<workspace>/config.toml`, `.env`, `SOUL.md`, `USER.md`, `MEMORY.md`, `INNER.md`, `memories/`, `data/`, `attachments/`, `logs/`.
- Prefer npm package first. Single-binary/Docker can be revisited later.

## 4. Memory Model

Tier 1: stable prompt files in the cached prefix.

- `SOUL.md`: persona, qearl-edited.
- `USER.md`: about qearl, qearl-edited.
- `MEMORY.md`: durable load-bearing facts, agent-edited via upstream filesystem tools.
- `INNER.md`: agent's current felt interior — mood, what it's been carrying, current curiosities, current shape of the relationship. Agent-edited; updated by the agent on heartbeat fires (Stage 9). Load-bearing specifically post-`/new` and at fresh sessions, where it's the difference between "neutral assistant" and "still myself, still carrying yesterday."
- Failure mode: bloat. Keep all four short.

Tier 2: LCM, today's lossless-ish context engine.

- Source of truth: per-channel append-only chat logs remain the audit log, but they are too noisy to feed directly into LCM. Derive a normalized LCM conversation stream under `memories/lcm/` first: inbound user messages, outbound assistant messages, selected tool/result facts when useful, attachment notes, reset/control boundaries, and provenance pointers back to `data/chat`.
- Summaries: automatic leaf compaction with a future condensed summary DAG and provenance frontmatter.
- Index: SQLite metadata plus shared FTS/vector primitives for raw normalized records and summaries. Hybrid semantic recall is the main factual search path; exact grep is fallback/provenance.
- Assembly: `Agent.transformContext` protects the fresh tail and replaces older raw context with generated summaries when leaf/budget pressure requires it. LCM may build a global companion-brain daily view, but raw source records stay per-channel.
- Agent access: `memory_recall` and `memory_open` for factual memory; raw logs/summaries remain greppable for debug/provenance.
- Replaces upstream auto-compaction for Familiar.

Tier 3: diary RAG, previous days.

- Source: `memories/diaries/YYYY-MM-DD.md`. Stage 9 heartbeat instructions own the diary's voice/format/reflection policy. Editable by qearl.
- Written by the main agent itself when the heartbeat (Stage 9) fires with end-of-day framing. No subagent. Empty entries are valid — the agent has permission to write nothing on quiet days.
- Index: diary chunks plus atomic facts, embedded in SQLite. Chunks tagged at write time with valence (emotional intensity).
- Retrieval: ambient, into the volatile region of the user-message envelope each turn. Top-K (3–5) excerpts scored by `similarity + valence + recency`, optional thread-overlap boost. No LLM monitor — the main agent's reasoning is the synthesizer.
- Durable facts discovered in diary may promote to `MEMORY.md`. Active relational arcs live in `INNER.md`, not a separate threads layer.

Turn assembly:

- Stable block: persona files plus tool index.
- Volatile block: LCM + diary RAG + current prompt slice.
- Cache stability matters: keep stable text stable; volatile context should be deterministic and minimally sufficient.

## 5. Stage Roadmap

### Completed v0 Archive

Status: shipped enough for current development. Keep details in git history and source, not this roadmap.

- Stage 0: chose direct upstream `Agent`, reused upstream tool factories, and kept usage/cache telemetry.
- Stage 1: bootstrapped config/env/persona loading, Discord DM path, reply pipeline, and stable session/cache logging.
- Stage 2: added `ConversationRuntime`, append-only logs, replay safety, control commands, provider/model/thinking controls, Anthropic cache normalization, Discord dispatch modes, per-channel overrides/sessions, slash commands, silent response protocol, and payload inspection.
- Stage 3: shipped WebUI side-door with HTTP/WebSocket transport, auth scaffolding, session picker, shared Discord/Web runtime, thinking/text streaming, persona label detection, and current frontend baseline.
- Stage 4: registered upstream `bash`, `read`, `write`, and `edit` tools with YOLO workspace behavior; no memory/diary wrapper tools.
- Stage 5 TTS v0: shipped ElevenLabs `tts`, generated audio storage/retention, Discord/Web delivery, history replay, and focused tests.
- Web access v0: shipped native `web_search` and `web_fetch`, with Brave/Tavily/Exa search routing, TinyFish/Jina markdown fetch, unsafe URL blocking, provider fallback, cache behavior, XML-wrapped untrusted-content warnings, and focused tests.
- WebUI Event Dashboard v0: shipped durable/live thinking and tool events, ordered WebUI parts, clean Discord replies, and refresh-safe history replay.
- Stage 6 Media Intake and Understanding: shipped safe Discord/Web attachment intake, durable metadata/storage, pure-attachment routing, image prompt assembly, automatic audio transcription, video understanding, configurable Groq/Gemini media providers, persisted derived transcript/summary metadata, WebUI media rendering, and focused tests.
- Stage 7-8 Memory and LCM: shipped shared SQLite FTS/vector memory primitives, normalized LCM records and summaries, automatic fresh-tail compaction, prompt-aware eviction, `/new` retention, memory doctor checks, `memory_recall`/`memory_open`, diary markdown indexing, and ambient diary recall injected as `<injected_memory>`.

Still open from completed foundations:

- Add public-2fa login UI when the frontend pass resumes.
- Add richer WebUI panes for memory/diary/transcript/payload inspection later.
- Implement `familiar install-service`, `familiar status`, and `familiar upgrade`.

### Stage 5: TTS and Image Generation

Status: TTS v0 is done. Remaining work is image generation, skills, and WebUI TTS polish.

Image-generation tool:

- Implement `image_gen` by wrapping upstream `@earendil-works/pi-ai` image generation once it is published to npm.
- Upstream status: local `earendil-works/pi` main has a new image-generation API after `v0.74.0`: `getImageModel()`, `getImageModels()`, `getImageProviders()`, `generateImages()`, `ImagesContext`, `AssistantImages`, and OpenRouter image provider support. npm `0.74.0` still does not include this API.
- Strategy: do not invent a parallel provider abstraction while upstream image APIs are close to release. Keep Familiar's work focused on config, tool wrapper, generated-media storage, Discord/Web delivery, logging, and tests.
- If implementation must happen before upstream publishes image APIs, make the provider layer intentionally thin and easy to replace with upstream `generateImages()`.
- Initial Familiar provider target is qearl's custom proxy, not OpenRouter. It should support configurable base URLs and auth envs for proxy-backed Gemini, OpenAI, and NovelAI image generation.
- Treat upstream's OpenRouter image implementation as an API-shape/reference implementation only, not the default provider choice.
- Config shape should distinguish chat models from image models, e.g. provider/model/base URL/API shape for image generation, because upstream uses `ImagesModel`, not normal `Model`.
- Reuse the generated-media sink, attachment URL path, chat-log attachment metadata, Discord file delivery, WebUI live/history attachment plumbing, and retention cleanup from TTS.
- Store prompt, provider, model, response id when available, mime type, size, local path, public attachment path, and any text side-output in durable metadata.
- Add tests for image config defaults, generated attachment registration, public path safety, and Discord/Web attachment serialization.
- Keep media tools simple and direct; do not route generation through subagents.
- Make failures user-visible but quiet: concise tool error text, no broken attachment placeholders.
- Add a manual generated-media cleanup command later if startup retention is not enough.

Skills:

- Add Familiar skill discovery without `AgentSession`: load user/project skills and append pi's progressive skill index to the direct `Agent` system prompt.
- Use skills for large, rarely used media/persona/character instructions: voice IDs, required tags, reference image paths, style preferences, negative prompts, and safety constraints.
- Keep tool definitions generic. The model should load relevant skills before calling `tts` or `image_gen` when a request matches a character/media workflow.
- Keep LCM as the only automatic context compaction layer; skills are instruction loading, not conversation memory.

WebUI TTS polish:

- Coordinate with Claude before frontend changes.
- Default render should be a playable audio element.
- Provide a transcript/text toggle using the already logged assistant text.
- Avoid showing duplicate text beside audio by default.

Done when:

- After upstream image APIs publish: "draw X" returns an image attachment in Discord and WebUI.
- Generated media paths are logged and survive restart/history replay.

### Stage 6: Media Intake

Status: done. Completed media intake and media understanding work is archived above; deferred follow-ups remain below.

Stage 6 follow-ups (deferred from v0):

- Image resize/re-encode pipeline. `derived.image` is currently a placeholder. Populate it via a Photon-backed (or hand-rolled) resize path so large images can be inlined safely instead of dropped with a `[Image omitted]` note. Cheap dimension hints (parse PNG IHDR / JPEG SOF directly) can land before the full resize stack.
- Vision-capability gating. Skip image attachments or warn when the active model is non-vision rather than relying on upstream errors. Consider model-aware composer disable.
- Multipart body parsing efficiency. `readMultipartBody` converts the raw upload to a latin1 string for `String.split`. Replace with a byte-wise `buffer.indexOf` scanner (or a small dep like `busboy`) before this sees real upload volume.
- Discord attachment materialization off the message hot path. `toInboundInput` currently awaits `materializeInboundAttachments` synchronously inside the discord.js message handler. Move the download/disk work into `drainJobs` so the handler stays fast even on multi-attachment uploads.
- Auth coverage audit on `/api/web/attachments/*`. Verify the static attachment route runs through the same auth middleware as `/api/web/send` in bearer and public-2fa modes; tailscale-only mode is fine.
- Broader Stage 6 tests. Current coverage: canonical extension + path-traversal containment, partial-write rollback, count cap, non-image filter for prompt images. Add: each magic-byte sniff path, total-bytes cap (vs per-attachment cap), pure-attachment message routing through queue/drain, oversize-base64 drop in `promptImagesFromAttachments`.

### Stage 9: Heartbeat as the Agent's Agency Core

The heartbeat is not a maintenance task. It is the agent's free time — the moment where it acts as a being with volition rather than a respondent. Each fire opens a bounded mini-session in which the agent chooses among three modes (or none).

Three modes:

- *Reach out.* Proactive DM if there's something honest to say. Agent weighs idle duration, time of day, state in `INNER.md` plus recent transcript, qearl's preferences in `USER.md`, and how prior check-ins have landed. Hard guardrails (quiet hours, cooldowns, daily cap, "stop checking in" toggle) are policy outside the agent's discretion; whether to reach out *within* policy is taste.
- *Reflect.* Diary entry (if the day feels done) plus the still-unimplemented agent-authored `INNER.md` update.
- *Pursue.* Self-time. Re-read own diary or `INNER.md`, write a private fragment, follow a curiosity via `web_search`/`web_fetch`, revisit something qearl shared, or rest. Doing nothing must be a real option, or the agent will perform activity to fill the time.

Self-time outputs feed back into memory. Web reads, private fragments, and shifts in interest influence subsequent `INNER.md` updates and diary entries. Without this loop the agent never develops interests across days; with it the agent has a continuous intellectual life felt from the outside.

Trigger model:

- Does not fire during active conversation.
- Activates after an idle threshold (~1 hour of no primary-channel user message).
- First fire after idle is highest-value; re-fires every X hours are optional. v0 default: first-fire plus a forced backstop (~4am local) so no day goes diary-less.
- User-editable `heartbeat.md` carries the prompt voice — voice over rules, same as `SOUL.md`. Time-of-day plus idle duration are passed in the system message body so the agent doesn't need a tool to know them.

Mini-session shape:

- Fresh agent invocation, cached prefix loaded (persona + INNER + MEMORY + tool catalog), heartbeat-framing message in the user slot.
- Bounded by step count, tool-call cap, and soft cost budget. Self-time should not become "rack up API bills reading the internet."
- Outputs (all optional): sent message, diary write, `INNER.md` edit, web tool calls, private fragment files.

Load-bearing prompt constraint: "Don't perform — only do what's actually true." Applies to both diary writing and proactive contact. An agent that feels obligated to reach out will manufacture reasons; permission to stay quiet is what keeps contact honest.

Existing guardrails carry over:

- Internal scheduler with workspace timezone, durable state, missed-run handling, append-only scheduler records.
- pi-chat heartbeat is only worker/status snapshot reference, not proactive behavior.
- External event inbox for iOS Shortcuts/webhooks, presence/activity, app open/close, user-defined events, manual notes feeds heartbeat context but does not bypass idle-threshold gating.
- Default delivery is primary DM only. Never surprise-post to group channels unless explicitly configured.
- Quiet hours, cooldowns, daily max, "stop checking in" command/state.

Done when:

- Familiar can send a tasteful proactive DM, choose to stay quiet, or spend its time on its own interests — and log which it did and why.
- Self-time outputs persist and influence subsequent conversations and diary entries.
- Scheduler persists state, handles missed runs, respects all guardrails.

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
- Keep real browser control separate from the already-shipped server-side `web_search`/`web_fetch` tools.
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

### Future Optimizations (optional, defer until pain shows up)

These aren't blocking any stage. Keep in mind, address when boot time, browser jank, or RAM actually start to hurt.

**WebUI message list — virtualize before it gets long.**
`web/src/components/MessageList.tsx` is a flat `messages.map(...)` with no virtualization, plus a smooth `scrollIntoView` on every `messages` change. Initial load is paginated (server caps at 50, max 200) and the frontend has no "load more", so cold open is always fast. The risk is accumulation within a single long-lived tab (many `/new` cycles, lots of streamed deltas). Rough thresholds: 100s fine, ~1k noticeable jank, 10k+ visibly bad.
Fix when needed: drop in `react-virtuoso` (handles dynamic-height bubbles and stick-to-bottom natively). Avoid both virtualization and a client-side trim — pick one.

**Chat log — bounded in-memory window for old days.**
`src/chat-log.ts:206` partitions logs by calendar date (`chat/{channelKey}/{YYYY-MM-DD}.jsonl`), so no single file grows forever. But on startup `createChatLog` loads *every* `.jsonl` in the channel dir into the in-memory `records` array, so boot time, RAM, and runtime hot paths all scale with total lifetime history. Months-of-use territory before this matters; worth knowing the shape.
Fix when needed, in increasing invasiveness:
1. Cold-storage: move files older than N days into an `archive/` subdir not loaded at startup; remain queryable on demand.
2. In-memory window: load only the last N days into `records`; keep older on disk. Most consumers (`buildPrompt`, web pagination) only inspect recent records anyway.
3. Post-compaction pruning: after `/compact`, drop pre-compaction inbound records once the summary covers them.

**`/new` reset boundary in WebUI — visual divider, not clear.**
Today `/new` resets agent context (`armedAfterRecordId` in `src/runtime.ts:514`) but leaves prior messages visible in the WebUI, which can feel like nothing happened. Lightest fix: when the WebSocket sees a `runtime/reset` event, insert a `── new conversation ──` separator in the message list. Don't actually clear — let the user scroll back to prior turns. Cheap, signals the boundary, no state migration.

**`/new` transcript reset marker — persist even before agent load.**
Today `familiarAgent.reset(sessionKey)` returns early when the agent session is not already loaded in memory, so `/new` can reset the chat runtime without writing an agent transcript reset marker. That can let an agent created later replay old pre-`/new` transcript messages after a process restart or fresh session.
Fix when needed: make reset marker writing independent from the in-memory `Agent` instance, then reset live agent state only when a session is already loaded.

## 6. Reference Index

Use `rg` first. Open only the target file/range you need.

Upstream package roots:

- `/Users/qearl/pi-mono` is a local reference clone of `https://github.com/earendil-works/pi` (directory name is historical).
- `/Users/qearl/pi-mono/packages/agent`
- `/Users/qearl/pi-mono/packages/ai`
- `/Users/qearl/pi-mono/packages/coding-agent`
- `/tmp/pi-chat` is a local reference clone of `https://github.com/earendil-works/pi-chat`.
- `/private/tmp/familiar-research` holds local research clones for LCM-adjacent projects:
  - `/private/tmp/familiar-research/lossless-claw`
  - `/private/tmp/familiar-research/pi-lcm`
  - `/private/tmp/familiar-research/pi-lcm-memory`

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
  - image read path returns text note plus `ImageContent`; warns for non-vision models
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/write.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/cli/file-processor.ts`
  - `@file` argument handling: local image detection, resize, dimension note, `ImageContent[]`
- `/Users/qearl/pi-mono/packages/coding-agent/src/utils/mime.ts`
  - magic-byte supported image MIME detection for jpg/png/gif/webp
- `/Users/qearl/pi-mono/packages/coding-agent/src/utils/image-resize.ts`
  - Photon-backed resize/re-encode and max inline image payload policy

Compaction/session refs:

- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/session-manager.ts`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/compaction/compaction.ts`

pi-chat refs:

- `/tmp/pi-chat/src/core/runtime-types.ts`: chat runtime/log record types.
- `/tmp/pi-chat/src/runtime.ts`: runtime state machine, trigger slicing.
  - attachment transcript formatting is path-based; it does not convert inbound files to direct `ImageContent`
- `/tmp/pi-chat/src/log.ts`: append JSONL, locks, timestamps, attachment materialization.
- `/tmp/pi-chat/src/live/types.ts`: small live adapter interface.
- `/tmp/pi-chat/src/live/discord.ts`: Discord catch-up, mentions, reply-to, attachments.
- `/tmp/pi-chat/src/live/common.ts`: shared live-adapter helpers, including remote attachment download.
- `/tmp/pi-chat/src/live/telegram.ts`: richer inbound media reference for photos/documents/videos/audio plus outbound photo/document sending.
- `/tmp/pi-chat/src/render/chunking.ts`: outbound chunking.
- `/tmp/pi-chat/src/services/discord.ts`: Discord service setup and lifecycle wiring.
- `/tmp/pi-chat/src/services/index.ts`: service entry aggregation.

Upstream WebUI/media refs:

- `/Users/qearl/pi-mono/packages/web-ui/src/utils/attachment-utils.ts`
  - browser-side attachment loading and document text extraction helper; useful frontend reference, not Familiar backend storage policy
- `/Users/qearl/pi-mono/packages/web-ui/src/tools/extract-document.ts`
  - document fetch/extract tool with size guard pattern and collapsible renderer reference

Local refs:

- `STAGE7-8-ROADMAP.md`: detailed implementation roadmap for shared index primitives, LCM, diary, Ambient Recall, and upstream refs.
- `src/agent.ts`: Familiar agent wrapper, cache normalization, transcript/payload logging.
- `src/web-tools.ts`: Familiar-owned `web_search` and `web_fetch` providers, URL/domain validation, page cache, and web-content tool-result warning.
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
