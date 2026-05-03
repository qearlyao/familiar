# familiar plan

Personal Discord-first companion agent for qearl. VPS-hosted, always on, single user, reactive in v0, with a Mac sidecar for real Chrome/CDP control over Tailscale.

This plan is based on the actual upstream code in `/Users/qearl/pi-mono` and `/tmp/pi-chat`. It does not fork or rebuild primitives that upstream already provides.

## A. What pi-mono already gives us

### Packages

- Root `pi-mono` is a private workspace, not the published package: `package.json:2-7`. Its publish script publishes workspaces: `package.json:27-29`.
- `@mariozechner/pi-ai` is the provider/model package. It has package name, exports, `files`, and `prepublishOnly`: `packages/ai/package.json:2-8`, `packages/ai/package.json:57-68`. It exports provider subpaths plus stream/model/types APIs: `packages/ai/src/index.ts:4-28`.
- `@mariozechner/pi-agent-core` is the reusable agent runtime. It has package name, `main`, `types`, `files`, and `prepublishOnly`: `packages/agent/package.json:2-17`. It exports `Agent`, loop functions, proxy helpers, and types: `packages/agent/src/index.ts:1-8`.
- `@mariozechner/pi-coding-agent` is the CLI and SDK layer. It has package name, `pi` binary, exports root plus `./hooks`, package files, and `prepublishOnly`: `packages/coding-agent/package.json:2-38`. It reexports `AgentSession`, compaction, session manager, extension APIs, SDK factories, skills, and tool factories: `packages/coding-agent/src/index.ts:5-49`, `packages/coding-agent/src/index.ts:132-190`, `packages/coding-agent/src/index.ts:191-281`.
- `@mariozechner/pi-tui` and `@mariozechner/pi-web-ui` are separate UI packages: `packages/tui/package.json:2-17`, `packages/web-ui/package.json:2-11`. Familiar v0 does not need either unless the web side-door later wants pi-web-ui components.
- The monorepo README lists all five packages and points chat automation users at pi-chat: `README.md:46-58`.

Registry note: the local manifests prove the packages are publishable workspaces. Use the local workspace during initial familiar development if exact npm version parity matters.

### Agent runtime

- `Agent` owns transcript state, lifecycle events, tools, and steering/follow-up queues: `packages/agent/src/agent.ts:152-158`.
- Constructor options already cover `convertToLlm`, `transformContext`, `streamFn`, API key lookup, provider payload/response hooks, tool hooks, queue modes, `sessionId`, transport, retry delay, and tool execution mode: `packages/agent/src/agent.ts:93-111`, `packages/agent/src/agent.ts:190-207`.
- Agent state already stores system prompt, model, thinking level, tools, messages, streaming state, pending tool calls, and errors: `packages/agent/src/types.ts:288-313`.
- Message format is upstream-owned. `AgentMessage` is LLM messages plus app-defined custom messages: `packages/agent/src/types.ts:257-280`.
- `prompt()` accepts text, one message, or a batch. Text input becomes a user message with text, optional images, and a millisecond timestamp: `packages/agent/src/agent.ts:312-323`, `packages/agent/src/agent.ts:355-372`.
- `steer()`, `followUp()`, queue clearing, and queue drain modes already exist: `packages/agent/src/agent.ts:251-280`.
- The loop emits prompt messages, streams the assistant, executes tool calls, handles steering between turns, then handles follow-ups after the agent would otherwise stop: `packages/agent/src/agent-loop.ts:95-117`, `packages/agent/src/agent-loop.ts:155-245`.
- `transformContext` runs immediately before LLM conversion. This is the correct insertion point for familiar RAG recall if using `pi-agent-core` directly: `packages/agent/src/agent-loop.ts:252-267`.
- The LLM context is assembled from `systemPrompt`, transformed messages, and tools. Familiar should provide inputs to that context, not rewrite the loop: `packages/agent/src/agent-loop.ts:268-273`.
- Agent events cover agent, turn, message, streaming update, and tool execution lifecycle: `packages/agent/src/types.ts:374-389`.

### Tool runtime

- Generic tool shape is already defined: label, TypeBox schema, optional argument preparation, execute function, streaming updates, structured details, terminate flag, and per-tool execution mode: `packages/agent/src/types.ts:315-355`.
- Tool batches run sequentially or in parallel. Sequential mode is automatic if any called tool declares `executionMode: "sequential"`: `packages/agent/src/agent-loop.ts:350-365`, `packages/agent/src/agent-loop.ts:424-483`.
- Tool lookup, argument preparation, schema validation, and `beforeToolCall` blocking already exist: `packages/agent/src/agent-loop.ts:529-571`.
- Tool execution already supports streaming partial updates, error capture, and `afterToolCall` result overrides: `packages/agent/src/agent-loop.ts:581-661`.
- Tool results are already converted into `toolResult` messages with text/images/details/error/timestamp: `packages/agent/src/agent-loop.ts:680-689`.
- `pi-agent-core` has the runtime only. It does not ship concrete bash or memory tools: `packages/agent/src/index.ts:1-8`.

### Coding tools

- `pi-coding-agent` ships tool factories for `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`: `packages/coding-agent/src/core/tools/index.ts:81-95`, `packages/coding-agent/src/core/tools/index.ts:117-195`.
- SDK exports expose `createBashTool`, `createCodingTools`, `createReadOnlyTools`, and individual tool factories: `packages/coding-agent/src/index.ts:164-190`.
- Bash already supports custom operations, local shell operations, command prefixes, shell path, spawn hook, streaming output, timeout, truncation, and temp-file full output: `packages/coding-agent/src/core/tools/bash.ts:45-67`, `packages/coding-agent/src/core/tools/bash.ts:75-161`, `packages/coding-agent/src/core/tools/bash.ts:273-407`.
- Read already supports pluggable operations, text files, images, truncation, and offsets: `packages/coding-agent/src/core/tools/read.ts:52-76`, `packages/coding-agent/src/core/tools/read.ts:216-235`.
- Write already supports pluggable operations and queued file mutation: `packages/coding-agent/src/core/tools/write.ts:21-40`, `packages/coding-agent/src/core/tools/write.ts:181-241`.
- There is no upstream memory tool. Familiar uses upstream `read`/`write`/`edit` plus `bash` (for shell `grep`) over `MEMORY.md` and `data/diaries/` instead of bespoke memory wrappers.

### Prompt caching

- Prompt caching is already modeled in `pi-ai` through `cacheRetention: "none" | "short" | "long"` and `sessionId`: `packages/ai/src/types.ts:64-95`.
- Provider usage already reports `cacheRead` and `cacheWrite`, and cost calculation includes both: `packages/ai/src/types.ts:196-209`, `packages/ai/src/models.ts:39-45`.
- `Agent` forwards `sessionId` to provider stream options: `packages/agent/src/agent.ts:179-180`, `packages/agent/src/agent.ts:410-416`.
- OpenAI Responses defaults to short retention, honors `PI_CACHE_RETENTION=long`, uses `sessionId` unless caching is disabled, sets session headers, and sends `prompt_cache_key` / `prompt_cache_retention`: `packages/ai/src/providers/openai-responses.ts:26-38`, `packages/ai/src/providers/openai-responses.ts:91-96`, `packages/ai/src/providers/openai-responses.ts:189-194`, `packages/ai/src/providers/openai-responses.ts:221-229`.
- Anthropic defaults to short retention, supports long TTL, and adds `cache_control` to system prompt, last user content, and last tool definition: `packages/ai/src/providers/anthropic.ts:40-67`, `packages/ai/src/providers/anthropic.ts:868-905`, `packages/ai/src/providers/anthropic.ts:1115-1137`, `packages/ai/src/providers/anthropic.ts:1146-1167`.
- Provider-level compatibility docs also define Anthropic-style cache control and session-affinity headers for compatible OpenAI-style providers: `packages/ai/src/types.ts:314-319`.
- The `.pi/extensions/tps.ts` extension in pi-mono demonstrates reading assistant usage and reporting cache read/write totals: `.pi/extensions/tps.ts:25-45`.

