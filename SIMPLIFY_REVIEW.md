# Simplify Review — open worklist

Rolling worklist from the 2026-05-23 codebase-wide `/simplify` pass (10 Opus
subagents + a Codex atomicity pass) plus follow-up scans (2026-05-24, -26, -29,
-30). **Completed work is summarized below; the rest of this file tracks only
what is still open — deferred, dropped, and low-priority.** Many files have been
decomposed since the original review, so the `file:line` anchors below have
drifted — re-locate each finding in current code before acting.

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
- **#56 — chat-log JSONL files read sequentially → `Promise.all` + merge.**
  [src/chat-log.ts:260-280](src/chat-log.ts#L260-L280). Must preserve record order.
- **#57 — sharp 6×4 encode grid runs sequentially**; inner quality loop is
  monotonic so early-break is safe.
  [src/image-derivatives.ts:94-124](src/image-derivatives.ts#L94-L124). Must prove
  output byte-identical to the full scan.
- **#58 — video read fully into memory + base64 inline** doubles memory, blocks
  the event loop. [src/media-understanding.ts:79-89](src/media-understanding.ts#L79-L89).
  Streaming rewrite; changes memory profile.
- **#59 — tts ElevenLabs fetch has no timeout** (other media helpers do).
  [src/tts.ts:126-141](src/tts.ts#L126-L141). Adds a new failure mode; decide the
  deadline deliberately.
- **#61 — `handleApi` 270-line switch-on-pathname → route table.**
  [src/web.ts:836-1102](src/web.ts#L836-L1102) (post-decomp: under `src/web/`).
  God-function decomposition, structural (more like #24 than a perf fix).
- **#63 — multipart `Buffer.toString("binary")` round-trip → streaming / work on
  `Buffer`.** [src/web.ts:144-189](src/web.ts#L144-L189) (now `src/web/multipart.ts`).
  Fragile, behavior-sensitive on large uploads.
- **#66 — `loadStoredMessages` O(N×files) dir scan + full read per session.**
  [src/agent.ts:225-273](src/agent.ts#L225-L273). Bound by mtime/since-last-reset;
  behavior-sensitive (which messages load).
- **#67 — agent `prompt` / `promptMessage` ~70-line structural dup**
  (queue/subscribe/teardown). [src/agent.ts:728-805](src/agent.ts#L728-L805).
  Safe in principle but concurrency/teardown-sensitive; own task.
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
- **#36a — `stableHash` duplicated.**
  [src/memory/lcm/context.ts:82-84](src/memory/lcm/context.ts#L82-L84)
  `fingerprintRecords` is byte-identical to `stableHash`
  ([store/serialization.ts:30-32](src/memory/lcm/store/serialization.ts#L30-L32)).
  Import `stableHash` instead.
- **#36b — `readOptionalString` is type-lenient.**
  [src/config/readers.ts:8-10](src/config/readers.ts#L8-L10) silently returns the
  fallback for non-string values instead of throwing like the other `read*`
  validators. A misconfigured non-string in the TOML is swallowed. **Decide:** throw
  on wrong-type, or document the lenience.
- **#36c — `config-registry.ts` parallel `require*` readers.**
  [src/config-registry.ts:43-86](src/config-registry.ts#L43-L86)
  (`requireBoolean`/`requireInt`/`requireNumberInRange`/…) reimplement the
  coercion-and-throw logic of `src/config/readers.ts` with a `require`-prefix/`key`-arg
  convention. Overlaps #29. Consolidate onto the `src/config/readers.ts` set next
  time the override-apply path is touched.
- **`webMessageId()` duplicates `messageId()`.**
  [src/discord/turn.ts:31](src/discord/turn.ts#L31) returns `msg_${uuid}`, identical
  to [src/web/ids.ts:12](src/web/ids.ts#L12). Cleanest fix is a shared `src/ids.ts`;
  folding turn.ts into `../web/ids.js` would be a discord→web layer crossing. Defer
  to a dedicated id-module consolidation.
- **`parseAgentReply` name collision.**
  [src/silent-marker.ts:7](src/silent-marker.ts#L7) exports a raw `parseAgentReply`
  (no normalization); [src/discord/send.ts:67](src/discord/send.ts#L67) exports a
  *normalizing* wrapper of the same name. `discord/turn.ts` imports the normalizing
  one; `web.ts` imports the raw one. Same name, different semantics, different paths
  — a future consolidator could silently route web through the normalizing variant
  and leak `(empty response)` placeholders into the web UI. Rename the send.ts
  wrapper (e.g. `parseOutboundReply`) when next touching that area.
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

- **Pre-existing latent edges (verified not introduced by the decomp).**
  `src/discord/chunking.ts` `splitLongBlock` UTF-16 fallback can split surrogate
  pairs; `chunkDiscordParagraph` final-fallback `slice(0, limit)` truncates;
  `chunkDiscordNewline` returns `[]` for empty input while the other modes return the
  `(empty response)` sentinel. `src/discord/send.ts` reply first-chunk `try` also
  catches its own `!isSendable()` throw, then re-checks below (mislabeled log).
  `src/web/messages.ts` `ensureFallbackSteps` admits `thinkingMs === 0` via `!= null`.
  `readJsonBody` (`src/web/http.ts`) `JSON.parse` without try/catch (→ 500 on malformed
  body). All low priority.
