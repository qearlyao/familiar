# Simplify Review — 2026-05-23

Codebase-wide review pass. Findings only, no edits applied. Two review passes were merged:

- **Opus 4.7 pass** — 10 parallel subagents reviewed 110 source + test files across orchestration, web, config, memory (lcm/index/diary), media, frontend, and tests. Applied the `simplify` skill's three lenses (reuse, quality, efficiency). Excluded: `web/src/components/ui/*` shadcn boilerplate, `dist/`, `node_modules/`, markdown.
- **Codex pass** — independent review with thermo-nuclear code-quality criteria; skipped `web/` frontend. Caught four atomicity/crash-consistency bugs that the per-file lens missed.

Items prefixed **[Codex]** came from the Codex pass.

---

## HIGH — atomicity, correctness, leaks, hot-path bloat

### Crash-consistency / atomicity (Codex)

1. **[Codex]** [src/runtime.ts:495](src/runtime.ts#L495) — Job completion is not crash-atomic. Outbound is written before `job_completed`; a crash between the two replays an already-answered job. Fix: make terminal job persistence one canonical record/transaction, or treat `outbound.jobId` as terminal during recovery.
2. **[Codex]** [src/memory/operator.ts:254](src/memory/operator.ts#L254) — Prune mutates active segment status to fit a single `activeSegmentId` retention API. In multi-session use, active raw context can be pruned then reopened as active. Fix `applyNewSessionRetention` to accept an excluded active segment set.
3. **[Codex]** [src/memory/lcm/context-transformer.ts:270](src/memory/lcm/context-transformer.ts#L270) — Compaction mutates live context before summary persistence succeeds. Persist first, then swap in the synthetic summary.
4. **[Codex]** [src/memory/index/chunk-indexer.ts:53](src/memory/index/chunk-indexer.ts#L53) — Source replacement deletes stale mappings before embedding/new insert completes. Prepare all chunks first, then replace source mappings and chunks in one store transaction.
5. **[Codex]** [src/inbound-attachments.ts:224](src/inbound-attachments.ts#L224) — Inbound rollback tracks originals but not derived image files created by [src/image-derivatives.ts:112](src/image-derivatives.ts#L112). Track every created path or stage a temp batch and commit by rename. (Also flagged by the Opus pass at lower severity.)

### Memory subsystem hot-path bloat (per turn)

6. [src/memory/lcm/context.ts:208-251](src/memory/lcm/context.ts#L208-L251) + [eviction-score.ts:21-27](src/memory/lcm/eviction-score.ts#L21-L27) — `selectLeafChunk` is O(N² · K · |records|) per turn; `scoreEvictable` rebuilds the TF/IDF doc-frequency map on every call. Precompute term frequencies once per prompt.
7. [src/memory/lcm/context-transformer.ts:694-723](src/memory/lcm/context-transformer.ts#L694-L723) — `assembleWithinBudget` calls `state.items.indexOf` inside its sort comparator → O(N² log N) every turn. Precompute a `Map<item, index>`.
8. [src/memory/lcm/context-transformer.ts:204-237](src/memory/lcm/context-transformer.ts#L204-L237) — `evaluateCompactionPressure` runs twice per turn over the same state (once in `transformLcmContext`, once per round in `serviceCompactionDebtForState`). Memoize per state-version.
9. [src/memory/index/store.ts:259-310](src/memory/index/store.ts#L259-L310) — `searchSemanticLinear` decodes every embedding and full-sorts; needed when sqlite-vec missing or corpus-scoped. Stream via `iterate()` + min-heap of size `limit`.
10. [src/memory/index/chunk-indexer.ts:144-188](src/memory/index/chunk-indexer.ts#L144-L188) — Triple-scans the same chunks and re-queries hashes that `whichHashesPresent` already knows. Pass the lookup map through.
11. [src/memory/lcm/backfill.ts:121-142](src/memory/lcm/backfill.ts#L121-L142) — Per-record pre-existence check + insert re-queries the same key twice; `insertRecord` already de-dupes.
12. [src/memory/lcm/store.ts:445-453](src/memory/lcm/store.ts#L445-L453) — N+1 `deleteRecordFtsRow` per row inside `applyNewSessionRetention`; replace with `DELETE … WHERE rowid IN (SELECT id …)`.

### Web layer correctness

13. [src/web-tools.ts:151-162](src/web-tools.ts#L151-L162) — `PageCache.get` overwrites `entry.fetchedAt = Date.now()` on every read, **disabling the TTL entirely** (recently-read pages never expire). Split into `fetchedAt` (immutable) and `lastAccessed`.
14. [src/web.ts:1130-1137](src/web.ts#L1130-L1137) — WebSocket "hello" frame can race ahead of async `channelKey` assignment, silently `continue`ing on line 1147 (auth-race / missed-replay). Await runtime lookup before accepting the socket.
15. [src/web.ts:480-547,743](src/web.ts#L480-L547) — Four parallel Maps/Sets (`startedSilentMessage`, `silentFilters`, `pendingMessageStarts`, `locallyStreamedOutboundIds`) for in-flight messages, with scattered cleanup; entries leak if `message_end` never arrives. Collapse into a single keyed map with TTL.
16. [src/web-auth.ts:18-26](src/web-auth.ts#L18-L26) — `parseCookies` calls `decodeURIComponent` on untrusted input without try/catch → DoS via malformed cookie.

### Discord orchestration

17. [src/discord.ts:938-1216](src/discord.ts#L938-L1216) — `drainJobs` / `runHeartbeat` / `runCronJob` are ~120 lines of triplicate scaffold (recorder + prompt + flush + parseAgentReply + send). Highest-value refactor in the file — extract `runAgentTurn`.

### Test leaks / flake

18. **Cumulative tmp-dir leak across the memory test suite** — `createTempDataDir`/`mkdtemp` in memory-service, chunk-indexer, diary-*, lcm-*, memory-backfill, memory-doctor, memory-index-store, memory-tools, web-static **never clean up**. Add `t.after(() => rm(dir, { recursive: true, force: true }))` everywhere. Single biggest cumulative leak in the suite.
19. [test/discord-attachments.test.ts:11](test/discord-attachments.test.ts#L11) — Hardcoded `/tmp/familiar-discord-test`; parallel runs collide, never cleaned up. Switch to `createTempDataDir()`.
20. [test/installer.test.ts:22-57](test/installer.test.ts#L22-L57), [test/service.test.ts:54-144](test/service.test.ts#L54-L144) — `mkdtemp` without cleanup; chmod'd shell stubs + plist/unit files leak permanently.
21. [test/hot-reload.test.ts:10-12,52](test/hot-reload.test.ts#L10-L12) — `delay(30)` waiting for 5ms debounce → CI flake risk. Use a promise signaled by the callback.
21a. **Follow-up to #18 (discovered during P4 commit):** [test/helpers.ts:27-34](test/helpers.ts#L27-L34) — `createWorkspace()` is called inside `configWithDataDir()` and creates a third tmp dir (`familiar-test-*`) that the caller never sees and therefore can't clean up. Re-running the suite post-P4 still leaks ~176 `familiar-test-*` dirs per run (vs. ~63 `familiar-data-*`, which is residual `createTempDataDir` callsites). Fix: have `configWithDataDir` accept the test's `t` and register cleanup for the inner workspace dir. Touches every `configWithDataDir` callsite. Severity: HIGH (biggest remaining leak source).

### Frontend

22. [web/src/lib/useChat.ts:137-143](web/src/lib/useChat.ts#L137-L143) — `delta` handler rebuilds the entire messages array per token, bypassing `upsertMessage`. Use the existing helper.
23. [web/src/lib/useChat.ts:237-322](web/src/lib/useChat.ts#L237-L322) — Session-change effect depends on `handleEvent`, whose identity changes with `activeSessionKey`, tearing down/reconnecting the WebSocket. Stash in a ref.

### God modules (Codex framing)

24. **[Codex]** ~~Decompose along ownership boundaries.~~ **Done — all six god-modules decomposed (pure relocation: closure-free helpers/types/consts into focused submodules, public export paths preserved via re-export, no behavior change).**
    - ~~[src/discord.ts:938](src/discord.ts#L938)~~ — 1462 → 785 lines, into `src/discord/{chunking,send,channel,inbound,commands,turn,client}.ts`.
    - ~~[src/web.ts:421](src/web.ts#L421)~~ — 1336 → 865 lines, into `src/web/{ids,multipart,memes,messages,payloads}.ts` plus consolidating `src/web-{auth,events,http,static,types}.ts` under `src/web/`.
    - ~~[src/web-tools.ts:1](src/web-tools.ts#L1)~~ — 1147 → 204 lines, into `src/web-tools/{types,cache,http,util,config,safety,search-providers,fetch-providers,format,routing}.ts`.
    - ~~[src/memory/lcm/store.ts:125](src/memory/lcm/store.ts#L125)~~ — 1050 → 535 lines, into `src/memory/lcm/store/{row-types,serialization,normalizers,row-mappers,snapshots,inserts,index-ids}.ts`; `runSummaryInsertTransaction` absorbed as a class private method.
    - ~~[src/config.ts:574](src/config.ts#L574)~~ — 930 → 504 lines, into `src/config/{types,readers,enums,interpolate,model-refs,sections}.ts`; cron-format asserts moved file-private into `sections.ts`, model-ref parsers into `model-refs.ts`.
    - ~~[src/agent.ts:121](src/agent.ts#L121)~~ — 842 → 521 lines, into `src/agent/{types,tool-descriptions,payload-normalizers,transcript-log,session-helpers,tools}.ts`; `createFamiliarAgent` factory closure stays in `agent.ts`.

    (Item #17 is the first slice of discord.ts; #28-30 below address web.ts/web-tools.ts/config.ts.)

---

## MED — duplications, real waste, hot-path inefficiency

### Cross-cutting duplications (single biggest cleanup payoff)

25. `isRecord` defined 3× ([agent.ts:148](src/agent.ts#L148), [agent-events.ts:18](src/agent-events.ts#L18), [browser-tools.ts:279](src/browser-tools.ts#L279)) — extract to `src/util/guards.ts`.
26. `isThinkingLevel` defined 3× ([config.ts:286](src/config.ts#L286), [settings.ts:35](src/settings.ts#L35), [models.ts:184](src/models.ts#L184)).
27. `formatLocalTimestamp` duplicated between [runtime.ts:82-102](src/runtime.ts#L82-L102) and [scheduler.ts:82-101](src/scheduler.ts#L82-L101) — scheduler's version is the superset.
28. `parseModelRef` (models.ts:44) vs `maybeParseProviderModelRef` ([config.ts:455](src/config.ts#L455)) — same algorithm, field-name drift.
29. `resolveProviderSetting` copy-pasted into [config-registry.ts:88-94](src/config-registry.ts#L88-L94) from config.ts:383.
30. **Three identical write-queue patterns** (`writeQueue.then(persist, () => persist())`) in [config-overrides.ts:52-65](src/config-overrides.ts#L52-L65), [settings.ts:107-114](src/settings.ts#L107-L114), [added-models.ts:65-75](src/added-models.ts#L65-L75) — silently swallow errors. Extract `createWriteQueue()` + `atomicWriteJson(path, value)`.
31. **Eleven near-identical enum validators** in [config.ts:281-367](src/config.ts#L281-L367) — replace with one `readEnum<T>(value, path, allowed)` helper. ~80 lines removed.
32. **Image mime-sniffing & ext tables duplicated** between [image-gen.ts:29-35,185-197](src/image-gen.ts#L29-L35) and [inbound-attachments.ts:51-64,89-119](src/inbound-attachments.ts#L51-L64).
33. **ENOENT-swallowing fs reads** repeated in `persona.ts`, `data-retention.ts`, `scheduler.ts`, `chat-log.ts` — extract `readFileOrNull` / `isEnoent`.
34. **`positiveIntegerOrDefault` defined 4×** across memory tree ([diary/chunks.ts:287](src/memory/diary/chunks.ts#L287), [index/retrieval.ts:331](src/memory/index/retrieval.ts#L331), [diary/ambient-injector.ts:86](src/memory/diary/ambient-injector.ts#L86), [diary/ambient.ts:183](src/memory/diary/ambient.ts#L183)) — single `src/memory/util.ts` would consolidate.
35. **`db.inTransaction ? runX() : db.transaction(runX).immediate()`** pattern repeats 6+ times across [operator.ts](src/memory/operator.ts) and [doctor.ts](src/memory/doctor.ts).
36. ~~**Insert-then-re-read N+1** in LCM: [backfill.ts:127](src/memory/lcm/backfill.ts#L127), [indexer.ts:45](src/memory/lcm/indexer.ts#L45), [context-transformer.ts:395-396](src/memory/lcm/context-transformer.ts#L395-L396) — have `insertRecord` return the `StoredLcmRecord`.~~ **Deferred (P5):** the named call sites already use `insertRecordReturningStored()`; changing `insertRecord()` itself would now be mostly API churn across tests and non-hot-path callers.
36a. **`stableHash` duplicated** — [src/memory/lcm/context.ts:82-84](src/memory/lcm/context.ts#L82-L84) `fingerprintRecords` is byte-identical to `stableHash` ([store/serialization.ts:30-32](src/memory/lcm/store/serialization.ts#L30-L32)): both `createHash("sha256").update(JSON.stringify(...)).digest("hex")`. Import `stableHash` instead. (Surfaced during #25/#26 decomp review; pre-existing, deferred to keep the carve-outs pure relocation.)
36b. **`readOptionalString` is type-lenient** — [src/config/readers.ts:8-10](src/config/readers.ts#L8-L10) silently returns the fallback for non-string values instead of throwing like the other `read*` validators (`readConfigString`, `readBoolean`, etc. all reject wrong types). A misconfigured non-string in the TOML is swallowed. Decide: throw on wrong-type, or document the lenience. (Surfaced during #26 config decomp review; pre-existing behavior, not a carve-out regression.)
36c. **`config-registry.ts` parallel `require*` readers** — [src/config-registry.ts:43-86](src/config-registry.ts#L43-L86) (`requireBoolean`/`requireInt`/`requireNumberInRange`/`requireNonNegativeInt`/…) reimplement the same coercion-and-throw logic as `src/config/readers.ts`, with a `require`-prefix/`key`-arg convention instead of `read`-prefix/`path`-arg. Overlaps #29 (`resolveProviderSetting` copy). Consolidate onto the `src/config/readers.ts` set once the override-apply path is next touched. (Surfaced during #26 config decomp review; pre-existing.)

### Backend hot-path inefficiencies

37. ~~`getLastQueuedTriggerRecordId` / `getLastCompletedTriggerRecordId` scan full records array per inbound message.~~ **Done (step 10, `eaa41e8`):** maintained incrementally via `indexRecordForTriggers` (folded into the `rebuildPendingJobs` load loop + `appendRecord` live path); reads are O(1). `rebuildPendingJobs` now resets the fields first so idempotence is by design.
38. ~~`buildPrompt` and `buildPromptAttachments` filter the same slice twice.~~ **Done (step 10, `eaa41e8`):** `beginNextJob` computes the slice once via `triggerInboundSlice` and feeds both; per-turn filter passes 2→1 (Opus simplify-review caught that the first cut deduped code but not the scan).
39. **Deferred (step 10):** [src/runtime.ts] `records: ChatLogRecord[]` grows unbounded per channel. NOT a pure hot-path fix — `getRecords()` feeds `web.ts webHistoryPayload`, so a sliding window would silently truncate the web history panel. Needs web history to read from the persisted log instead; separate design task.
40. ~~Per-request `existsSync(distDir)` + recomputed project root.~~ **Done (step 10, `97fb605`):** `DIST_DIR` resolved once at module load (now `src/web/static.ts`); existsSync kept per-request so a dist built after boot is still served (Opus altitude review reverted an over-eager memo).
41. ~~`serveAttachment` re-`realpath`s up to 3 roots per request.~~ **Done (step 10, `97fb605`):** successful per-root realpaths cached in a module map; failures uncached so lazily-created dirs stay retryable. Per-file security syscalls (lstat/symlink/realpath/stat) left intact — inherent to safe serving.
42. [src/web-tools.ts:866-895](src/web-tools.ts#L866-L895) — Jina double-fetches when JSON parse fails on a text response; detect Content-Type first.
43. [src/web-tools.ts:244-312](src/web-tools.ts#L244-L312) — `fetchJson` and `fetchText` share ~25 lines of identical error wrapping/abort handling; factor a `performFetch`.
44. [src/web-tools.ts:377-468](src/web-tools.ts#L377-L468) — `parseBraveResults` / `parseExaResults` / `parseTavilyResults` share identical skeleton (~50 lines of dup).
45. [src/discord.ts:1008-1216](src/discord.ts#L1008-L1216) — `getOwnerDmSession()` re-calls `client.users.createDM(...)` on every heartbeat/cron tick. Cache once.
46. [src/discord.ts:434-490](src/discord.ts#L434-L490) — `sendReply` and `sendChannelMessage` share ~30 lines of chunk-loop + attachment-payload logic.
47. [src/discord.ts:807-847](src/discord.ts#L807-L847) — `promptForRuntime` / `promptScheduledMessage` share ~30 lines of queue/owner/restore logic.
48. [src/discord.ts:782-783](src/discord.ts#L782-L783) — `runtimes` Map and `collectTimers` Map grow unbounded for long-lived bots.
49. [src/memory/index/store.ts:497-499](src/memory/index/store.ts#L497-L499) — `vectorCapability()` re-reads `memory_meta` on every insert/search/stats. Cache at construction.
50. [src/memory/index/store.ts:539-577](src/memory/index/store.ts#L539-L577) — `prepare()` re-compiled per row in `insertNormalized`; hoist statements.
51. [src/memory/index/vector-codec.ts:13-27](src/memory/index/vector-codec.ts#L13-L27) — `cosineDistance` has dead `?? 0` on `Float32Array` indices; two `sqrt` per chunk in the inner search loop.
52. [src/memory/diary/indexer.ts:120-128](src/memory/diary/indexer.ts#L120-L128) — Sequential per-file indexing during initial diary load; bounded `Promise.all` (3-5) would help.
53. [src/memory/lcm/condense.ts:30-39](src/memory/lcm/condense.ts#L30-L39) — N+1 `getSummaryChildren` per filtered candidate.
54. [src/memory/lcm/store.ts:539-561,945-984](src/memory/lcm/store.ts#L539-L561) — `snapshotSummariesForPrunedRecords` and `buildSummaryParentSnapshot` issue many small queries; use CTE walking `lcm_summary_parents`.
55. [src/memory/lcm/segment-manager.ts:38-46](src/memory/lcm/segment-manager.ts#L38-L46) + [context-transformer.ts:294-296](src/memory/lcm/context-transformer.ts#L294-L296) — `queue.then(run, run)` swallows errors and double-runs work on rejection.
56. [src/chat-log.ts:260-280](src/chat-log.ts#L260-L280) — JSONL files read sequentially; `Promise.all` + merge would parallelize.
57. [src/image-derivatives.ts:94-124](src/image-derivatives.ts#L94-L124) — 6×4 grid of sharp encodings runs sequentially; the inner quality loop is monotonic so early-break is safe.
58. [src/media-understanding.ts:79-89](src/media-understanding.ts#L79-L89) — Reads full video into memory + base64 inline; doubles memory and blocks event loop.
59. [src/tts.ts:126-141](src/tts.ts#L126-L141) — No timeout on the ElevenLabs fetch (other media helpers do); hung requests block.
60. ~~Derived attachment files aren't tracked in `writtenPaths`; partial failure leaks them.~~ **Done in step 6 (HIGH #5):** `inbound-attachments.ts` now pushes derived image paths into `writtenPaths` and the rollback `unlink`s them.
61. [src/web.ts:836-1102](src/web.ts#L836-L1102) — `handleApi` is a 270-line switch-on-pathname with 16 branches; extract a route table.
62. [src/web.ts:888](src/web.ts#L888) — `loadAddedModels()` called twice per POST.
63. [src/web.ts:144-189](src/web.ts#L144-L189) — Multipart parser uses `Buffer.toString("binary")` round-trip; fragile + slow on large uploads. Use streaming parser or work on `Buffer` directly.
64. [src/browser-tools.ts:740-748](src/browser-tools.ts#L740-L748) — `buildSiteRunSpec` validates `site`/`command` and then `buildSiteArgs` does the same checks again.
65. [src/browser-tools.ts:218-267](src/browser-tools.ts#L218-L267) — `defaultBrowserRunner` leaks `timeout` on the abort branch (no `clearTimeout` inside `abort`).
66. [src/agent.ts:225-273](src/agent.ts#L225-L273) — `loadStoredMessages` does O(N×files) full directory scan + full file read per session creation. Bound by mtime/since-last-reset.
67. [src/agent.ts:728-805](src/agent.ts#L728-L805) — `prompt` and `promptMessage` are ~70 lines of structurally identical queue/subscribe/teardown.
68. [src/hot-reload.ts:147-150](src/hot-reload.ts#L147-L150) — On watcher error, watcher closed but never re-attempted; long-running daemon silently loses hot-reload on transient EMFILE.

### Frontend

69. [web/src/components/MessageList.tsx:46-48](web/src/components/MessageList.tsx#L46-L48) — Smooth-scroll fires per token during streaming, queuing fights. Use `behavior: "auto"` while streaming.
70. [web/src/components/MessageList.tsx:62-77](web/src/components/MessageList.tsx#L62-L77) — No `React.memo` on `MessageBubble`; every token re-renders all historical bubbles.
71. [web/src/components/config/](web/src/components/config/) — `OnOffToggle` reimplemented in 3 sections; `NumberInput`/`MinuteInput`/`ModelRefInput` are the same draft/busy/commit hook. Extract `useCommittedInput` + shared `OnOffToggle`.
72. [web/src/components/config/MemorySection.tsx:246,257…](web/src/components/config/MemorySection.tsx#L246) — `key={…value…}` forces input remount on every commit → focus/selection thrown.
73. [web/src/lib/useAgentSettings.ts](web/src/lib/useAgentSettings.ts) + [useConfig.ts](web/src/lib/useConfig.ts) — Structural twins with the same alive-ref/load/mutate boilerplate. Extract `useIsMounted` + `usePostRequest`.
74. [web/src/lib/api.ts:159-320](web/src/lib/api.ts#L159-L320) — Three POST/DELETE helpers share the same "fetch / parse error / throw" body; one `jsonRequest` would dedupe ~70 lines.
75. [web/src/components/ConfigDrawer.tsx:127-174](web/src/components/ConfigDrawer.tsx#L127-L174) — 18 lines of stringly-typed prop-drilling into `MemorySection`; pass `configData` or a typed `valueOf<K>(key)` accessor.

### Test helpers consolidation

76. ~~`withEnv` / `withoutEnv` / `withDiscordToken` boilerplate appears in 8+ test files; consolidate in [test/helpers.ts](test/helpers.ts).~~ **Done (P7a):** lifted into test/helpers.ts, adopted in agent-reload, skills, embedding-provider, image-gen. config.test.ts kept its describe-level before/after idiom (cleaner than wrapping 30 tests); two inbound + three image-gen tests that also juggle `globalThis.fetch` kept their existing try/finally.
77. ~~PNG/MP4 fixture bytes duplicated between image-gen and inbound-attachments.~~ **Done (P7a):** shared via new test/media-fixtures.ts (kept out of helpers.ts so the `sharp` dep stays off the common import path).
78. ~~`FakeEmbeddingProvider` cloned across 8+ memory tests.~~ **Done (P7b):** shared `FakeEmbeddingProvider` in test/memory-fakes.ts; migrated chunk-indexer, lcm-indexer, memory-backfill, memory-doctor. Left the charCode-vector providers (diary-chunks, diary-indexer), the query-tracking ones (diary-ambient, memory-retrieval), and memory-tools' fixed-vector variant — their shapes genuinely diverge.
79. ~~`FakeStore`/`FakeRetrievalStore` + `hit()` factory duplicated.~~ **Done (P7b):** shared `FakeRetrievalStore` + `memoryHit()`; migrated diary-ambient and memory-retrieval.
80. ~~`LcmSourceProvenance source` + `storedRecord()`/`record()` builder cloned 5×.~~ **Done (P7b):** shared `testLcmSource` const + `lcmRecord()` for eviction-score, lcm-context, lcm-condense. Left lcm-indexer's `storedRecord()` and lcm-store's function-style `source(id)` (different signatures).
81. ~~`assistantMessage()` + `contentText()`/`renderMessages()` + `zeroUsage()` repeated.~~ **Done (P7b):** all four shared in test/memory-fakes.ts; migrated memory-service, lcm-context, lcm-condense.
82. 6 near-identical "debt" tests in [test/memory-service.test.ts:582-799](test/memory-service.test.ts#L582-L799) and 1109-1473 — parameterize. **Deferred (P7):** parameterizing trades readability for line count; revisit only if the set grows.
83. ~~`withEmbeddingFetch` used in ~25 places but bypassed in 2; fold them in and have it return `{ callCount }`.~~ **Moot (P7):** the two bypass sites deliberately assert on `embeddingCalls === 0` / fetch ordering with their own `globalThis.fetch`; folding them in would obscure the assertion.
84. ~~`withMemoryService(config, fn)` harness would remove ~400 lines and 8 copies of `try/finally service.close()`.~~ **Done (P7b):** `withMemoryService` in test/memory-fakes.ts; migrated 7 straightforward close blocks. Left watcher, runtime-cleanup, and multi-service-restart cases where the helper would obscure ordering.
85. ~~~30 tests reopen `LcmStore` mid-test when `service.lcmStore` is already exposed.~~ **Done (P7b):** removed 7 pure reopen-to-read blocks in favour of `service.lcmStore` (better-sqlite3 commits synchronously, so live store == fresh handle after flush). Left deliberate persistence/restart/peer-store-write reopens.
86. [test/cli.test.ts](test/cli.test.ts) — Each `it` spawns `tsx src/cli.ts` via `execFile` — seconds per test, serial. **Deferred (P7):** speedup, not dedup; out of this pass's scope.
87. ~~[test/generated-media.test.ts:24-49](test/generated-media.test.ts#L24-L49) — Two byte-identical tests; delete one.~~ **Done (P7a).**

---

## LOW — style/polish

Each agent produced a long tail of LOW items (comment narration, micro-allocations, minor nesting, `WHAT`-comments narrating past changes). Not enumerated here; if you want the full per-file lists, see the raw agent outputs in `/private/tmp/claude-501/-Users-qearl-familiar/.../tasks/`.

A few patterns worth flagging:

- [config.ts:738](src/config.ts#L738), [store.ts:438](src/memory/lcm/store.ts#L438), [store.ts:473-474](src/memory/lcm/store.ts#L473-L474), [agent.ts:61,394-396](src/agent.ts#L61), [scheduler.ts:144](src/scheduler.ts#L144) — WHAT-comments / "Stage 9" / "v0" / "legacy advisory lineage scheduled for removal" comments narrating past project phases. Trim or convert to one-line invariant notes.
- `clonePayload` fallback at [agent.ts:143-146](src/agent.ts#L143-L146) — `structuredClone` has been stable in Node 17+ for years; drop the JSON.parse fallback.
- `scripts/spike.ts:15` uses `Model<any>` — defeats the generic.

---

## Recommended order of attack

[x]1. **Atomicity bugs (HIGH #1-5)** — clearest data-loss/replay risk. Codex's recommended starting point: `runtime.ts` job recovery and LCM retention.
[x]2. **Web correctness bugs (HIGH #13-16)** — TTL bug, WebSocket race, message-state leaks, cookie DoS. Small fixes, real impact.
[x]3. **Memory hot-path fixes (HIGH #6-12)** — these run per turn; biggest perf wins. Worth a focused branch.
[x]4. **Test hygiene — tmp-dir cleanup sweep (HIGH #18-21)** — easy, large blast radius, will reveal latent flakiness.
[x]5. **Shared utilities sweep (MED #25-36)** — one PR creating `src/util/guards.ts`, `src/util/fs.ts`, `src/memory/util.ts`, plus the `createWriteQueue` + `atomicWriteJson` + `readEnum` helpers. Cascades into every other simplification.
[x]6. **God-module decomposition (HIGH #17, #24) + discord attachment cleanup** — start with the `runAgentTurn` extraction in `discord.ts` since it's the most concentrated triplicate. Fold in the discord attachment findings from the 2026-05-24 + 2026-05-26 addenda, in this order:
   - [x] **6a.** 2026-05-24 addendum (`postDiscordAttachments` → `client.rest.post(Routes.channelMessages…)`). Doing this first likely makes 6c and 6d moot — discord.js's REST manager already handles timeouts/retries and accepts `RawFile` buffers directly.
   - [x] **6b.** Follow-up #1 (HIGH, attachment fire-and-forget vs persisted state) — make required attachment delivery part of the awaited send boundary; persist returned message ids alongside text ids.
   - [x] **6c.** Follow-up #2 (MED, `withDiscordSendTimeout` doesn't abort) — folded into 6a via `AbortSignal.timeout` on the REST request.
   - [x] **6d.** Follow-up #7 (LOW, Buffer→Uint8Array→Blob extra copy) — folded into 6a via `RawFile.data: Buffer`.
   - [x] **6e.** HIGH #17, `runAgentTurn` extraction across `drainJobs` / `runHeartbeat` / `runCronJob` — separate commit, follows attachment cleanup.
[x]7. **Test helpers consolidation (MED #76-87)** — extract once, ripple through. Done in two commits: P7a (env helpers + media fixtures + dup-test delete, #76/#77/#87) and P7b (shared memory fakes/builders, #78-81/#84-85). #82/#86 deferred (parameterize/speedup, not dedup); #83 moot. Net ~-310 lines.
[x]8. **Frontend hooks consolidation (HIGH #22-23, MED #69-75) + useChat cleanup** — meaningful for re-render perf. Done in four scoped groups:
   - **A** (useChat): collapsed `closeOpenContentSteps`/`closeAllSteps` → one `closeContentSteps` (Follow-up #9); extracted `patchSteps` for the delta/tool upserts (#22); stashed `handleEvent` in a ref so the WS effect only depends on `activeSessionKey` (#23 + Follow-up #4), no more teardown when `personaName` resolves.
   - **B** (render perf): `React.memo` on `MessageBubble` (#70) so unchanged bubbles skip per-token re-render; `scrollIntoView` switches to `behavior:"auto"` while streaming (#69).
   - **C** (config inputs): extracted shared `OnOffToggle`/`MinuteInput`/`NumberInput`/`ModelRefInput` into `config/inputs.tsx` + a `useCommittedInput` hook (#71); the hook resyncs the draft only while unfocused, replacing the `key={…value…}` remount hack that dropped focus (#72); extracted `useIsMounted` + `useRequestState` (`requestState.ts`), folding the mount-guard/busy/error lifecycle out of `useConfig` + `useAgentSettings` (#73).
   - **D** (api/drawer): one `jsonRequest` helper replaces six POST/DELETE fetch-parse-throw bodies in `api.ts` (#74); `MemorySection` now takes the typed `ConfigPayload["values"]` map instead of 18 drilled props, collapsing the `ConfigDrawer` call site (#75).
   - All 638 tests pass; web + backend typecheck + eslint clean; dev server transforms all changed modules without error. Browser click-test of input focus retention not run (no live backend in this env) — verified by typecheck + logic review.
[x]9. **EventStream + leftover atomicity polish** — small, scoped:
   - [x] Follow-up #5 (MED, `aria-hidden` over focusable `show more` button) — `inert={!open}` on the collapsed body wrapper now removes it from tab order + a11y tree (subsumes `aria-hidden`); the toggle button stays outside the wrapper so expand/collapse still works.
   - [x] Follow-up #6 (MED, `JSON.stringify` on every render) — both `formatValue` calls in `ToolContent` are `useMemo`'d on their inputs, so completed tools stop re-stringifying on every streaming re-render. Left the "defer until expansion" idea: the grid expand animation needs content mounted to animate to its height.
   - [x] Follow-up #10 (LOW, `done` check after errored tool) — `hasError` (any tool step `status === "error"`) suppresses the done row.
   - [x] Follow-up #3 (MED, config override mutates memory before durable write) — done via Codex + `/simplify` review: commit-or-rollback moved into `config-registry.ts` as `commitConfigChange`/`clearConfigChange` (canonical owner), web.ts handlers now only validate + dispatch. Committed `d00c732`.
   - [ ] Follow-up #8 (LOW, paginated history rebuilds full transcript) — DEFERRED; transcript size not biting yet. Window message ids before folding steps when it does.
10. **Backend hot-path inefficiencies (MED #37-68)** — per-call scans, N+1 queries, re-compiled statements, missing timeouts, and a few near-duplicate pipelines across `runtime.ts`, `web/`, `web-tools/`, `discord.ts`, the memory tree, and media helpers. No single big win; cluster by file and land independently.

    **Progress:** #37 #38 (`eaa41e8`), #40 #41 (`97fb605`) done. #39 deferred (web-history coupling). #60 already done in step 6 (HIGH #5 — `inbound-attachments.ts` now tracks derived paths in `writtenPaths` and unlinks on rollback).

    **Risk triage (2026-05-30, for the "pure perf only" pass).** SAFE = behavior-preserving dedup/cache/hoist, land in the batch. DEFER = changes observable behavior, adds bounds/eviction, rewrites SQL/IO, or is a structural decomposition — needs its own task + review, not the batch.

    SAFE-now (batched):
    - #42 web-tools Jina double-fetch — detect Content-Type before re-fetching; output identical.
    - #43 `fetchJson`/`fetchText` share ~25 lines — factor `performFetch`.
    - #44 `parseBrave`/`parseExa`/`parseTavily` share ~50-line skeleton — extract.
    - #45 `getOwnerDmSession` re-`createDM` per tick — cache the stable DM channel.
    - #46 `sendReply`/`sendChannelMessage` share ~30 lines — extract chunk-loop/attachment helper.
    - #47 `promptForRuntime`/`promptScheduledMessage` share ~30 lines — extract queue/owner/restore helper.
    - #49 `vectorCapability()` re-reads `memory_meta` every op — cache at construction.
    - #50 `prepare()` re-compiled per row in `insertNormalized` — hoist statements.
    - #51 (partial) `cosineDistance` dead `?? 0` on Float32Array indices — remove. (The two-`sqrt`→squared-distance change is DEFERRED: it alters returned distance values.)
    - #62 `loadAddedModels()` called twice per POST — call once.
    - #64 `buildSiteRunSpec` + `buildSiteArgs` re-validate `site`/`command` — validate once.
    - #65 `defaultBrowserRunner` leaks `timeout` on the abort branch — add `clearTimeout`. (Leak fix, behavior-preserving.)

    DEFER-risky (own task + review, NOT in the batch):
    - #48 discord `runtimes`/`collectTimers` Maps grow unbounded — needs eviction/lifecycle; behavior change.
    - #52 diary sequential per-file indexing → bounded `Promise.all` — changes index ordering; verify order-independence first.
    - #53 lcm N+1 `getSummaryChildren` — batchable to one query but SQL-correctness-sensitive; do carefully alone.
    - #54 `snapshotSummariesForPrunedRecords`/`buildSummaryParentSnapshot` CTE rewrite — SQL correctness, high blast radius.
    - #55 `queue.then(run, run)` swallows errors AND double-runs on rejection — this is a CORRECTNESS bug (belongs in `/code-review`, not a perf dedup); segment-manager + context-transformer.
    - #56 chat-log sequential JSONL reads → `Promise.all` + merge — must preserve record order; verify before parallelizing.
    - #57 sharp 6×4 encode grid early-break — must prove output byte-identical to the full scan.
    - #58 video read fully into memory + base64 inline — streaming rewrite, large, changes memory profile.
    - #59 tts ElevenLabs fetch has no timeout — adds a new failure mode (timeout); robustness change, decide the deadline deliberately.
    - #61 `handleApi` 270-line switch → route table — god-function decomposition, structural (more like #24 than a perf fix).
    - #63 multipart `Buffer.toString("binary")` round-trip → streaming — fragile, behavior-sensitive on large uploads.
    - #66 `loadStoredMessages` O(N×files) dir scan per session — bound by mtime/since-reset; behavior-sensitive (which messages load).
    - #67 agent `prompt`/`promptMessage` ~70-line dup — structural dedup but concurrency/teardown-sensitive; safe in principle, own task.
    - #68 hot-reload watcher not re-attached on error — adds retry logic; behavior change.
11. **LOW — style/polish** — comment-narration trims, the `clonePayload` JSON fallback, `Model<any>` in `scripts/spike.ts`, plus the long per-file tail not enumerated here. Lowest priority; fold in opportunistically when already touching a file.

Suggest small, scoped commits per category with regression testing after each — not one mega-PR.

---

[x]## Addendum — newer commits (2026-05-24)

Findings from a follow-up `/simplify` pass over commits `c01dafa`, `8461431`, `fdc737e`. Smaller items (O(n²) mime lookup, triple-ternary in `AttachmentList`, single-use `resolveForOptions` wrapper) were fixed in place. One real reuse win was left as-is because it touches the test mocks:

- **[src/discord.ts:424-448](src/discord.ts#L424-L448) — `postDiscordAttachments` hand-rolls Discord REST.** The function `fetch`es `https://discord.com/api/v10/channels/{id}/messages` with a manual `Authorization: Bot ${token}` header and a hand-built `FormData`. The same module already holds a live `Client<true>` (used for `client.channels.fetch`, `channel.send`, command registration). discord.js exposes `client.rest` — a pre-authenticated `REST` instance that handles the base URL, token, API version, ratelimit, retries, and multipart bodies via `RawFile[]`. Refactor to `client.rest.post(Routes.channelMessages(channelId), { files, body: {} })`. Drops the v10 pin, the manual auth header, the bespoke 200/`id` parsing, and removes a leaky abstraction. Touches [test/discord-attachments.test.ts:41-81](test/discord-attachments.test.ts#L41-L81) — the test currently stubs `globalThis.fetch`, would need to mock the REST manager instead. Severity: MED.

[x]## 2026-05-26 Follow-up scan (Codex) -- webui/web.ts/discord.ts deltas

Scope: current code in `src/discord.ts`, `src/web.ts`, `src/web-tools.ts`, `src/web-auth.ts`, and changed `web/src/` React/TS files, against baseline `f4bfa9f`.

### HIGH

1. [src/discord.ts:516-548](src/discord.ts#L516-L548), [src/discord.ts:1028-1043](src/discord.ts#L1028-L1043), [src/discord.ts:1128-1141](src/discord.ts#L1128-L1141), [src/discord.ts:1253-1267](src/discord.ts#L1253-L1267) — Discord attachment delivery now runs in a fire-and-forget background path while `completeActiveJob`/`noteOutbound` persist `reply.attachments`, so upload failure or process exit can leave durable state claiming an attachment exists without a delivered Discord message id. Fix: make required attachment delivery part of the awaited send boundary, include attachment message ids in persisted outbound state, or persist a retryable attachment-delivery failure separately. Lens: BONUS CROSS-WRITE ATOMICITY.

### MED

2. [src/discord.ts:455-468](src/discord.ts#L455-L468), [src/discord.ts:541-547](src/discord.ts#L541-L547) — `withDiscordSendTimeout` races an already-started upload without aborting the underlying fetch, so a timed-out attachment POST can continue consuming resources and may still post late. Fix: pass an `AbortSignal` through `postDiscordAttachments` and enforce the timeout with `AbortController`/`AbortSignal.timeout`. Lens: EFFICIENCY / BONUS CROSS-WRITE ATOMICITY.
3. [src/web.ts:1064-1067](src/web.ts#L1064-L1067), [src/web.ts:1088-1091](src/web.ts#L1088-L1091) — config override POST/DELETE mutates live `config` before the durable override write/clear and `entry.apply`, so a write/apply failure can leave memory diverged from disk while returning an error. Fix: stage the old value and roll back on failure, or move the mutation behind one helper that commits in memory only after persistence and apply succeed. Lens: BONUS CROSS-WRITE ATOMICITY.
4. [web/src/lib/useChat.ts:137-253](web/src/lib/useChat.ts#L137-L253), [web/src/lib/useChat.ts:280-364](web/src/lib/useChat.ts#L280-L364) — worsened original #23: the WebSocket session effect still depends on `handleEvent`, and `handleEvent` now also depends on `personaName`, so late auth/persona load can tear down the active socket, reset `lastEventIdRef`, and reconnect the same session. Fix: keep the socket effect keyed to `activeSessionKey` only, with `handleEvent`, `personaName`, and replay/session state behind refs or a stable event callback. Lens: EFFICIENCY / missing cleanup.
5. [web/src/components/EventStream.tsx:221-228](web/src/components/EventStream.tsx#L221-L228), [web/src/components/EventStream.tsx:328-335](web/src/components/EventStream.tsx#L328-L335) — collapsed event streams set `aria-hidden` on the body while descendant controls such as `show more` remain mounted and focusable inside a zero-height row. Fix: unmount collapsed bodies, use `inert` while closed, or move inner controls outside the hidden subtree. Lens: CODE QUALITY.
6. [web/src/components/EventStream.tsx:42-59](web/src/components/EventStream.tsx#L42-L59), [web/src/components/EventStream.tsx:166-180](web/src/components/EventStream.tsx#L166-L180) — tool args/results are fully formatted with `JSON.stringify` and line counting on every render, even when the stream is collapsed and only the summary row is visible. Fix: memoize formatted output by tool id/status/update timestamp and defer full body formatting until expansion. Lens: EFFICIENCY.

### LOW

7. [src/discord.ts:412-414](src/discord.ts#L412-L414), [src/discord.ts:438-444](src/discord.ts#L438-L444) — attachment upload reads into a `Buffer`, copies into a new `Uint8Array`, then wraps that in a `Blob`, doubling peak memory per local attachment. Fix: pass the `Buffer` directly as the blob part or create a zero-copy typed-array view. Lens: EFFICIENCY.
8. [src/web.ts:383-434](src/web.ts#L383-L434) — paginated history rebuilds every `WebMessage` and step timeline before slicing to `limit`, so page loads scale with total transcript size rather than page size. Fix: window records/message ids before folding steps, or maintain a materialized/indexed history view per runtime channel. Lens: EFFICIENCY.
9. [web/src/lib/useChat.ts:37-50](web/src/lib/useChat.ts#L37-L50), [web/src/lib/useChat.ts:96-108](web/src/lib/useChat.ts#L96-L108) — `closeOpenContentSteps` and `closeAllSteps` duplicate the same step-closing logic under different names. Fix: collapse them into one helper, parameterized only if completion behavior actually diverges. Lens: CODE REUSE / CODE QUALITY.
10. [web/src/components/EventStream.tsx:270-272](web/src/components/EventStream.tsx#L270-L272), [web/src/components/EventStream.tsx:361-367](web/src/components/EventStream.tsx#L361-L367) — the terminal `done` row appears after failed tool steps because completion only checks inactivity, not success. Fix: compute `hasError`/`allSucceeded` separately and suppress or replace the done row on errors. Lens: CODE QUALITY.

[x]## 2026-05-29 `/simplify --fix` over decomposition commits `1c62758` + `a498ad1`

Reviewed the discord.ts → `src/discord/*` and web.ts → `src/web/*` decompositions (#24 stage 1). 9-angle finder pass + sweep found **zero behavior-change bugs** — the moves are mechanically clean (bodies, signatures, call wiring, `__test`/`__webTest` surfaces all preserved; tests 635/635, tsc + biome clean). All surviving findings are cleanup the decomposition stopped one step short of.

### Applied (this pass)

- **`formatSetting<T>` lifted to [src/settings.ts](src/settings.ts#L14).** Was defined identically in `src/discord/commands.ts` and `src/web/payloads.ts` (pre-existing dup, both copies were being moved anyway). Now single source; discord.ts/web.ts/commands.ts import from `./settings.js`.
- **`replyEphemeral` restored to `normalizeOutboundText`.** The decomp inlined `text.trim() || "(empty response)"` in [src/discord/commands.ts](src/discord/commands.ts#L155) instead of importing the helper the original used. Exported `normalizeOutboundText` from [src/discord/send.ts:29](src/discord/send.ts#L29) and re-pointed `replyEphemeral` at it, so the empty-reply sentinel has one definition again.

### Skipped (deferred — touch code/tests outside the two-commit diff)

- **`webMessageId()` duplicates `messageId()`.** [src/discord/turn.ts:31](src/discord/turn.ts#L31) returns `msg_${uuid}`, identical to [src/web/ids.ts:12](src/web/ids.ts#L12) `messageId()` default. Cleanest fix is a shared `src/ids.ts`; folding turn.ts into `../web/ids.js` would be a discord→web layer crossing. Defer to a dedicated id-module consolidation.
- **`parseAgentReply` name collision.** [src/silent-marker.ts:7](src/silent-marker.ts#L7) exports a raw `parseAgentReply` (no normalization); [src/discord/send.ts:67](src/discord/send.ts#L67) exports a *normalizing* wrapper of the same name. `discord/turn.ts` imports the normalizing one; `web.ts` imports the raw one from silent-marker. Same name, different semantics, different paths — a future consolidator could silently route web through the normalizing variant and start leaking `(empty response)` placeholders into the web UI. Renaming touches the web.ts caller path outside this diff. Defer; rename the send.ts wrapper (e.g. `parseOutboundReply`) when next touching that area.
- **`__test` / `__webTest` re-export objects now redundant.** [src/discord.ts:94](src/discord.ts#L94) (`buildRawFiles`, `postDiscordAttachments`) and [src/web.ts:859](src/web.ts#L859) (`memeCatalogPath`, `parseMemeCatalog`, `webHistoryPayload`, `webMessagesFromRecords`) — every member is now an independent export of its real module. `test/discord-attachments.test.ts` and `test/web-{memes,history}.test.ts` reach them via the umbrella objects; the web tests for auth/static/events already import submodules directly. Removing the seams means updating those test imports — outside the diff. Defer to a test-import cleanup.
- **`sendReply` / `sendChannelMessage` near-duplicate pipeline (altitude).** [src/discord/send.ts:73](src/discord/send.ts#L73) and [src/discord/send.ts:111](src/discord/send.ts#L111) share ~25 lines of normalize→chunk→burst-delay loop→append-attachments, differing only in the reply-mode first chunk. A `sendChunked(..., { firstChunkReply? })` helper would collapse both to thin wrappers. Larger refactor than the decomp's scope (overlaps MED #46); defer.

### Out of scope (pre-existing — verified byte-identical to `1c62758^`)

Finder angles surfaced these in the moved code, but `git show 1c62758^:…` confirms each predates the refactor, so they're not introduced by these commits:

- `src/web/multipart.ts` `raw.toString("binary")` round-trip + `String.split` on boundary (overlaps existing MED #63).
- `src/discord/chunking.ts` `splitLongBlock` UTF-16 fallback can split surrogate pairs; `chunkDiscordParagraph` `normalized.slice(0, limit)` final fallback truncates; `chunkDiscordNewline` returns `[]` for empty input while simple/paragraph return the `(empty response)` fallback.
- `src/discord/send.ts` `sendReply` first-chunk `try` also catches its own `!isSendable()` throw, then re-checks below (mislabeled log).
- `src/web/messages.ts` `ensureFallbackSteps` admits `thinkingMs === 0` via `!= null`.
- `readJsonBody` `JSON.parse` without try/catch (in `src/web/http.ts`, not touched by these commits).