Conclusion: familiar should set a stable `sessionId`, choose `cacheRetention`, assemble stable prompt text carefully, and log usage. It should not implement manual cache breakpoints.

### Context management and compaction

- `pi-agent-core` provides hooks, not compaction. The relevant hook is `transformContext`: `packages/agent/src/agent.ts:93-98`, `packages/agent/src/agent-loop.ts:252-267`.
- `pi-coding-agent` does provide compaction primitives and exports `compact`, `shouldCompact`, `estimateTokens`, `DEFAULT_COMPACTION_SETTINGS`, and related helpers: `packages/coding-agent/src/index.ts:27-49`.
- `AgentSession` explicitly owns session persistence, model/thinking state, manual and automatic compaction, and bash execution: `packages/coding-agent/src/core/agent-session.ts:1-13`.
- Compaction events are first-class session events: `packages/coding-agent/src/core/agent-session.ts:119-139`.
- Default compaction is enabled, reserves 16384 tokens, and keeps 20000 recent tokens: `packages/coding-agent/src/core/compaction/compaction.ts:115-125`.
- Manual compaction aborts current work, prepares a branch, lets extensions override via `session_before_compact`, runs `compact()`, appends a compaction entry, and rebuilds agent messages: `packages/coding-agent/src/core/agent-session.ts:1603-1719`.
- Auto compaction runs after `agent_end`, handles overflow retry and threshold compaction, then rebuilds agent messages: `packages/coding-agent/src/core/agent-session.ts:571-584`, `packages/coding-agent/src/core/agent-session.ts:1764-1841`, `packages/coding-agent/src/core/agent-session.ts:1847-2002`.
- Session context rebuild already emits a compaction summary plus kept recent messages: `packages/coding-agent/src/core/session-manager.ts:310-421`.
- Upstream docs are explicit that this compaction is lossy while full JSONL history remains: `packages/coding-agent/README.md:260-268`.

Conclusion: do not build generic context compaction in familiar. Familiar may reuse `AgentSession`/`SessionManager` compaction, but familiar still needs its own queryable memory/RAG because upstream compaction is lossy and coding-session shaped.

### Persistence

- `pi-agent-core` has in-memory agent state only: `packages/agent/src/types.ts:288-313`.
- `pi-coding-agent` persists sessions as JSONL entries, not SQLite. Session entry types include messages, model changes, thinking changes, compaction entries, branch summaries, custom entries, custom messages, labels, and session info: `packages/coding-agent/src/core/session-manager.ts:30-147`.
- `AgentSession` persists `user`, `assistant`, and `toolResult` messages on `message_end`: `packages/coding-agent/src/core/agent-session.ts:528-546`.
- `SessionManager` builds LLM-visible context from the active branch and compaction entries: `packages/coding-agent/src/core/session-manager.ts:310-421`.
- Default session directory is under `~/.pi/agent/sessions/--cwd--`: `packages/coding-agent/src/core/session-manager.ts:424-435`.

Conclusion: familiar needs chat/channel logs and RAG storage. It can either also use upstream JSONL sessions for agent transcripts or keep its own message log and hydrate `Agent.state.messages`.

### System prompt assembly

- There is no upstream `SOUL.md`, `USER.md`, or single `MEMORY.md` convention.
- Upstream coding-agent convention loads `AGENTS.md` or `CLAUDE.md` from global agent dir and cwd ancestors: `packages/coding-agent/src/core/resource-loader.ts:58-114`.
- Upstream also discovers `.pi/SYSTEM.md` and `APPEND_SYSTEM.md`: `packages/coding-agent/src/core/resource-loader.ts:461-475`, `packages/coding-agent/README.md:294-308`.
- `buildSystemPrompt()` accepts custom prompt, selected tools, tool snippets, guidelines, append prompt, cwd, context files, and skills: `packages/coding-agent/src/core/system-prompt.ts:8-25`.
- With a custom prompt, upstream appends append prompt, project context files, skills if read is available, current date, and cwd: `packages/coding-agent/src/core/system-prompt.ts:53-80`.
- With the default prompt, upstream constructs tool list/guidelines, appends context files and skills, then adds date/cwd last: `packages/coding-agent/src/core/system-prompt.ts:87-171`.

Conclusion: familiar owns `SOUL.md`, `USER.md`, and `MEMORY.md` conventions. It should reuse prompt-building patterns, not assume upstream has these filenames.

### Embeddings and RAG

- `pi-ai` exports model/provider/streaming APIs, not embedding APIs: `packages/ai/src/index.ts:4-28`, `packages/ai/src/stream.ts:43-50`.
- Code search found no embedding adapter, vector store, `sqlite-vec`, or RAG implementation in `packages/ai`, `packages/agent`, `packages/coding-agent`, or `pi-chat` source.

Conclusion: RAG from v0 remains a real familiar delta.

### Extension system

- `pi-coding-agent` exports extension types and runner helpers: `packages/coding-agent/src/index.ts:51-147`.
- Extension tool definitions include name, label, description, prompt snippets/guidelines, TypeBox params, preparation, execution mode, execute callback, and render hooks: `packages/coding-agent/src/core/extensions/types.ts:423-465`.
- Extension events include `context`, `before_provider_request`, `after_provider_response`, and `before_agent_start`: `packages/coding-agent/src/core/extensions/types.ts:604-634`.
- Extension API handlers include `session_before_compact`, `session_compact`, `context`, `before_agent_start`, agent/message/tool events, and `registerTool`: `packages/coding-agent/src/core/extensions/types.ts:1089-1135`.
- Extensions can register tools and hook session/agent/provider/tool/input/resource events; pi-chat is implemented as such an extension: `/tmp/pi-chat/index.ts:7-18`, `/tmp/pi-chat/package.json:17-20`.
- Familiar does not need to be a pi extension, but pi-chat proves the extension layer can wire chat surfaces onto upstream sessions.

### `.pi` inside pi-mono

- `.pi` contains prompt templates and extensions, not a companion runtime convention: `.pi/prompts/cl.md`, `.pi/prompts/is.md`, `.pi/prompts/pr.md`, `.pi/prompts/wr.md`, `.pi/extensions/prompt-url-widget.ts`, `.pi/extensions/redraws.ts`, `.pi/extensions/tps.ts`.
- The relevant lesson is usage instrumentation from `.pi/extensions/tps.ts:25-45`.

## B. What pi-chat shows us how to do

