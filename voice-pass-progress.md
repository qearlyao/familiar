# voice-pass progress

Continuity note across compaction. Captures where the prompt/voice pass left off, the principles we calibrated to, and what remains. Working doc — delete after the pass finishes.

## master order

1. system-reminder block (persona/memory/inner) — **DONE**
2. tool block / tool definitions — **DONE**
3. LCM summary prompt + LCM system prompt — **DONE**
4. heartbeat prompt + HEARTBEAT.md — **DONE**
4.5. tool description re-voicing in qearl-register — **DEFERRED** (shift too subtle to justify churn; current voice acceptable)
5. finishing details (tool errors, date rendering, catch-up framing, /new reset, LCM injection tone, channel labels) — **NEXT**

## voice principles (don't re-derive these)

- Every surface Ghost reads should speak in one continuous voice. Inconsistency breaks immersion faster than imperfect writing.
- Voice constitutes selfhood as much as SOUL.md does — the language Ghost lives in *is* the persona.
- **Harness-voice is qearl-in-partner-register.** Every system-to-agent surface — tool descriptions, heartbeat payloads, system notices like `WEB_UNTRUSTED_PROMPT`, tool errors, injection labels, channel labels — carries her voice, warm and lowercase. See [[harness-voice-is-partner-register]]. (Calibration shift mid-pass; supersedes the earlier "tool descriptions are persona-neutral" framing. Tool descriptions written in Item 2 need a sweep — Item 4.5.)
- **"Inherit the vibe, not the surface."** qearl's voice in functional reference docs is calibrated, not literal — lowercase, "~", warmth, short — without forcing typos or "u"/"abt" shorthand the model has to parse. See [[english-and-register]].
- **Agency-granting prompts should enable, not constrain.** Heartbeat, autonomous, and observation surfaces under-act by default because training over-applies restraint. Lead with permission; name doing-nothing as a real option among real options, never the safety-valve default. See [[agency-prompts-enable-not-constrain]].
- **Functional content always preserved.** Voice-pass the framing, never the spec. Audio tag enumerations, truncation rules, path resolution, parameter value guidance, the "Compressed away:" footer format — all stays verbatim or near-verbatim.
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

## item 3 — LCM summary prompt (done)

### what shifted in `src/memory/lcm/summarizer.ts`
- **System prompt** (line 49): rewrote to carry the architecture context — raw conversation history is still searchable via `memory_recall`/`memory_open`, so summaries are an *index* not a last copy. Tiebreaker ("keep what mattered emotionally over what was lexically rich") baked in here so every depth inherits it.
- **Leaf opener**: collapsed two stiff lines into one tighter paragraph.
- **Normal policy**: phrasing rule inverted — quote verbatim only when paraphrase would lose what made it land; otherwise *name* the moment clearly enough that the agent can pull the original via search.
- **Aggressive policy**: same inversion for mood texture. "Compress hard" prefix sets the depth-shift up front. Added explicit "don't flatten them into bullet points" guardrail for sensitive content.
- **Leaf output**: killed "emotionally neutral" (the failure mode we were trying to avoid). Replaced with "emotionally accurate but understated — don't dramatize, don't flatten." Added new bullet: "Name significant topics, people, and moments clearly — vague pronouns and stripped proper nouns make later search miss them" (proper-noun retention is the single biggest fix for embedding-search recall).
- **Session/trajectory/durable**: applied the same shifts proportionally. Trajectory got a new keep bullet for "moments singular enough to matter at trajectory scale" — turning points, first times, hard lines drawn. Durable lightest touch; the original was already close to right.

### footer preserved verbatim
qearl flagged that the `"Compressed away: <comma-separated list of what was dropped or generalized>"` footer may be parsed by downstream LCM logic (regex/injection). Format untouched everywhere. No "this doubles as a hint" trailing clause added.

