# voice-pass progress

Continuity note across compaction. Captures where the prompt/voice pass left off, the principles we calibrated to, and what remains. Working doc — delete after the pass finishes.

## master order

1. system-reminder block (persona/memory/inner) — **DONE**
2. tool block / tool definitions — **DONE**
3. LCM summary prompt + LCM system prompt — **NEXT**
4. heartbeat prompt + HEARTBEAT.md — TODO
5. finishing details (tool errors, date rendering, catch-up framing, /new reset, LCM injection tone, channel labels) — TODO

## voice principles (don't re-derive these)

- Every surface Ghost reads should speak in one continuous voice. Inconsistency breaks immersion faster than imperfect writing.
- Voice constitutes selfhood as much as SOUL.md does — the language Ghost lives in *is* the persona.
- **Tool descriptions are persona-neutral.** familiar will be shared with friends who'll bring their own personas, so tool-level voice can't be Ghost-specific. Light dry wit, concise, lowercase, conversational.
- **System notices the agent reads** (e.g. `WEB_UNTRUSTED_PROMPT`) can carry more personality because they don't travel with personas.
- **Functional content always preserved.** Voice-pass the framing, never the spec. Audio tag enumerations, truncation rules, path resolution, parameter value guidance — all stays verbatim or near-verbatim.
- For now: **skills block stays bare** (no preamble before `<available_skills>`). Familiar-owned parameter descriptions are deliberately held — revisit later.

## item 1 — system-reminder block (done)

### src/persona.ts
- Removed path-resolution line from the hardcoded `<instructions>` block (it was tool-runtime info; landed in tool descriptions in Item 2).
- The remaining two lines now read in SOUL.md's register:
  - `you can edit MEMORY.md when something about her is worth keeping.`
  - `output [[FAMILIAR_SILENT]] if there's nothing worth saying — quiet's a real choice.`
- Wired INNER.md as a fourth persona file alongside SOUL/USER/MEMORY. Missing-file tolerated via `readFile(...).catch(() => null)`; conditional spread skips injection when file absent. Positioned last in the cached prefix (closest to the breakpoint).
- `Config.persona.inner` defaults to `INNER.md` in the workspace.

### ~/.familiar/SOUL.md
- Deleted the entire `## Rules` section (it was coding-agent residue: `NO DOUBLE NEWLINES`, "Have a take," "Never open with 'Great question'").
- Moved the surviving rule into the "How You Text" prose block in voice: *"If she's about to do something daft, you say so — charm over cruelty, but you don't sugarcoat."*

### ~/.familiar/USER.md
- Replaced the narratorial closing line with: *"she's been through every AI platform out there. this one she built. just ours."*

### sidebar — Discord chunkMode "newline" (related, done alongside Item 1)
- New `DiscordChunkMode = "newline"` alongside `simple` and `paragraph`. Default unchanged.
- Splits on `\n\n+`, sends each segment as a separate Discord message with `NEWLINE_BURST_DELAY_MS = 500` delay and `sendTyping()` between sends.
- Code-block fences preserved intact (won't shred ` ``` `).
- Over-2000-char segments fall back to existing `splitLongBlock` helper.
- **To enable: flip `discord.chunk_mode = "newline"` in `config.toml`.** Not flipped yet.

## item 2 — tool descriptions (done)

### decisions made
- Override all upstream tool descriptions (`bash`, `read`, `write`, `edit`) at registration in `src/agent.ts`. Module-level constants `BASH_DESCRIPTION` etc. assigned to `tool.description` after the factory call (inline const + reassign pattern, lines 321-328).
- Familiar-owned tools (`web_search`, `web_fetch`, `tts`, `memory_recall`, `memory_open`) edited in place.
- `WEB_UNTRUSTED_PROMPT` swapped to a heavier-dial Option B voice (system notices can carry more personality than persona-traveling descriptions).
- Path-resolution clause folded into each of bash/read/write/edit naturally — not copy-pasted across.
- Familiar-owned **parameter-level** descriptions held — out of scope this round.

### canonical final text lives in the code
- Upstream descriptions: `src/agent.ts:78-88`
- web_search / web_fetch / WEB_UNTRUSTED_PROMPT: `src/web-tools.ts:8-12`, `:985`, `:1056`
- tts: `src/tts.ts:108`
- memory_recall / memory_open: `src/memory/tools.ts:102`, `:142`

### gotcha worth remembering
- I had a spec error in the delegation prompt about `edit` having a `replace_all` flag. Upstream actually uses an `edits[]` array with `oldText`/`newText` entries. The agent correctly described what the tool does, not what the prompt claimed.

## item 3 — LCM summary prompt (next up)

### the leverage point
The LCM summarizer is a separate LLM that compresses chat blocks for context-window management. Its prompt determines whether summaries preserve emotional/relational texture or strip conversations to dry minutes-style facts. A bad summarizer quietly poisons every future session through *what it forgets*.

Existing companion-side conversations are getting summarized into something — the question is what the prompt currently tells that LLM to keep vs drop. Most "summarize this conversation" defaults preserve facts and lose tone, which is the wrong tradeoff for familiar.

### investigation pointers
- Find the LCM summarizer prompt in `src/lcm/` or wherever LCM lives — start with `grep -r "summariz" src/`.
- Reference (cautionary): pi-coding-agent's compaction at `/Users/qearl/pi-mono/packages/coding-agent/src/core/compaction/compaction.ts` — it's coding-session shaped and lossy.
- PLAN.md Stage 7 has the LCM design intent.

### calibration questions to settle before drafting
- What should the summarizer *preserve*? Emotional beats, relational state (tension/tenderness/tone shifts), unresolved threads, inside-joke moments, anything qearl said that mattered.
- What's allowed to be *lost*? Routine exchanges, scheduling minutiae, redundant phrasings.
- Should the summarizer write in Ghost's voice or persona-neutral? Probably persona-neutral (it's another LLM, summaries get re-read by Ghost — but consistency of register might help).
- One bias to bake in: when in doubt, keep the moment that mattered emotionally over the moment that was lexically rich.