- Architecture: Discord/Telegram live adapter -> runtime log/jobs/slices -> pi agent, with a VM for tool execution: `/tmp/pi-chat/AGENTS.md:5-18`.
- Storage layout: one config root, account shared storage, per-channel JSONL log, lock, workspace, incoming attachments, memory files, and VM state: `/tmp/pi-chat/AGENTS.md:70-91`, `/tmp/pi-chat/README.md:98-121`.
- Config resolution creates a `ResolvedConversation` with account dir, shared dir, conversation dir, workspace dir, memory paths, log path, files dir, and lock path: `/tmp/pi-chat/src/config.ts:53-85`.
- Runtime owns the chat state machine. It connects with a lock, reads the JSONL log, arms after catch-up, filters access, parses remote commands, ingests inbound records, queues trigger jobs, builds prompt slices, completes/fails jobs, and searches history: `/tmp/pi-chat/src/runtime.ts:67-110`, `/tmp/pi-chat/src/runtime.ts:144-172`, `/tmp/pi-chat/src/runtime.ts:199-257`, `/tmp/pi-chat/src/runtime.ts:259-333`.
- Log helpers ensure dirs, append JSONL, lock stale owners, store attachments safely, and stamp ISO timestamps: `/tmp/pi-chat/src/log.ts:57-90`, `/tmp/pi-chat/src/log.ts:110-141`, `/tmp/pi-chat/src/log.ts:144-177`.
- Live adapter interface is small and worth lifting: `onMessage`, `onCaughtUp`, `onError`, `onDisconnect`, plus `send`, `sendImmediate`, typing, streaming preview, and reply-to: `/tmp/pi-chat/src/live/types.ts:4-31`.
- Discord adapter uses `discord.js`, requires message content intent, filters channel/server/bot self messages, downloads attachments, detects bot mentions, catches up by pagination, listens to `MessageCreate`, sends chunked messages, uploads attachments, maintains reply-to, and handles disconnect: `/tmp/pi-chat/src/live/discord.ts:15-40`, `/tmp/pi-chat/src/live/discord.ts:62-100`, `/tmp/pi-chat/src/live/discord.ts:119-156`, `/tmp/pi-chat/src/live/discord.ts:158-181`, `/tmp/pi-chat/src/live/discord.ts:183-255`.
- Shared attachment helpers store downloads under conversation incoming files, guess MIME/kind, and detect bot mentions: `/tmp/pi-chat/src/live/common.ts:10-30`, `/tmp/pi-chat/src/live/common.ts:32-62`, `/tmp/pi-chat/src/live/common.ts:72-90`.
- Rendering helpers handle Discord/Telegram markdown differences, service limits, chunking, and streaming preview edits: `/tmp/pi-chat/src/render/format.ts:20-31`, `/tmp/pi-chat/src/render/chunking.ts:3-60`, `/tmp/pi-chat/src/render/streaming.ts:23-85`.
- Root extension wires live chat into the pi session: connect, decrypt secrets, handle `stop`/`compact`/`status`/`new`, reconnect on disconnect, show context, dispatch queued jobs, send final text and attachments: `/tmp/pi-chat/index.ts:654-793`, `/tmp/pi-chat/index.ts:1075-1099`, `/tmp/pi-chat/index.ts:1396-1467`.
- Root extension registers chat tools for worker status, history, outbound attachments, and encrypted secret requests: `/tmp/pi-chat/index.ts:901-1073`.
- Root extension delegates upstream `read`, `write`, `edit`, and `bash` tools into a sandbox by supplying custom operations, then blocks non-allowlisted tools during remote chat turns: `/tmp/pi-chat/index.ts:1300-1344`, `/tmp/pi-chat/index.ts:1123-1133`.
- Root extension filters chat-context custom messages out of LLM context, then appends chat prompt, memory, skills, and `SYSTEM.md` only for chat dispatch: `/tmp/pi-chat/index.ts:796-822`, `/tmp/pi-chat/index.ts:1362-1394`.

Patterns to lift:

- Keep chat intake/runtime separate from agent runtime.
- Use an append-only per-channel event log as source of truth.
- Arm after catch-up so reconnect replay does not trigger old jobs.
- Build per-turn prompt slices from records since the last completed trigger.
- Keep remote control commands before normal ingestion.
- Use one small live adapter interface for Discord and web side-door.
- Preserve reply-to and typing state around each active job.
- Treat history search and outbound attachment queue as tools, not hidden state.

Patterns not to copy blindly:

- pi-chat has two memory files per account/channel. Familiar locked a single global `MEMORY.md`.
- pi-chat uses Gondolin VM sandbox. Familiar locked YOLO bash on the VPS.
- pi-chat is a pi extension. Familiar can be a standalone daemon using upstream packages directly.
- pi-chat does not implement embeddings, RAG, media understanding, side-door auth, WebUI, TTS, image generation, or Mac sidecar.

## C. What familiar needs to add

Only the delta below belongs in familiar:

- Standalone daemon package: `familiar init`, `familiar run`, `familiar install-service`, config loading, env interpolation, logging, health/status.
- Discord-first single-owner intake: adapt pi-chat's live adapter/runtime patterns for qearl, DMs first, qearl-authorized channels later.
- Web side-door channel: HTTP/WebSocket adapter that implements the same live connection shape as Discord.
- Channel/session model: Discord DM, Discord group/thread, and web as separate conversation channels, with one global memory/RAG store.
- Chat persistence: append-only channel logs for inbound/outbound/checkpoint/job/error records, plus attachment materialization. Upstream has coding-session JSONL, not familiar chat logs.
- Persona prompt assembly: load `SOUL.md`, `USER.md`, single `MEMORY.md`, tool list, current channel metadata, ISO timestamped recent messages, LCM context, and diary RAG recall into an upstream `Agent`. Insertion point is `Agent.transformContext`: `packages/agent/src/agent-loop.ts:252-267`.
- Three-tier memory: see section D5. Familiar splits memory into stable system-prompt files, an in-session lossless context engine (LCM), and a cross-session diary RAG. Upstream provides none of these.
- LCM (in-session, today): per-channel JSONL chat logs and markdown summary files on disk. SQLite embedding index is internal to `transformContext`, not exposed. DAG of leaf and condensed summaries with frontmatter pointers. Replaces upstream lossy compaction.
- Diary RAG (cross-session, past days): per-day reflective markdown in `data/diaries/YYYY-MM-DD.md`. Two-tier embedding index (full-diary chunks + atomic facts) is internal to `transformContext`. Top-K auto-injection on each turn. File watcher re-embeds on edit.
- Diary writer: end-of-day cron (or "good night" signal) dispatches a Stage 5 subagent. Subagent uses upstream `read` for prior diary, `bash` (`grep`) over today's chat logs, `write`/`edit` to save the file. No `write_diary` wrapper.
- No new memory tools. Agent uses upstream `read`, `write`, `edit`, plus `bash` (for grep/ls/find via shell) over `data/diaries/`, today's chat logs, summary files, and `MEMORY.md`. Embedding-based recall is automatic via `transformContext`.
- Tool wiring: register upstream `createBashTool`/read-only tools with familiar policy. Do not reimplement bash.
- Media intake: voice transcription and video understanding through Gemini before a message enters the agent.
- Output tools: TTS and image generation tools that queue attachments for the next live reply.
- Side-door auth: `tailscale-only`, `bearer`, and `public-2fa`.
- WebUI v0: small static UI served by side-door, using the web channel, live events, status, and logs.
- Mac sidecar client: `mac.*` tools that call a separate `familiar-mac` service over Tailscale.
- Mac sidecar service: separate repo/process with Playwright CDP to real Chrome, screenshot, screen read, and constrained exec.

Do not add:

- A custom agent loop.
- A custom generic tool executor.
- Manual provider cache breakpoint machinery.
- A new bash implementation.
- Upstream prompt conventions that do not exist, such as assuming pi-mono knows `SOUL.md`.
- Upstream lossy auto-compaction. LCM (Stage 6) is the in-session context engine and replaces it.
- Wrapper tools around `read`/`write`/`edit`/`bash` for memory or diary operations. Agent uses the upstream filesystem tools directly (and shells out via `bash` for `grep`/`ls`/`find`). Embedding-based recall is automatic via `transformContext`, not exposed as a tool.

## D. Architecture diagram

