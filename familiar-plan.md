# familiar — Personal Discord Agent (forked from pi-mom)

A 24/7 personal companion agent for Discord, forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono)'s `pi-mom` package. Self-hostable, single CLI binary, designed for Debian VPS deployment.

The name reflects the design: a familiar is a persistent companion bound to one person — exactly what we're building.

---

## Background — what we're building on

`pi-mono` is a TypeScript monorepo by Mario Zechner (@badlogic). Layered:

- **Apps**: `pi-coding-agent` (interactive CLI), `pi-mom` (24/7 Slack bot)
- **Libraries**: `pi-agent-core` (agent loop), `pi-ai` (multi-provider LLM wrapper)

We fork **pi-mom** because it already has the autonomous-daemon shape: events/cron system, persistent per-channel memory, Docker sandbox, multi-channel context, designed for long-running deployment. The Slack-specific surface is small (~one file: `slack.ts`) — swappable for Discord.

**Key files in pi-mom worth reading first:**
- [`packages/mom/README.md`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/README.md) — architecture overview
- [`packages/mom/src/events.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/src/events.ts) — cron/heartbeat system (~300 lines, very readable)
- [`packages/mom/src/agent.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/src/agent.ts) — agent runner, tool loop, system prompt assembly (esp. lines 663–669: per-turn rebuild, key splice point for future memory work)
- [`packages/mom/src/context.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/src/context.ts) — log → context syncing
- [`packages/mom/src/slack.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/src/slack.ts) — what we replace with Discord
- [`packages/mom/src/sandbox.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/src/sandbox.ts) — Docker sandbox

**pi-mom's existing memory model** (relevant for Phase 2):
- Two flat Markdown files per workspace: global `MEMORY.md` + per-channel `<channelId>/MEMORY.md`
- Always-on injection at a single slot in the system prompt (`agent.ts:292-293`)
- No embeddings, no RAG, no auto-extraction, no daily log splits
- Compaction lives upstream in `pi-coding-agent`'s SessionManager (mom only listens for events)
- No formal extension hooks for memory — overriding requires editing `agent.ts`

---

## Goals

- **Companion / partner-style agent** with a defined persona — proactive greetings, sleep monitoring, autonomous behavior. YOLO mode (no approval gates).
- **Discord transport** — DM + group chats, talks to friends and other bots.
- **Self-hostable for friends** — clean installer, single command, sensible defaults.
- **Future: WebUI** for inspecting tools/status/skills/configs (Phase 3).
- **Future: Mac host service** for local access (Chrome via CDP, screen time, etc.) over Tailscale (Phase 3).
- **Future: voice (TTS/STT) + image-gen** (Phase 4+).

---

## Architecture principles (lessons from OpenClaw failures)

Non-negotiable design rules:

1. **Explicit author tagging in every message in context** — structured `<user id="..." name="...">...</user>` tags. Group-chat user confusion is a design bug, not a model limitation.
2. **Cache stability is a v1 acceptance criterion** — stable `cache_control` breakpoints at fixed boundaries (system + soul + skills + memory snapshot). Don't move them on every turn.
3. **Thinking blocks: explicit, contained, controllable** — captured in storage, never auto-streamed into chat. Surface only via side door / future WebUI on demand.
4. **Strict tool parameter validation** — TypeBox/Zod schemas, fail fast, no silent coercion.
5. **Snapshot tests for context assembly** — "given log X, the assembled prompt should be exactly Y." Lock the format. Catch regressions automatically.
6. **No background subagents on the critical path** — memory writes async fire-and-forget; memory reads pre-computed before LLM call, never blocking.

---

## File layout

```
<workspace>/
├── config.toml              ← runtime settings (intake, llm, cache, etc.)
├── .env                     ← secrets (DISCORD_TOKEN, ANTHROPIC_API_KEY, ...)
├── SOUL.md                  ← agent identity: persona, voice, values (stable, edited by you)
├── USER.md                  ← operator profile: who the agent serves (stable, edited by you)
├── MEMORY.md                ← agent-curated facts (volatile, edited by agent)
├── data/
│   ├── events/              ← cron/scheduled event JSON files
│   └── <channelId>/
│       ├── log.jsonl        ← append-only source of truth
│       ├── context.jsonl    ← LLM-visible window
│       └── MEMORY.md        ← per-channel agent-curated facts
└── souls/                   ← example SOUL.md files (companion / butler / default)
```

**Why split persona/user/memory:**
- `SOUL.md` = the *agent*. Stable. Edited by you. Travels with the fork — what makes it yours.
- `USER.md` = *you*. Stable. Edited by you. Defines who the agent talks to.
- `MEMORY.md` = what the *agent learned*. Volatile. Edited by the agent.

Mixing them = OpenClaw-style accidents (agent rewrites its own persona, user can't update preferences without confusing memory).

---

## System prompt slot order (for cache stability)

Stable prefix first, volatile last. Cache breakpoints go after stable blocks.

```
[hardcoded base instructions]    ← never changes, big cache hit
[SOUL.md]                        ← stable, edited rarely
[USER.md]                        ← stable, edited rarely
[skills index]                   ← stable per session
———— cache breakpoint ————
[channel info + author tags]     ← changes per channel
[MEMORY.md global]               ← changes when agent writes
[MEMORY.md channel]              ← changes when agent writes
[recent context]                 ← changes every turn
```

---

## Time awareness

Companion agent needs to know when things happen. Inject timestamps on the **volatile side** of the cache breakpoint (user messages + tool results), never in the system prompt — that way time passing doesn't invalidate the cached prefix.

**Author-tagged form on every message in `context.jsonl`:**

```
<user id="..." name="qearl" at="2026-05-01T01:43:00+08:00">
hey, you up?
</user>
```

Apply to:
- Incoming user messages (Discord intake)
- Agent's own past responses
- Tool results (`[2026-05-01T01:43:05+08:00] tool_result(bash) ...`)
- Synthetic event messages (use the *intended* fire time, so the agent sees delays after restarts):
  ```
  [2026-05-01T07:00:00+08:00] [EVENT:morning-greet:periodic:0 7 * * *]
  Time to greet qearl good morning.
  ```

**User timezone in `config.toml`** under `[user]` (machine-readable, not character — doesn't belong in `SOUL.md` or `USER.md`):

```toml
[user]
timezone = "Asia/Shanghai"
```

Without this, "good morning" fires on VPS time (likely UTC or Frankfurt or wherever) instead of the operator's local time.

**Why not in the system prompt:** would invalidate the cache breakpoint above the memory section every turn. User-message side is already volatile, so timestamps cost zero cache hits there.

---

## Message intake — three modes

Per-channel state machine. Decided per incoming message based on (channel type, agent state).

| Channel type | Agent state | Mode |
|---|---|---|
| DM | idle | **immediate** — turn fires immediately |
| DM | mid-turn | **steer** — inject into running turn |
| Group | idle | **collect** — debounce buffer, flush on silence |
| Group | mid-turn | **steer**, but only for messages addressed to agent |

### Immediate mode
Current pi-mom behavior. Message arrives → agent runs a turn.

### Collect mode (group, idle)
- Buffer incoming messages per channel
- Reset debounce timer on each new message (default 3s)
- On timer fire: flush buffer as one turn ("Alice said X, Bob said Y, then silence")
- @-mention shortens debounce (default 1s)
- Hard cap (`max_collect_window_ms`, default 30s) so a never-quiet channel still gets responses

### Steer mode (mid-turn injection)
The interesting one. While the agent is mid-task (multiple tool-call iterations), let the user course-correct without starting a new turn.

**Mechanics:**
- Inbox per channel
- Discord intake: if agent mid-turn in this channel, push message to inbox (don't trigger normal intake)
- Agent loop drains inbox between LLM iterations (NOT mid-tool-call) and prepends as a `user` role message
- Filter in groups: only mentions/replies-to-agent steer; random chatter doesn't pollute mid-task context
- Bounded inbox: drain N pending messages into a single `<user>` block, not N separate messages
- Acknowledge receipt (reaction emoji or `[heard, adjusting]`) so user knows it landed
- Cache miss on the steered turn is expected and acceptable

**Pseudocode shape:**
```ts
while (!done) {
    const pending = inbox.drainForChannel(channelId);
    if (pending.length > 0) messages.push(formatAsUserMessage(pending));
    const response = await llm.call(messages, tools);
    // ... tool execution ...
}
```

---

## Bot-to-bot interaction

Combines with steer/collect:
- Bot messages enter the collect buffer like any other
- Tighter cooldown for bot replies (default 30s — won't reply to same bot twice within window)
- Author tagging means agent knows which entries are bots and can choose silence
- Anti-loop is a *design* requirement, not optional — friends' bots will trigger spirals otherwise

---

## Side door

Not a WebUI — a single HTTP endpoint as a Discord-fallback control channel.

- `POST /msg { channel, text }` with bearer auth → same code path as Discord intake → returns reply
- `GET /channels/:id/log` for read-only inspection
- Use from `curl`, an iOS shortcut, a CLI, or the future WebUI
- ~50 lines, but fundamental: WebUI later is just a frontend on these endpoints, not a parallel system
- Critical when Discord connection is severed and you need to debug/repair the agent

---

## Caching

**Phase 0 / day 1 audit task.** Before building features on top, verify:
- pi-ai's Anthropic prompt caching works as expected
- The way pi-mom rebuilds the system prompt each turn doesn't thrash cache breakpoints
- Cache hit rate is measurable and stable across turns

If broken, fix here. Likely fix: hold breakpoints at the stable boundaries listed above and don't move them per-turn.

**Acceptance criterion:** measurable, stable cache hit rate logged per turn.

---

## Custom LLM endpoints

`pi-ai` already supports OpenAI-compatible base URLs. Anthropic + Gemini base URL overrides may need a one-line addition. Useful for LiteLLM / OpenRouter / custom proxies.

`config.toml` shape:
```toml
[llm]
provider = "anthropic"   # or "openai", "google"
model = "claude-opus-4-7"
base_url = ""            # override
api_key = "${ANTHROPIC_API_KEY}"
```

---

## Deployment

**Single CLI binary, one process.** Not Next.js, not a separate gateway.

```bash
familiar <workspace-dir>
```

The process does everything in-proc: Discord Gateway (outbound websocket, no inbound ports needed), agent loop, side-door HTTP server, event/cron watcher. Maps to one systemd unit. WebUI later adds routes to the existing HTTP server, no new process.

### Friend-facing install

Target experience on a fresh Debian VPS:

```bash
# 1. Prereqs (one-time)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs docker.io

# 2. Install
npm install -g @yourname/familiar

# 3. Init workspace (creates config.toml, SOUL.md, USER.md, .env stubs)
familiar init ~/agent-workspace

# 4. Edit
$EDITOR ~/agent-workspace/.env
$EDITOR ~/agent-workspace/SOUL.md
$EDITOR ~/agent-workspace/config.toml   # optional

# 5. Run foreground (test)
familiar run ~/agent-workspace

# 6. Install as service
familiar install-service ~/agent-workspace
sudo systemctl enable --now familiar
```

CLI commands: `init`, `run`, `install-service`. The `install-service` step writes the systemd unit, prompts for user, enables it. Reversible.

### Dev workflow (you, on Mac)

- Develop locally on Mac, test against Discord with a dev bot token (Discord Gateway is outbound — works from anywhere)
- Push to GitHub
- VPS: `git pull && npm install && systemctl restart familiar`
- **Never `scp node_modules/`** — fresh `npm install` on VPS (native bindings, ARM vs x86_64)
- `data/` lives on VPS only, gitignored — that's the persistent state that makes the agent yours

---

## V1 scope (final, locked)

1. **Fork pi-mom → familiar** (rename, set up monorepo position)
2. **Discord transport** — replace `slack.ts` with Discord (discord.js), DM + group, explicit author tagging
3. **Caching audit + stable breakpoints** — Phase 0 task, blocks everything else
4. **Persona files** — `SOUL.md` + `USER.md` + (existing) `MEMORY.md`, loaded into stable cached prefix
5. **Config** — `config.toml` for settings, `.env` for secrets, env var interpolation
6. **Side-door HTTP endpoint** — bearer-auth `POST /msg`, read-only `GET /channels/:id/log`
7. **Anti-loop bot rules** — cooldown, author-aware silence
8. **Thinking blocks** — captured in storage, never leaked into Discord messages
9. **Snapshot tests for context assembly** — lock format, prevent regression
10. **Group-chat collect mode** — debounce when idle, configurable
11. **Steer mode** — inject mid-turn between LLM iterations, ack receipt, bounded inbox
12. **Time awareness** — author-tagged timestamps (`at=`) on all context entries; user timezone in `config.toml`
13. **CLI** — `init`, `run`, `install-service` commands
14. **systemd unit template** + Docker sandbox setup
15. **Install docs** for friends

**Memory in v1 = pi-mom's existing MEMORY.md unchanged.** Decision deferred to Phase 2 with real usage data. Keep [`agent.ts:663-669`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/src/agent.ts#L663) tidy as the future splice point.

---

## Phase 2 — memory architecture (deferred until v1 has been used)

Decision: extend/replace pi-mom's memory, don't run parallel. The injection point is a single line; "parallel" = "two write paths = drift."

### Candidate ideas (from researched repos)

**lossless-claw pattern** (from [Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw)):
- DAG-based summarization with link-back to raw messages in SQLite
- Agent gets `recall_detail(node_id)` tool to drill from summary → originals
- Fixes "summary lost the one detail I needed" failure mode
- Compaction becomes *queryable*, not *lossy*
- **Sharp edge:** pi-mom's compaction is owned upstream by `pi-coding-agent`. Either fork upstream or set its threshold high and run our own below it.

**Ombre-Brain pattern** (from [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain)):
- Pre-turn auto-surface: async embedding+keyword search before LLM call, top-K injected into system prompt
- Decay-weighted (recency × weight) instead of pure semantic top-k
- Dual-channel retrieval (vector + keyword in parallel)
- Optional valence/arousal tagging for companion-style "remember how things felt"
- **Skip the Python MCP server runtime** — port concepts in TypeScript

### Proposed Phase 2 architecture

Same single injection point as v1, richer payload:

```
### Current Memory
{global MEMORY.md}                  ← unchanged from v1
{channel MEMORY.md}                 ← unchanged from v1

### Recalled Context
{top-K pre-turn-injected snippets}  ← NEW: embedding+keyword + decay (Ombre-Brain)

### Compaction Notes
{summary + node IDs}                ← NEW: lossless DAG (lossless-claw)
```

Plus tools: `recall_detail(node_id)`, optional `memory_search(query)`.

**Key rule:** never block the reply. Memory writes async fire-and-forget. Memory reads pre-computed before LLM call.

---

## Phase 3 — operator surfaces

- **WebUI** — read-only inspector first (live tail, status, MEMORY view), then write controls (toggle skills, edit config, manage events). Built as static assets served from existing HTTP server. ~1–2 weekends.
- **Mac host service** — tiny Node service on Mac, exposed via Tailscale (no public internet, no port forwarding, no auth code). Endpoints: `exec`, `applescript`, `screenshot`, `chrome-cdp-proxy`, `read-file`. Agent calls as `mac.exec(...)`. Constrain surface from day one.
- **Chrome via CDP** — folded into Mac host (uses your local login state).
- **Sleep monitoring** — Mac launch agent polls idle/frontmost/lock state, POSTs to side-door webhook, writes event file. ~100 lines Swift or Python+launchd.
- **Discord presence handlers** — subscribe to gateway presence events, react.
- **iOS screen time** — defer/punt. No clean external API. Mac + Discord presence usually enough.

---

## Phase 4+ — sensory & generative

- TTS (ElevenLabs / OpenAI), STT (Whisper / Deepgram)
- Image-gen (OpenAI / Gemini / Stability)
- Discord voice channel output → user's BT speaker via Discord client (agent doesn't touch BT directly; VPS has no audio hardware)
- Subagent tool — spawn restricted `pi-agent-core` instance with different prompt; wrap as one tool call
- GitHub CLI tool — `apt install gh` in sandbox image, mount auth token

---

## Open questions for new session

When picking this up in a fresh session, these are the things to confirm/decide:

1. **Repo position** — fork the whole `pi-mono` monorepo, or just extract `packages/mom` into a standalone repo? (Leaning: fork the monorepo; we'll likely want to modify `pi-coding-agent` upstream for compaction in Phase 2.)
2. **Repo name** — `familiar` (locked).
3. **NPM scope** — `@yourname/familiar`?
4. **Cache audit results** — first task on starting v1: instrument and measure pi-mom's actual cache behavior. May change priority of fixes.
5. **Compaction strategy for v1** — keep upstream's, or already start replacing? (Leaning: keep upstream's for v1, replace in Phase 2.)