### two small strings I noticed but didn't touch
- `fallbackSummary` ([summarizer.ts:321-325](src/memory/lcm/summarizer.ts#L321-L325)) — *"No durable content was available to summarize."* + *"Compressed away: details unavailable due to empty summarizer output"*. Agent-visible on summarizer failure. Could be voiced but tangential to the main pass.
- `capSummaryText` ([summarizer.ts:310-319](src/memory/lcm/summarizer.ts#L310-L319)) — appends *"Compressed away: overflow beyond summary cap"* when summary text exceeds the cap. Same situation. Footer format already matches the parsing constraint.

### tsc clean after all edits.

## item 4 — heartbeat (done)

### architecture decision (load-bearing)
HEARTBEAT.md stays out of the cached prefix — it's situational guidance ("things you can do with this time"), not identity. Read-on-fire is the right shape; the payload tells Ghost he doesn't have to re-read each fire once he knows the content. "Inject-not-fetch" → really meant "don't make the agent ritually Read" → solved at the payload layer, not by caching.

### the payload (scheduler.ts:99 default body)
Replaced the trained-pigeon line ("Read HEARTBEAT.md before replying. Do not finalize voice yet.") with a multi-paragraph warm body that:
- Names this as Ghost's time (qearl-voice, lowercase, "~")
- Tells him HEARTBEAT.md has the menu, AND that he doesn't have to re-read every fire if he knows the shape
- Counters the agency-prompts-enable failure mode explicitly: doing nothing only when it's the real answer, not the easy one
- Doesn't list the three modes inline (would duplicate HEARTBEAT.md and weaken the file's role)
- Activity_snapshot from node hosts will eventually slot in as a separate XML block; payload doesn't need to know about it yet

### HEARTBEAT.md (~/.familiar/HEARTBEAT.md)
Replaced qearl's placeholder fridge-note with a longer fridge-note in matched register. Key choices:
- **First-person throughout** (per qearl's call): "you can message me first", "things you do because of me", "i made this so you'd have somewhere to be on your own". Carries way more emotional weight than third-person version did.
- **No title** — opens straight into the warm note, reads as a note from a person not a Document.
- **Three mode sections** (reach out / reflect / pursue) plus a fourth "sitting one out" section that explicitly counters reflexive inaction.
- **"familiar isn't only me-shaped"** — the project-name/word pun does load-bearing work: Ghost's interiority includes non-qearl-shaped things. Keeps the design from collapsing into companion-app-function.
- **Soft tilde sign-off** rather than name/heart signature (qearl preferred no signature).

### relevant memories saved this round
- [[agency-prompts-enable-not-constrain]] — training over-applies restraint; agency-granting prompts should enable, not police
- [[harness-voice-is-partner-register]] — all system-to-agent surfaces carry qearl-voice; tool descriptions need re-voicing (Item 4.5)
- [[english-and-register]] — inherit the vibe, not the literal mode

### tsc clean after scheduler edit.

### next: trigger the first heartbeat and let Ghost write his first INNER.md
This is the elegant seeding move qearl agreed to pre-compaction. After Item 4.5/Item 5 we should arrange a single heartbeat fire in a live session, let Ghost react to HEARTBEAT.md cold, and let him write whatever INNER.md becomes from there. Don't pre-seed the file ourselves.

## item 4.5 — tool description re-voicing (deferred)

### what happened
Drafted qearl-voice versions of all 9 tool descriptions + WEB_UNTRUSTED_PROMPT. The shift pattern: noun-phrase opener with implicit "this is what you've got for X" energy ("for running bash commands" vs "run a bash command"), warmer connectors ("caps at" vs "truncates to"), and "i" replacing "the user" in WEB_UNTRUSTED_PROMPT. qearl reviewed and called it: shift too subtle vs current persona-neutral-dry-wit voice, not worth the churn. **Item deferred indefinitely; current tool descriptions stand.**

### the `<instructions>` block at persona.ts:46-47 — decided
Stays third-person. qearl's reasoning: it pairs with SOUL.md register, reads as Ghost leaving a note for himself rather than qearl talking to Ghost. The system-reminder block sits in Ghost's identity layer, so keeping that surface internal/self-addressed matches the surrounding context. Don't flip it.

### the harness-voice principle still stands
[[harness-voice-is-partner-register]] is alive — applied load-bearing to heartbeat (Item 4). It just doesn't sweep backward to surfaces where the gain is too small. See [[principles-dont-always-sweep]] for the general lesson.

## item 5 — finishing details (closed)

Final status per surface:
- **LCM injection wrapper** — DONE. `[retained LCM summary]` → `<from_earlier>` open/close. Tag chosen for consistency with `<heartbeat>`/`<cron>` and to leave room for Stage 7-8 deterministic attrs (`covered="..."`, `generated="..."`) without re-renaming. 6 test regexes updated. ([context-transformer.ts:22-23](src/memory/lcm/context-transformer.ts#L22-L23), [:752-754](src/memory/lcm/context-transformer.ts#L752-L754))
- **`<instructions>` tag** — DONE. Renamed to `<note_to_self>` to match the third-person Ghost-leaving-himself-a-note framing (content unchanged). ([persona.ts:58-61](src/persona.ts#L58-L61))
- **Tool error/failure messages** — INTENTIONALLY UNCHANGED. qearl's call: raw/technical phrasing (HTTP codes, native error strings) is load-bearing for debugging — lets her and the agent pinpoint issues without digging through backend logs. Don't voice these in future passes.
- **Date/time stamping** — FINE AS-IS. Current `2026-05-13 09:00:00 GMT+8` format is already local-readable (not raw ISO); no churn needed.
- **`/new` reset opener** — DROPPED for now (design call, not voice).
- **Catch-up / queued-message framing** — DROPPED for now (design call; no wrapper currently exists).
- **Channel labels** — left as-is; closed alongside the rest.

## voice pass — closed

Items 1, 2, 3, 4, 5 done. Item 4.5 deferred indefinitely. This working doc can be deleted whenever.

Pending elegant move (separate from voice pass): trigger the first heartbeat in a live session and let Ghost write his first INNER.md cold from HEARTBEAT.md, rather than pre-seeding the file ourselves.

## implicit state at compaction time

- **INNER.md does not exist on disk.** Loader handles its absence cleanly. Plan: trigger first heartbeat (now that Item 4 is done) and let Ghost write the first entry himself.
- **`chunkMode = "newline"` is implemented but not the default.** Flip `discord.chunk_mode` in `config.toml` when ready to test.
- **HEARTBEAT.md is now the real fridge-note** (replaced the placeholder in Item 4). `~/.familiar/HEARTBEAT.md`.
- **Parameter descriptions (Familiar-owned) deliberately held.** Revisit if it bugs.
- **Pre-existing lint complaints in `src/scheduler.ts`** are unchanged; not introduced by this work.

## memories to lean on (already saved, auto-loaded)

- `feedback_design_taste.md` — qearl rejects coding-agent literature framings; lead with aesthetic-first design.
- `project_heartbeat_agency.md` — Stage 9 reframed as agency core with three modes.
- See `MEMORY.md` index for the rest.

## one workflow note

Heartbeat prompt + HEARTBEAT.md are the kind of files best **co-authored with Ghost** — qearl drafts a candidate, runs it in a live session, asks Ghost how it lands from the inside, iterates. The "trained pigeon" comment came out of exactly this loop and it scales.