```
familiar on VPS

  Discord gateway adapter
          |
  Web side-door adapter
          |
          v
  Familiar chat runtime
    - channel registry
    - append-only chat logs
    - attachment store
    - trigger/job slicing
    - remote control commands
          |
          v
  Familiar context and memory layer
    tier 1 (always loaded in system prompt):
      SOUL.md, USER.md, MEMORY.md
    tier 2 (in-session, today):
      JSONL chat logs + markdown summary files
      SQLite embedding index (internal to transformContext)
    tier 3 (cross-session, past days):
      data/diaries/YYYY-MM-DD.md (reflective markdown)
      Gemini embeddings, FTS5 + vec (internal index)
      auto top-K injection on each turn
    agent operates on all of the above via upstream
      bash, read, write, edit
    media intake: STT, video understanding
          |
          v
  pi-mono primitives
    - @mariozechner/pi-agent-core Agent, loop, events, steer/followUp, transformContext
    - @mariozechner/pi-ai models, streaming, provider cache, usage/cost
    - @mariozechner/pi-coding-agent tool factories, optional SessionManager/AgentSession/compaction
          |
          v
  Tool implementations
    - upstream bash/read/write/edit/grep/find/ls where useful
    - familiar memory, tts, image_gen, mac.*

  Tailscale + bearer auth
          |
          v

familiar-mac on Mac
  - Playwright CDP to real Chrome on --remote-debugging-port=9222
  - screencapture
  - read visible browser state
  - constrained exec
  - launchd start-at-login
```

## D1. Subagent delegation

Goal: main familiar agent can spawn focused subagents for delimited tasks: research, multi-step browser flows on the Mac, long-running bash work, and summarization passes. The main agent then incorporates their results into its own context.

### What upstream provides

- Upstream does not provide a subagent primitive. Search found no `subagent`, `createTaskTool`, `session_create`, or public task-delegation SDK in `packages/agent/src`, `packages/coding-agent/src`, or `/tmp/pi-chat`.
- `Agent` can be instantiated independently with its own transcript, event listeners, tools, queues, `sessionId`, `transformContext`, and tool hooks: `packages/agent/src/agent.ts:152-207`.
- `Agent.subscribe()`, `steer()`, `followUp()`, `abort()`, `waitForIdle()`, and `prompt()` are enough to host a child-like agent from familiar code: `packages/agent/src/agent.ts:219-222`, `packages/agent/src/agent.ts:251-323`.
- `createAgentSession()` is a top-level session factory. Its options cover cwd, agent dir, model, tool allowlist, custom tools, resource loader, session manager, and settings manager: `packages/coding-agent/src/core/sdk.ts:33-90`.
- `createAgentSession()` creates one normal `Agent`, wires extension hooks, restores session messages, then wraps it in `AgentSession`: `packages/coding-agent/src/core/sdk.ts:193-205`, `packages/coding-agent/src/core/sdk.ts:279-405`.
- `AgentSessionRuntime` owns one current session and supports switch, new, fork, import, and dispose. These replace or branch the active session; they are not parent/child task execution: `packages/coding-agent/src/core/agent-session-runtime.ts:60-77`, `packages/coding-agent/src/core/agent-session-runtime.ts:175-320`, `packages/coding-agent/src/core/agent-session-runtime.ts:376-400`.
- Exported coding-agent tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. There is no task tool factory: `packages/coding-agent/src/core/tools/index.ts:81-195`, `packages/coding-agent/src/index.ts:164-190`.
- pi-chat does not implement subagent delegation. Its `spawnConversationTmux()` starts detached tmux sessions per configured conversation, and `chat-spawn-all` launches those workers: `/tmp/pi-chat/index.ts:353-384`, `/tmp/pi-chat/index.ts:1180-1192`.

### Familiar subagent design

- Subagent factory: create a fresh upstream `Agent` with a focused system prompt, scoped tool list, stable subagent `sessionId`, isolated event stream, and the same provider/cache plumbing as the parent.
- `task` tool arguments: `goal`, `context`, `allowedTools`, `timeoutMs`, `maxSteps`, `maxToolCalls`, `returnShape`, `allowMemory`, `allowRag`, and `attachmentPolicy`.
- Execution semantics: default blocking tool call with live streaming mirrored to the channel event log. Optional streaming mode sends interim subagent assistant text and tool events to the user while the parent waits.
- Result format: `{ id, status, text, details, attachments, usage, startedAt, finishedAt, error? }`. `text` is the parent-readable answer. `details` carries citations, commands, files, browser state, or summary metadata.
- Context isolation: subagent does not inherit the full main transcript. It receives only `goal`, explicit parent-passed context, selected attachments, and any memory/RAG access allowed by flags.
- Parent observability: every subagent assistant delta, tool call, tool result, and final result is mirrored into familiar's event log so the user and main agent can inspect what happened.
- Persistence: subagent transcripts are stored under the current channel event log using record kind `subagent`, keyed by subagent id and parent turn id.
- Safety: subagents respect the same tool allowlist policy as remote chat turns. No subagent can silently escalate from read-only to bash, memory write, or Mac control.
- Cost and loop guards: default max depth 1, configurable per task type. Enforce max wall time, max steps, max tool calls, max output bytes, and cancellation through `Agent.abort()`.
- Failure handling: subagent failures become `task` tool errors. The main agent decides whether to retry, ask for more context, or surface the error to qearl.

## D2. Runtime model

- VPS process: one `familiar` daemon. Single Node process owns Discord gateway connection, side-door HTTP and WebSocket server, main agent, subagent runner, RAG worker, embedding worker, attachment writer, and in-process queues.
- Mac process: one `familiar-mac` daemon in a separate repo and launchd service. It stays outside pi-mono and keeps real Chrome/CDP state on the Mac.
- No gateway/API split in v0. All transports are embedded in the daemon.
- Dev invocation: `familiar run <workspace>` runs foreground.
- Prod VPS invocation: `familiar install-service <workspace>` writes a systemd unit, enables it, starts it, and leaves logs available through `journalctl -u familiar`.
- Prod Mac invocation: launchd plist for `familiar-mac`, start at login.
- Process layout: one process, multiple internal workers. Embeddings and summary roll-up run as in-process queues.
- Logging: structured JSON to stdout, pino-style. systemd and launchd capture logs. No bespoke daemon log files. Upstream uses console logging in CLI/runtime helpers, so familiar owns structured logging: `packages/coding-agent/src/core/event-bus.ts:12-24`, `packages/coding-agent/src/cli.ts:1-22`.
- Restart and crash recovery: rely on systemd/launchd auto-restart. Append-only chat logs survive crash, and embedding work is idempotent. pi-chat's log helpers already model append-only records and ISO stamps: `/tmp/pi-chat/src/log.ts:57-90`, `/tmp/pi-chat/src/log.ts:173-177`.
- Upgrade story: `familiar upgrade` or `npm install -g @qearl/familiar@latest`, then restart service. Config and workspace remain untouched.
- Health: `/status` endpoint plus `familiar status` CLI subcommand that hits it.

## D3. Distribution and packaging

Audience: qearl plus a small number of technical friends, with one owner per install.

Default: npm package with a `bin` named `familiar`.

- Candidate A, npm package: `npm i -g @qearl/familiar`, then `familiar init <workspace>` and `familiar install-service <workspace>`. Pros: simplest to ship, matches upstream package/bin shape, works with pi-mono npm deps, and upgrades are normal npm operations. Cons: requires Node >=22 on host. Upstream publishes workspace packages with dist files and bins: `packages/coding-agent/package.json:9-38`, `packages/coding-agent/src/cli.ts:1-22`.
- Candidate B, prebuilt single binary with `bun build --compile` or `pkg`: curl install script. Pros: no Node on host. Cons: native deps like sqlite-vec and better-sqlite3 make packaging harder, artifacts are larger, and upgrades are slower. Upstream only uses `bun build --compile` for the optional pi binary path: `packages/coding-agent/package.json:33-36`.
- Candidate C, Docker image: clean environment. Cons: Discord gateway, Tailscale, workspace volumes, service credentials, and Mac sidecar networking add ops weight that is overkill for one owner.

