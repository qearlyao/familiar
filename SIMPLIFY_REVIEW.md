# Simplify Review — open worklist

Rolling worklist from the 2026-05-23 codebase-wide `/simplify` pass (10 Opus
subagents + a Codex atomicity pass) plus follow-up scans (2026-05-24, -26, -29,
-30). **Completed work is summarized below; the rest of this file tracks only
what is still open — deferred, dropped, and low-priority.** Many files have been
decomposed since the original review, so the `file:line` anchors below have
drifted — re-locate each finding in current code before acting.

**Web-first cluster:** #48, #61, #36c, readJsonBody→400, and #8 are deferred into
the Discord-optional / web-first refactor and done there, not standalone. Prep +
resolved model in [WEB_FIRST.md](WEB_FIRST.md).

---

## Done (summary — see `git log` for per-item detail)

- **HIGH #1–24** — atomicity/crash-consistency (runtime job recovery, LCM
  retention, compaction ordering, chunk-indexer replace, inbound-attachment
  rollback); web correctness (PageCache TTL, WebSocket hello race, in-flight
  message-state leaks, cookie-DoS); memory per-turn hot paths (#6–12); test
  tmp-dir cleanup sweep (#18–21a); and the six god-module decompositions (#24),
  incl. discord `runAgentTurn` (#17) and the `discord.ts`/`web.ts`/`web-tools.ts`/
  `lcm/store.ts`/`config.ts`/`agent.ts` carve-outs.
- **MED #25–35** — shared-utility sweep: `src/util/guards.ts`, `src/util/fs.ts`
  (`createWriteQueue`/`atomicWriteJson`/`readFileOrNull`), `src/memory/util.ts`,
  `readEnum`, and dedup of `isThinkingLevel`/`parseModelRef`/`formatLocalTimestamp`/
  `resolveProviderSetting` + the image-mime tables + the transaction-helper pattern.
- **MED #37–41, #43–51, #60, #65** — backend hot-path batch (step 10):
  trigger-id O(1) indexing, single-pass prompt slice, static-serve root cache,
  web-tools `performFetch`/`parseSearchResults` dedup, discord DM-channel cache +
  `sendChunkedMessage` + `enqueueAgentWork`, memory `vectorCapability` cache +
  hoisted insert statements + `cosineDistance` cleanup, browser-runner
  `clearTimeout`. Commits `eaa41e8`, `97fb605`, `c7fd942`.
- **Frontend #69–75** + **test-helper consolidation #76–87** — useChat /
  render-perf / config-input / api groups; env + media-fixture + memory-fake helpers.
- **EventStream + config #3 atomicity** — a11y `inert`, memoized formatting,
  errored-done suppression; `commitConfigChange`/`clearConfigChange` (canonical
  owner in `config-registry.ts`), later folded into a shared `mutateConfig`
  primitive. Commits `7bea944`, `fac2658`, `d00c732`, `96c20ff`.
- **Addenda 2026-05-24 / -26 / -29** — discord REST migration (`client.rest`),
  attachment fire-and-forget → awaited send boundary + timeout abort, useChat WS
  session-effect keying, `formatSetting`/`normalizeOutboundText` dedup. The
  2026-05-29 decomposition review found **zero** behavior-change bugs.

---

## OPEN — step 10 DEFER-risky tier

Each changes observable behavior, adds bounds/eviction, rewrites SQL/IO, or is a
structural decomposition. Needs its own task + review — NOT a batch.

- **#55 — done (`9c9f018`).** `queue.then(work, work)` in `compactLcmCandidate`
  and `subscribeRuntime` stored a rejecting promise that poisoned the shared
  serialization queue (next link fired in its rejection slot, error discarded).
  Fixed: stored tail kept non-rejecting via `.catch`, real work promise awaited
  separately so the caller still surfaces its own error, `onRejected` slot
  dropped. (The finding's "double-run" framing was imprecise — `p.then(fn, fn)`
  runs one handler; no double-execution existed.)
- **#48 — discord `runtimes` Map grows unbounded → DEFERRED to the
  Discord-optional / web-first refactor.** [src/discord.ts]. The only unbounded
  source is **distinct Discord threads** (DMs + the one allowed channel are a
  fixed, web-shared set that eviction must pin anyway); at low thread usage the
  slope is ~1 dead entry per thread ever touched, not per message — low practical
  severity. A proper eviction daemon is new lifecycle machinery wired into the
  exact layer being reworked when the must-connect-to-Discord launch requirement
  is lifted; build it there against a settled runtime-ownership model. (`collectTimers`
  is self-healing — fires within collectDebounceMs and deletes its own entry — NOT
  a leak.) **Two real sub-bugs to fold into that refactor:**
  - The connect-failure rollback (discord.ts:~245) **discards the memory-projection
    unsubscribe handle** — a latent leak independent of eviction. Capture + call it.
  - Any eviction MUST route through `runtime.disconnect()` (the only chat-log
    `.lock` release); evicting without it orphans the lock and makes the channel
    un-recreatable in-process (same-PID lock is treated as live).
- **#42 — web-tools Jina double-fetches** when JSON parse fails on a text
  response. [src/web-tools.ts:866-895](src/web-tools.ts#L866-L895) (now under
  `src/web-tools/fetch-providers.ts`). NOT a pure dedup: the two fetches send
  different `Accept` headers (application/json vs text/plain) and Jina serves
  different bodies per Accept, so reusing the first response could change content.
  Detect Content-Type first.
- **#52 — diary sequential per-file indexing → bounded `Promise.all` (3–5).**
  [src/memory/diary/indexer.ts:120-128](src/memory/diary/indexer.ts#L120-L128).
  Changes index ordering; verify order-independence first.
- **#53 — lcm N+1 `getSummaryChildren`** per filtered candidate.
  [src/memory/lcm/condense.ts:30-39](src/memory/lcm/condense.ts#L30-L39).
  Batchable to one query but SQL-correctness-sensitive.
- **#54 — `snapshotSummariesForPrunedRecords` / `buildSummaryParentSnapshot`
  many small queries → CTE** walking `lcm_summary_parents`.
  [src/memory/lcm/store.ts:539-561,945-984](src/memory/lcm/store.ts#L539-L561).
  SQL correctness, high blast radius.
- **#56 — done (`a288fbe`).** chat-log `read()` now issues all per-day `.jsonl`
  reads via `Promise.all` (libuv threadpool bounds real concurrency), parses the
  resolved buffers in deterministic filename order, and keeps the final recordId
  sort — output order unchanged, same malformed-record error.
- **#57 — DROPPED (not a win; finding was wrong).** [src/image-derivatives.ts:102-124].
  The roadmap line assumed a full 6×4=24 encode scan, but the loop **already
  early-breaks** — it walks edge steps largest→first, quality high→first, and
  returns the first output under the 4.5 MB inline limit. The full 24 encodes only
  run in the worst case where nothing fits. Parallelizing would (a) force all 24
  encodes every time, pessimizing the common 1–2-encode path with more CPU + 24
  buffers in flight, and (b) require replicating the exact biggest-edge/highest-quality
  tie-break to keep output identical. sharp is CPU-bound on a 4-thread pool, so
  firing 24 at once just queues them. Net: trades common-case efficiency for
  rare-case latency and risks output drift. Leave the early-break loop as-is.
- **#59 — tts ElevenLabs fetch has no timeout** (other media helpers do).
  [src/tts.ts:126-141](src/tts.ts#L126-L141). Adds a new failure mode; decide the
  deadline deliberately.
- **#61 — `handleApi` 270-line switch-on-pathname → route table.**
  [src/web.ts:836-1102](src/web.ts#L836-L1102) (post-decomp: under `src/web/`).
  God-function decomposition, structural (more like #24 than a perf fix).
- **#63 — multipart `Buffer.toString("binary")` round-trip → streaming / work on
  `Buffer`.** [src/web.ts:144-189](src/web.ts#L144-L189) (now `src/web/multipart.ts`).
  Fragile, behavior-sensitive on large uploads.
- **#66 — half done (`2d3de8e`).** `loadStoredMessages` (now
  `src/agent/transcript-log.ts`) reads transcript `.jsonl` files via `Promise.all`,
  parsing in filename order (same pattern as #56). **Still open:** the O(N×files)
  full scan itself — bound reads by mtime/since-last-reset so a session load doesn't
  parse the entire transcript history. Behavior-sensitive (which messages load);
  defer until transcript volume bites.
- **#67 — done (`2d3de8e`).** `prompt`/`promptMessage` ~70-line dup collapsed into a
  shared `runPromptTurn` closure (queue serialization + non-rejecting tail + fixed
  teardown order; `promptMessage` scopes `activePromptOptions` via an enter/exit hook
  landing at the exact original finally points). Codex-reviewed behavior-preserving.
- **#68 — hot-reload watcher not re-attached on error.**
  [src/hot-reload.ts:147-150](src/hot-reload.ts#L147-L150). On transient EMFILE the
  daemon silently loses hot-reload. Adds retry logic; behavior change.
- **`enqueueAgentWork` → reuse `createWriteQueue`** (4th copy of the serial
  async-queue idiom). [src/discord.ts] + [src/util/fs.ts]. Mechanically equivalent,
  BUT `createWriteQueue` logs `console.error("… write failed", …)` on tail
  rejection where `enqueueAgentWork` is silent, and "write" mislabels
  prompt-dispatch. Behavior delta → decide the logging deliberately. (Surfaced
  in the c7fd942 consolidated review.)

---

## OPEN — pre-existing dedup / quality (surfaced during decomposition, deferred)

- **#36 — Insert-then-re-read N+1 in LCM.**
  [backfill.ts:127](src/memory/lcm/backfill.ts#L127),
  [indexer.ts:45](src/memory/lcm/indexer.ts#L45),
  [context-transformer.ts:395-396](src/memory/lcm/context-transformer.ts#L395-L396).
  Deferred (P5): the named sites already use `insertRecordReturningStored()`;
  changing `insertRecord()` itself is now mostly API churn across tests and
  non-hot-path callers.
- **#36a — RESOLVED (already done in current code).** `fingerprintRecords` no longer
  exists; `stableHash` (`store/serialization.ts`) is the single owner.
- **#36b — done (`2d3de8e`).** `readOptionalString` now throws on a present
  wrong-type value (undefined / empty-string still fall back). Chose fail-fast over
  documenting the lenience — silent fallback is a design smell and all 44 call sites
  read TOML fields that are always strings. (Full consolidation onto
  `readConfigString` for path-tagged errors remains available but is 44 edits of
  churn — not worth it now.)
- **#36c — `config-registry.ts` parallel `require*` readers.**
  [src/config-registry.ts:43-86](src/config-registry.ts#L43-L86)
  (`requireBoolean`/`requireInt`/`requireNumberInRange`/…) reimplement the
  coercion-and-throw logic of `src/config/readers.ts` with a `require`-prefix/`key`-arg
  convention. Overlaps #29. Consolidate onto the `src/config/readers.ts` set next
  time the override-apply path is touched.
- **`webMessageId()` / `messageId()` — RESOLVED (already done in current code).** The
  duplicate id *function* is gone; `discord/turn.ts` imports the shared `messageId`
  from `src/ids.js`. (`webMessageId` survives only as a record *field* name.)
- **`parseAgentReply` name collision — RESOLVED (already done in current code).**
  `discord/send.ts` now exports `parseOutboundReply` and imports the raw
  `silent-marker.ts` one as `parseSilentMarker`; the same-name footgun is closed.
- **`__test` / `__webTest` re-export objects now redundant.**
  [src/discord.ts:94](src/discord.ts#L94) and [src/web.ts:859](src/web.ts#L859) —
  every member is now an independent export of its real module; the umbrella objects
  exist only for test imports. Removing them means updating
  `test/discord-attachments.test.ts` + `test/web-{memes,history}.test.ts`. Defer to a
  test-import cleanup.

---

## OPEN — dropped (decisions recorded, do not re-litigate)

- **#62 — `loadAddedModels()` called twice per POST.**
  [src/web.ts:888](src/web.ts#L888). **Dropped (non-finding):** `loadAddedModels()` is
  already internally cached (`loaded`/`modelsCache` guard in `added-models.ts`); the
  two calls are cache-hit array spreads on a rare admin POST, not repeated disk reads.

---

## OPEN — deferred test items

- **#82 — 6 near-identical "debt" tests** in
  [test/memory-service.test.ts:582-799](test/memory-service.test.ts#L582-L799) and
  1109-1473 — parameterize. Deferred (P7): trades readability for line count; revisit
  only if the set grows.
- **#86 — `test/cli.test.ts` spawns `tsx src/cli.ts` per `it`** (seconds each,
  serial). [test/cli.test.ts](test/cli.test.ts). Deferred (P7): speedup, not dedup.

---

## OPEN — deferred misc

- **#58 — video read fully into memory + base64 inline → Gemini Files API.**
  [src/media-understanding.ts:80,87](src/media-understanding.ts#L80-L87). Real waste:
  `readFile` loads the whole video, then `.toString("base64")` allocates a second
  ~1.33× copy and the synchronous encode blocks the event loop. BUT the roadmap's
  "streaming rewrite" isn't available here — `@google/genai`'s `createPartFromBase64`
  requires an inline base64 string; `generateContent` has no streaming-upload path.
  The real fix is `ai.files.upload` (streaming upload → reference by URI), which
  changes external behavior (uploaded files persist server-side ~48h, different
  content part) — a small feature, not a perf cleanup. Re-scoped + deferred; bundle
  with a video size cap (none today) when picked up as its own task.
- **#8 / 2026-05-26 Follow-up #8 — paginated history rebuilds the full transcript.**
  [src/web.ts:383-434](src/web.ts#L383-L434). Page loads scale with total transcript
  size, not page size. DEFERRED — transcript size not biting yet; window record/message
  ids before folding steps when it does.

---

## OPEN — LOW polish (step 11)

Lowest priority; fold in opportunistically when already touching a file.

The first three earlier bullets landed in `77fe5ce` (clonePayload dead-fallback
drop + inline, `scheduler.ts`/`lcm/store.ts` narration-comment trims,
`scripts/spike.ts` `Model<any>` → `Model<Api>`). The config.ts/agent.ts
narration anchors no longer exist (cleaned during decomposition). What remains:

- **Pre-existing latent edges (verified not introduced by the decomp).** Partly
  resolved in `4fcaec4`:
  - **DONE** — `chunking.ts` surrogate-pair split (both hard-cut sites now route
    through `avoidSurrogateSplit`; regression test added) and `send.ts` reply
    first-chunk `try` (isSendable check hoisted out so the "falling back" log is
    honest).
  - **DROPPED** — `chunkDiscordParagraph` `slice(0, limit)` fallback (only
    reachable with 2000+ chars of pure whitespace — pathological);
    `chunkDiscordNewline` returns `[]` for empty input (a deliberate
    decision — silence beats an "(empty response)" placeholder; owner runs
    newline mode and is fine with it); `web/messages.ts` `ensureFallbackSteps`
    `thinkingMs === 0` (never observed; `0`+empty-text combination not produced
    in practice).
  - **OPEN (mild)** — `readJsonBody` (`src/web/http.ts`) does `JSON.parse`
    without try/catch. NOT a crash — the `handleApi` outer try/catch (web.ts:774)
    catches it — but malformed JSON returns 500 instead of 400. Fix is a local
    try/catch → 400 when the override-apply / web area is next touched.