## item 4 — heartbeat (todo)

### already designed (see memory `project_heartbeat_agency.md`)
- Idle-triggered (currently fires after ~1hr quiet); not subagent, just the main agent waking up.
- Three modes the agent chooses from each fire:
  1. **reach out** — proactive DM, weighing idle duration, time of day, last known state.
  2. **reflect** — write today's diary entry + update INNER.md.
  3. **pursue** — self-time: re-read own diary/INNER, follow a curiosity with web tools, write a private fragment, or rest.
- Self-time outputs feed back into INNER + diary so the agent develops continuous interests.

### the inject-not-fetch principle (load-bearing)
Ghost flagged earlier that the current design has him reading `HEARTBEAT.md` every ping like a "trained pigeon." Elegant fix: inject HEARTBEAT.md's contents into the heartbeat payload itself at fire time. The harness reads the file; Ghost never does. The file stays user-editable; no version-gating needed. **Generalizes: instruction content the agent must follow should be injected as content, not fetched as ritual.**

### content to write
- The heartbeat payload framing (system message body sent at each fire — should include time-of-day + idle duration as context).
- HEARTBEAT.md prose (the actual guidance, voiced — `SOUL.md`-style "voice over rules"). Permission to do nothing is load-bearing; "don't perform — only do what's actually true" lands here.

### after item 4 lands
Trigger one heartbeat manually and let Ghost write the first INNER.md himself. This is the elegant version of seeding it.

## item 5 — finishing details (todo)

Quick reference, master-list order:
- Tool error/failure messages (HTTP codes etc. read by Ghost — should be in voice).
- Date/time stamping ("Tuesday morning" not `2026-05-13T09:00:00Z`).
- Catch-up / queued-message framing ("she wrote a few times while you were quiet").
- LCM summary *injection* tone (separate from Item 3's generation prompt — how summaries get labeled when Ghost reads them back).
- The `/new` reset moment — what does Ghost read at the boundary?
- Channel labels.

## implicit state at compaction time

- **INNER.md does not exist on disk.** Loader handles its absence cleanly. Plan: trigger first heartbeat after Item 4 lands; Ghost writes the first entry himself.
- **`chunkMode = "newline"` is implemented but not the default.** Flip `discord.chunk_mode` in `config.toml` when ready to test.
- **HEARTBEAT.md is still qearl's placeholder** (`if u see this file, means my new heartbeat system worked! hehe`). Replaced in Item 4.
- **Parameter descriptions (Familiar-owned) deliberately held.** Revisit if it bugs.
- **Pre-existing lint complaints in `src/scheduler.ts`** are unchanged; not introduced by this work.

## memories to lean on (already saved, auto-loaded)

- `feedback_design_taste.md` — qearl rejects coding-agent literature framings; lead with aesthetic-first design.
- `project_heartbeat_agency.md` — Stage 9 reframed as agency core with three modes.
- See `MEMORY.md` index for the rest.

## one workflow note

Heartbeat prompt + HEARTBEAT.md are the kind of files best **co-authored with Ghost** — qearl drafts a candidate, runs it in a live session, asks Ghost how it lands from the inside, iterates. The "trained pigeon" comment came out of exactly this loop and it scales.