Recommendation: ship npm first. It matches upstream, keeps native module install behavior in npm, and makes the code dir replaceable while the workspace remains the source of truth.

- Workspace layout: `<workspace>/config.toml`, `SOUL.md`, `USER.md`, `MEMORY.md`, `data/`, `attachments/`, and `logs/`. `logs/` is reserved for exported/debug snapshots; daemon logs still go to stdout.
- `familiar init <workspace>`: scaffold config, generate bearer/TOTP secrets, write stub persona files, and create data dirs.
- `familiar run <workspace>`: foreground daemon for testing.
- `familiar install-service <workspace>`: write systemd unit on Linux or launchd plist on macOS, enable it, and print next steps.
- `familiar upgrade`: stop service, run npm update or replace binary, restart service.
- Secrets: env-only or workspace-level `.env`. Never store secrets in `config.toml`.
- Upgrade safety: workspace dir is source of truth; code dir is replaceable.
- Build steps: TypeScript compiled to JS for npm package, output to `dist/`, ship precompiled JS so install is fast. Use `tsc` for familiar unless pi-mono's `tsgo` becomes a direct dependency. Native modules install through npm scripts. Upstream build/check patterns are `tsgo` plus Biome/Vitest, while pi-chat uses `tsc --noEmit` for extension checking: `package.json:13-29`, `packages/coding-agent/package.json:30-38`, `/tmp/pi-chat/package.json:28-41`.

## D4. Extensibility seams

Single-owner only. Extensibility means new capabilities for qearl's install, not more users.

- Channel adapters: file boundary `src/channels/*`. Implement a `LiveConnection`-style interface from pi-chat for Discord and web side-door in v0: `/tmp/pi-chat/src/live/types.ts:4-31`.
- Tool registry: file boundary `src/tools/index.ts`. Register and unregister tools at startup using upstream tool shape; adding a tool is one file and one registration line: `packages/agent/src/types.ts:315-355`, `packages/agent/src/agent-loop.ts:529-661`.
- Triggers: file boundary `src/triggers/*`. `/event` is shaped for proactive triggers; cron, presence, and iOS Shortcut webhooks plug in later as event sources.
- Memory backend: file boundary `src/memory/backend.ts`. SQLite is v0, but recall/store is an internal interface. Postgres/pgvector later is an adapter swap.
- Embedding provider: file boundary `src/embeddings/*`. Gemini is v0. OpenAI, Voyage, or local embeddings become config changes plus adapter wiring.
- LLM provider: file boundary `src/llm.ts`. `pi-ai` abstracts provider/model selection, and familiar config picks provider/model without call-site changes: `packages/ai/src/index.ts:4-28`.
- Persona files: file boundary `src/persona.ts`. `SOUL.md`, `USER.md`, and `MEMORY.md` paths are configurable.
- Subagents: file boundary `src/subagents/*`. Tool list and persona prompt are per subagent. Adding specialized subagents means new persona prompt plus tool subset, not new runtime paths.
- Diary writer: file boundary `src/diary/`. End-of-day trigger and the diary-writer subagent persona live here. Diary file format and embedding scheme are owned here. The agent uses upstream `write`/`edit`/`read` to operate on the files; no diary-specific tool. Replacing or augmenting the diary backend later is contained.
- Explicitly not a seam: multi-user. Single-owner is locked.

## D5. Three-tier memory

Familiar runs three memory layers, each with a distinct time horizon, mechanism, and failure mode. They do not overlap.

Tier 1: always loaded in system prompt.
- Files: `SOUL.md` (persona, qearl edits), `USER.md` (about qearl, qearl edits), `MEMORY.md` (load-bearing stable facts about qearl/world, agent edits via upstream `edit`/`write`).
- Scope: small, evergreen. Anything that should always shape behavior.
- Failure mode: bloat. MEMORY.md must stay short. Agent migrates only durable facts here, not episodic events.

Tier 2: in-session lossless context engine (LCM).
- Scope: today's open conversation across all channels.
- Storage: per-channel JSONL chat logs (pi-chat pattern) under `data/chat/{channel}/{date}.jsonl`, plus markdown summary files under `data/lcm/{date}/leaf-NNN.md` and `condensed-NNN.md`. Each summary file has frontmatter pointing to its source records (file path + offset for raw, or summary id for child summaries).
- Compression: DAG of leaf summaries (chunks of raw messages up to a token budget) and condensed summaries (recursive condensation of leaf summaries). Fresh-tail count of recent raw messages is protected from compaction.
- Embedding index: a SQLite database holds vectors for raw and summary records, used internally by the assembler. Not an agent tool.
- Assembly: each turn, `Agent.transformContext` selects fresh tail plus the minimal summary set to fit the model window. Triggered when the assembled context exceeds a threshold (~75% of window).
- Tools: none. Agent uses upstream `bash` (for `grep`) and `read` over the chat logs and summary files when it wants to look harder than auto-injection gave it.
- Failure mode: a bad summary at depth N pollutes everything above it. Mitigation: store summary node provenance in frontmatter, allow qearl to edit the markdown directly, file watcher re-embeds.
- Replaces: upstream `pi-coding-agent` lossy compaction is not used. Two compaction systems on the same `Agent.state.messages` is a non-goal.

Tier 3: cross-session diary RAG.
- Scope: previous days, indefinitely.
- Storage: one reflective markdown file per day under `data/diaries/YYYY-MM-DD.md`. Plain markdown, editable, greppable, version-controllable. A SQLite index holds embeddings, used internally by the assembler.
- Trigger: end-of-day cron in user timezone, or a "good night" / `/diary` signal that prompts the main agent to dispatch the diary subagent via `task`. No bespoke diary tool.
- Authorship: the diary-writer subagent (Stage 5) gets the goal "write today's diary." It uses upstream `read` for yesterday's diary, `bash` (`grep`) over today's chat logs, then `write` or `edit` to save the file. Prompt template: what happened, what mattered, what is open, what is new about qearl, what should I remember. Not a transcript.
- Indexing: two-tier. Full-diary chunks embedded for narrative recall, plus atomic-fact extraction (1-line claims with date pointers) embedded separately for precise lookup. Both internal to the assembler.
- Recall: `Agent.transformContext` queries the embedding index with the current message, gets top-K relevant chunks/facts, injects them with source-date hints. The agent reads the source diary directly via `read` if it wants more.
- Editability: file watcher re-embeds on edit. Agent gets things wrong, qearl fixes the file, the index updates.
- Tools: none. Agent uses upstream `read`/`write`/`edit` and `bash` (for `grep`) over `data/diaries/`.
- Failure mode: diary drifts from MEMORY.md. Convention: diary records what happened; if a fact in the diary is durable enough to be load-bearing, the agent appends it to MEMORY.md via upstream `edit`. The two are not redundant.

How they compose at turn time:
- System prompt block (stable): SOUL + USER + MEMORY + tools index.
- Volatile block (per turn): LCM-assembled context for today + diary RAG top-K for past days + new user message.
- Cache breakpoint sits between the stable and volatile blocks. pi-ai handles the actual cache control via `cacheRetention` and `sessionId`: `packages/ai/src/types.ts:64-95`.

## E. Stages

### Stage 0: Upstream integration decision

Uses:
- `@mariozechner/pi-agent-core` package and exports: `packages/agent/package.json:2-17`, `packages/agent/src/index.ts:1-8`.
- `@mariozechner/pi-ai` package and exports: `packages/ai/package.json:2-8`, `packages/ai/src/index.ts:4-28`.
- `@mariozechner/pi-coding-agent` SDK exports for tools/session/compaction: `packages/coding-agent/src/index.ts:164-213`.

Adds:
- Decide direct `Agent` vs `AgentSession`.
- Recommendation: start with direct `Agent` for v0 daemon simplicity, reuse `pi-coding-agent` tool factories, and only adopt `AgentSession` if upstream JSONL compaction/session branching is needed.

Done when:
- A spike constructs an `Agent`, registers one upstream bash tool, sends a prompt, and logs `cacheRead/cacheWrite`.

### Stage 1: Bootstrap daemon and Discord DM

Uses:
- `Agent.prompt`, images, timestamps: `packages/agent/src/agent.ts:312-323`, `packages/agent/src/agent.ts:355-372`.
- Agent events for streaming/reply capture: `packages/agent/src/types.ts:374-389`.
- pi-chat Discord adapter patterns: `/tmp/pi-chat/src/live/discord.ts:15-40`, `/tmp/pi-chat/src/live/discord.ts:62-100`, `/tmp/pi-chat/src/live/discord.ts:183-255`.

Adds:
- `package.json`, TS config, config loader, `.env.example`.
- `SOUL.md`, `USER.md`, `MEMORY.md` stubs.
- Discord DM adapter, one-channel runtime, basic reply.
- Stable `sessionId` and cache usage logging.

Done when:
- qearl can DM the bot and get a persona-aware reply after restart.

### Stage 2: Chat runtime, logs, and control commands

Uses:
- pi-chat runtime/log shape: `/tmp/pi-chat/src/runtime.ts:67-110`, `/tmp/pi-chat/src/runtime.ts:199-257`, `/tmp/pi-chat/src/log.ts:57-90`, `/tmp/pi-chat/src/log.ts:173-177`.
- Agent steering/follow-up queues: `packages/agent/src/agent.ts:251-280`.

Adds:
- Familiar `ConversationRuntime`.
- Append-only chat JSONL or SQLite-backed event log.
- Checkpoints, replay catch-up, arm-after-tail behavior.
- `stop`, `status`, `new`, and `compact` command routing.
- Author-tagged ISO timestamp formatting.

Done when:
- Reconnect replay does not re-trigger old messages, logs survive restart, and `stop/status/new` work from Discord.

### Stage 3: Side-door and WebUI v0

Uses:
- pi-chat `LiveConnection` interface concept: `/tmp/pi-chat/src/live/types.ts:4-31`.
- Agent lifecycle events for stream/status: `packages/agent/src/types.ts:374-389`.

Adds:
- HTTP and WebSocket side-door.
- Auth modes: `tailscale-only`, `bearer`, `public-2fa`.
- Static `web/` UI with channel picker, message form, log/status view, and live stream.
- Web appears as its own channel.

Done when:
- Phone browser over Tailscale can talk to familiar without Discord.

### Stage 4: Tools

Uses:
- Upstream tool runtime and hooks: `packages/agent/src/types.ts:331-355`, `packages/agent/src/agent-loop.ts:529-661`.
- Upstream coding tool factories: `packages/coding-agent/src/core/tools/index.ts:117-195`.
- Upstream bash implementation: `packages/coding-agent/src/core/tools/bash.ts:273-407`.

Adds:
- Register YOLO VPS bash by configuring upstream `createBashTool`.
- Wire upstream `read`, `write`, `edit` with the workspace as the operational root. These plus `bash` cover memory, diary, summary, and chat-history browsing without bespoke wrappers. Skip upstream `grep`/`find`/`ls` factories: the agent shells out via `bash` instead, keeping the tool surface minimal.
- Tool allowlist policy for chat turns.

Done when:
- Agent can use bash, read and edit `MEMORY.md`/`SOUL.md`/`USER.md`, and `bash`-grep over `data/` for past chat or summary content.

### Stage 5: Subagent delegation tool

Uses:
- Independent upstream `Agent` instances, lifecycle events, scoped tools, abort, and idle waiting: `packages/agent/src/agent.ts:152-207`, `packages/agent/src/agent.ts:219-323`.
- Upstream tool shape for exposing `task` to the parent agent: `packages/agent/src/types.ts:315-355`.
- Coding-agent tool allowlists and custom tools as reference shapes, not a subagent SDK: `packages/coding-agent/src/core/sdk.ts:33-90`, `packages/coding-agent/src/core/tools/index.ts:81-195`.

Adds:
- Familiar `task` tool with `goal`, explicit context, allowed tools, timeout, max steps, and return shape.
- Subagent factory using the same `Agent` class with focused system prompt, scoped tools, and isolated transcript.
- Subagent transcript logging under the current channel event log.
- Depth, timeout, max tool call, max output, memory/RAG allow, and cancellation guards.

Done when:
- Main familiar can delegate a bounded task, stream what the subagent did, receive a structured result, and continue the parent turn.

### Stage 6: LCM (in-session lossless context engine)

Uses:
- `Agent.transformContext` insertion point for per-turn assembly: `packages/agent/src/agent-loop.ts:252-267`.
- Provider usage/cost accounting for compaction triggers: `packages/ai/src/types.ts:196-209`, `packages/ai/src/models.ts:39-45`.
- Upstream `read` so the agent can browse summaries without a wrapper, plus `bash` for shell-level grep over chat logs: `packages/coding-agent/src/core/tools/index.ts:117-195`, `packages/coding-agent/src/core/tools/bash.ts:75-161`.
- Lossless-claw design (DAG-based summarization) as reference, ported to pi-mono shapes: https://github.com/Martian-Engineering/lossless-claw

Adds:
- Storage: per-channel JSONL chat logs at `data/chat/{channel}/{date}.jsonl` (pi-chat pattern), plus markdown summary files under `data/lcm/{date}/leaf-NNN.md` and `condensed-NNN.md`. Each summary file has frontmatter linking to source records.
- SQLite embedding index for raw and summary records, used only by the assembler. Not exposed to the agent.
- Compaction worker: leaf pass on chunks of size `leafChunkTokens`, condensation passes up to `incrementalMaxDepth`. Deferred mode by default so compaction does not block the active turn.
- Per-turn assembler in `Agent.transformContext`: pick fresh tail plus the minimal covering summary set to fit window, threshold ~75%.
- File watcher: if qearl edits a summary file by hand, re-embed and continue.
- No new agent tools. Agent uses upstream `bash` (for `grep`) and `read` over the chat logs and summary files.

Done when:
- Long single-day conversations no longer overflow context. Agent can `bash` `grep` `data/chat/` for a phrase from earlier today and find it raw. Agent can `read` a summary file and follow its frontmatter to source records.

Replaces:
- Stage 7 in earlier drafts ("upstream compaction integration"). Familiar does not use upstream `AgentSession` auto-compaction.

### Stage 7: Daily diary and cross-session RAG

Uses:
- Stage 5 subagent layer to dispatch a diary-writer subagent at end-of-day or on explicit signal.
- Stage 6 LCM JSONL chat logs as the source material the subagent reads via upstream `read` and shell `grep` through `bash`.
- `Agent.transformContext` to inject top-K diary embeddings alongside LCM context: `packages/agent/src/agent-loop.ts:252-267`.
- Upstream `write`/`edit`/`read` for diary file operations: `packages/coding-agent/src/core/tools/index.ts:117-195`.

Adds:
- Diary store: per-day markdown files under `data/diaries/YYYY-MM-DD.md`. Plain text, editable, greppable.
- Diary-writer subagent persona: reflective tone, prompt covers what happened, what mattered, what is open, what is new about qearl, what should I remember. Not a transcript.
- Triggers: end-of-day cron in `[user] timezone`. Main agent can also dispatch the diary subagent on signals like "good night" by calling `task`. If a diary already exists for the day, the subagent reads it via `read` and `edit`s, or rewrites with `write`.
- Embedding worker: chunk diaries (paragraph-sized), embed via Gemini, store vectors plus source-date and offset. Also extract atomic facts (1-line claims with date pointers), embed separately. Both internal to the assembler.
- Recall: hybrid FTS5 + vector search with recency decay inside `transformContext`. Top-K injected with source-date hints.
- File watcher: re-embed on diary edits so qearl can correct entries directly.
- Migration convention: when relevant diary content is auto-injected, the agent can decide a fact is durable enough to be load-bearing and append it to MEMORY.md via upstream `edit`. Diary stays the episodic record either way.
- No new agent tools. Diary writes go through upstream `write`/`edit`. Diary reads/searches go through `read` and `bash` `grep`. Recall happens automatically via `transformContext`.

Done when:
- A new day's first message can pull relevant diary excerpts from previous days into context. Editing yesterday's diary in a text editor updates retrieval. The end-of-day cron writes a sensible reflective markdown file without manual intervention. Agent can `read` any past diary by date.

### Stage 8: Media intake

Uses:
- Agent image attachment format through `prompt(input, images)`: `packages/agent/src/agent.ts:312-323`, `packages/agent/src/agent.ts:367-371`.
- pi-chat attachment materialization patterns: `/tmp/pi-chat/src/live/common.ts:10-30`, `/tmp/pi-chat/src/log.ts:144-171`.

Adds:
- Gemini voice transcription.
- Gemini video description.
- Attachment metadata and generated transcripts/descriptions in chat records.

Done when:
- Voice memo and short video messages produce sensible replies.

### Stage 9: TTS and image generation

Uses:
- Upstream tool result shape with text/images/details: `packages/agent/src/types.ts:315-326`.
- pi-chat outbound attachment queue pattern: `/tmp/pi-chat/index.ts:991-1034`, `/tmp/pi-chat/index.ts:1435-1463`.

Adds:
- `tts` tool.
- `image_gen` tool.
- Attachment queue integration for Discord and web replies.

Done when:
- "say this out loud" returns an audio attachment and "draw X" returns an image attachment.

### Stage 10: Mac sidecar

Uses:
- None from pi-mono. This is intentionally separate.

Adds:
- New repo `familiar-mac`.
- HTTP server bound to Tailscale, bearer auth.
- Endpoints: `/cdp/navigate`, `/cdp/eval`, `/cdp/read_visible`, `/cdp/screenshot`, `/screen`, `/exec`.
- Playwright connects to real Chrome via `--remote-debugging-port=9222`.
- `screencapture` support.
- launchd plist for start-at-login.
- Chrome wrapper script that always launches with remote debugging enabled.

Done when:
- VPS can reach sidecar over Tailscale and CDP attaches to the logged-in Chrome profile.

### Stage 11: `mac.*` tool client

Uses:
- Upstream generic tool shape and execution hooks: `packages/agent/src/types.ts:331-355`, `packages/agent/src/agent-loop.ts:529-661`.

Adds:
- `mac.navigate`, `mac.eval`, `mac.read_visible`, `mac.screenshot`, `mac.screen`, `mac.exec`.
- Sidecar health/status checks.
- Conservative response truncation and attachment handling.

Done when:
- Familiar can inspect and operate the Mac's real Chrome from Discord.

### Stage 12: Install, service, and docs

Uses:
- Upstream package manifests and Node engine requirements: `packages/agent/package.json:37-39`, `packages/coding-agent/package.json:97-99`.

Adds:
- `familiar init <workspace>`.
- `familiar run <workspace>`.
- `familiar install-service <workspace>`.
- systemd unit.
- nginx public-2fa example.
- deploy README.

Done when:
- A fresh Debian VPS can run familiar in under 10 minutes after secrets are provided.

## F. Locked decisions

- Discord-first: pi-chat proves Discord gateway intake, catch-up, attachments, reply-to, and chunked sending are already straightforward patterns to lift: `/tmp/pi-chat/src/live/discord.ts:15-40`, `/tmp/pi-chat/src/live/discord.ts:62-100`, `/tmp/pi-chat/src/live/discord.ts:119-156`.
- Two processes: keep `familiar` on VPS and `familiar-mac` on Mac. pi-mono gives VPS agent/tool primitives, but real Chrome state lives on Mac.
- Single global `MEMORY.md`: upstream has no `MEMORY.md` convention, and pi-chat's two-memory-file model is app-specific: `/tmp/pi-chat/src/config.ts:80-81`. Familiar keeps one global `MEMORY.md` for tier-1 stable load-bearing facts only. Episodic recall lives in tier-2 LCM (today) and tier-3 diary RAG (past days).
- Three-tier memory from v0: tier 1 stable system prompt files, tier 2 LCM in-session DAG, tier 3 cross-session diary RAG. See section D5. Upstream provides none of these, and `transformContext` exists exactly where the in-session and cross-session blocks are assembled: `packages/agent/src/agent-loop.ts:252-267`.
- Diary as the agent's autobiographical record: end-of-day reflective markdown files, written by a focused diary subagent. RAG over diaries, not over raw messages. Raw-message search lives in LCM, not in cross-session RAG.
- Tool surface stays minimal: the only new agent tools familiar adds are `task` (Stage 5) and `mac.*` (Stage 11). Memory, diary, summary, and chat-history operations all go through upstream `read`/`write`/`edit` plus `bash` (which covers `grep`/`ls`/`find` use cases via shell). Familiar deliberately skips upstream `grep`/`find`/`ls` factories to keep the tool surface to four core tools (`bash`, `read`, `write`, `edit`). Embedding-based recall is automatic via `transformContext`, not a tool. This keeps the upstream tool surface load-bearing and avoids wrappers that bitrot when pi-mono evolves.
- One Gemini key: `pi-ai` has Google provider exports, but no embedding API: `packages/ai/src/index.ts:11-13`, `packages/ai/src/index.ts:27-28`. Familiar owns Gemini embedding, STT, and video calls outside upstream chat completion.
- WebUI v0: pi-web-ui exists, but side-door v0 can be static HTML. The required primitive is the live adapter/event stream, not a component library: `packages/web-ui/package.json:2-11`, `/tmp/pi-chat/src/live/types.ts:4-31`.
- Side-door auth modes: upstream has no familiar side-door. pi-chat's live adapter abstraction makes another channel easy: `/tmp/pi-chat/src/live/types.ts:4-31`.
- YOLO bash on VPS: upstream bash already runs local commands with timeout, abort, streaming, and truncation; familiar only chooses to wire it unsandboxed: `packages/coding-agent/src/core/tools/bash.ts:75-161`, `packages/coding-agent/src/core/tools/bash.ts:273-407`.
- Reactive only in v0: upstream `Agent` is prompt/steer/follow-up driven, not proactive. Future `/event` can enqueue user messages later: `packages/agent/src/agent.ts:251-323`.
- Thinking/COT reactive only: upstream thinking level is state, and assistant messages carry usage/reasoning data through normal events. Familiar should store it but reveal only on request: `packages/agent/src/types.ts:250-255`, `packages/agent/src/types.ts:374-389`.
- Web as own channel: pi-chat's `conversationId`, `channelKey`, and per-channel runtime model show this is natural: `/tmp/pi-chat/src/config.ts:64-85`, `/tmp/pi-chat/src/runtime.ts:322-331`.
- Author-tagged ISO timestamps: pi-chat stamps records with `new Date().toISOString()` and includes `[uid:ID]` in transcript lines: `/tmp/pi-chat/src/log.ts:173-177`, `/tmp/pi-chat/src/runtime.ts:42-55`.
- Subagent delegation in v0: main familiar can spawn task-focused subagents. Upstream provides independent `Agent` instances and event/tool primitives, but no Task tool or subordinate-agent SDK, so familiar owns the thin delegation layer: `packages/agent/src/agent.ts:152-207`, `packages/agent/src/agent.ts:219-323`, `packages/coding-agent/src/core/tools/index.ts:81-195`.
- Single-owner, no multi-user, ever: familiar is for qearl's install. Extensibility is tools, channels, providers, triggers, memory adapters, and subagent personas, not account isolation or permissions.
- No fork: upstream packages are designed as reusable packages and SDK exports. Build familiar on top: `packages/agent/src/index.ts:1-8`, `packages/coding-agent/src/index.ts:164-190`.

## G. Reference section

pi-mono:

- `/Users/qearl/pi-mono/package.json:2-29`
- `/Users/qearl/pi-mono/README.md:46-58`
- `/Users/qearl/pi-mono/packages/ai/package.json:2-68`
- `/Users/qearl/pi-mono/packages/ai/src/index.ts:4-28`
- `/Users/qearl/pi-mono/packages/ai/src/types.ts:64-95`
- `/Users/qearl/pi-mono/packages/ai/src/types.ts:196-209`
- `/Users/qearl/pi-mono/packages/ai/src/models.ts:39-45`
- `/Users/qearl/pi-mono/packages/ai/src/providers/openai-responses.ts:26-38`
- `/Users/qearl/pi-mono/packages/ai/src/providers/openai-responses.ts:221-229`
- `/Users/qearl/pi-mono/packages/ai/src/providers/anthropic.ts:40-67`
- `/Users/qearl/pi-mono/packages/ai/src/providers/anthropic.ts:868-905`
- `/Users/qearl/pi-mono/packages/agent/package.json:2-17`
- `/Users/qearl/pi-mono/packages/agent/src/index.ts:1-8`
- `/Users/qearl/pi-mono/packages/agent/src/agent.ts:93-111`
- `/Users/qearl/pi-mono/packages/agent/src/agent.ts:152-207`
- `/Users/qearl/pi-mono/packages/agent/src/agent.ts:251-323`
- `/Users/qearl/pi-mono/packages/agent/src/agent-loop.ts:95-245`
- `/Users/qearl/pi-mono/packages/agent/src/agent-loop.ts:252-273`
- `/Users/qearl/pi-mono/packages/agent/src/agent-loop.ts:350-689`
- `/Users/qearl/pi-mono/packages/agent/src/types.ts:257-389`
- `/Users/qearl/pi-mono/packages/coding-agent/package.json:2-38`
- `/Users/qearl/pi-mono/packages/coding-agent/src/cli.ts:1-22`
- `/Users/qearl/pi-mono/packages/coding-agent/src/index.ts:5-49`
- `/Users/qearl/pi-mono/packages/coding-agent/src/index.ts:132-213`
- `/Users/qearl/pi-mono/packages/coding-agent/src/index.ts:232-281`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/sdk.ts:33-90`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/sdk.ts:158-205`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/sdk.ts:279-405`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:60-77`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:175-320`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:376-400`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/event-bus.ts:12-24`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/index.ts:81-195`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/bash.ts:45-161`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/tools/bash.ts:273-407`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts:1-13`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts:119-139`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts:528-584`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts:1603-1719`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/agent-session.ts:1764-2002`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/session-manager.ts:30-147`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/session-manager.ts:310-435`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/resource-loader.ts:58-114`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/resource-loader.ts:461-475`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/system-prompt.ts:8-171`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/extensions/types.ts:423-465`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/extensions/types.ts:604-634`
- `/Users/qearl/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1089-1135`
- `/Users/qearl/pi-mono/packages/coding-agent/README.md:260-308`
- `/Users/qearl/pi-mono/biome.json:1-40`
- `/Users/qearl/pi-mono/.pi/extensions/tps.ts:25-45`

pi-chat:

- `/tmp/pi-chat/package.json:17-35`
- `/tmp/pi-chat/AGENTS.md:5-18`
- `/tmp/pi-chat/AGENTS.md:70-120`
- `/tmp/pi-chat/README.md:29-42`
- `/tmp/pi-chat/README.md:85-149`
- `/tmp/pi-chat/index.ts:39-82`
- `/tmp/pi-chat/index.ts:353-384`
- `/tmp/pi-chat/index.ts:654-793`
- `/tmp/pi-chat/index.ts:901-1073`
- `/tmp/pi-chat/index.ts:1075-1133`
- `/tmp/pi-chat/index.ts:1180-1192`
- `/tmp/pi-chat/index.ts:1300-1394`
- `/tmp/pi-chat/index.ts:1396-1467`
- `/tmp/pi-chat/src/config.ts:53-85`
- `/tmp/pi-chat/src/core/config-types.ts:1-83`
- `/tmp/pi-chat/src/core/runtime-types.ts:3-128`
- `/tmp/pi-chat/src/log.ts:57-90`
- `/tmp/pi-chat/src/log.ts:110-177`
- `/tmp/pi-chat/src/runtime.ts:67-110`
- `/tmp/pi-chat/src/runtime.ts:144-172`
- `/tmp/pi-chat/src/runtime.ts:199-333`
- `/tmp/pi-chat/src/live/types.ts:4-31`
- `/tmp/pi-chat/src/live/common.ts:10-90`
- `/tmp/pi-chat/src/live/discord.ts:15-40`
- `/tmp/pi-chat/src/live/discord.ts:62-100`
- `/tmp/pi-chat/src/live/discord.ts:119-255`
- `/tmp/pi-chat/src/render/chunking.ts:3-60`
- `/tmp/pi-chat/src/render/format.ts:20-31`
- `/tmp/pi-chat/src/render/streaming.ts:23-85`
- `/tmp/pi-chat/src/gondolin.ts:61-87`
- `/tmp/pi-chat/src/gondolin.ts:183-337`

## J. Maintenance posture

- Upstream version policy: pin pi-mono packages to caret ranges like `^x.y.z`, matching upstream dependency style: `packages/coding-agent/package.json:40-44`. When a pi-mono release lands, run a manual upgrade pass: install, typecheck, test, hit a known-good prompt, and verify cache hit/cost telemetry from `cacheRead`, `cacheWrite`, `input`, and `output`: `packages/ai/src/types.ts:196-209`.
- Versioning: familiar uses semver. Pre-1.0 personal project rules: bump minor for new features, patch for fixes, and tag releases in git.
- Testing posture: write tests for the channel runtime state machine, including catch-up, arm, slice, complete; the recall scoring/decay function; and subagent depth, timeout, and result-shape guards. Skip thin wrappers over pi-mono. Upstream uses Vitest: `packages/coding-agent/package.json:37-38`, `package.json:18-22`.
- Lint/format: use Biome and match upstream tab and line width settings: `biome.json:1-40`.
- CI placement: reserve `.github/workflows/ci.yml`. Do not write it yet. It should run lint, typecheck, and tests on push.
- Telemetry: log token usage and cost from pi-ai's `cacheRead`, `cacheWrite`, `input`, `output`, and `cost` fields per turn, then aggregate daily into a `costs` SQLite table. No external telemetry sink: `packages/ai/src/types.ts:196-209`, `packages/ai/src/models.ts:39-45`.
- Code review: solo work, but commits should be atomic and messages should explain why.
