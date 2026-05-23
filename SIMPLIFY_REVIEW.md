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

### Frontend

22. [web/src/lib/useChat.ts:137-143](web/src/lib/useChat.ts#L137-L143) — `delta` handler rebuilds the entire messages array per token, bypassing `upsertMessage`. Use the existing helper.
23. [web/src/lib/useChat.ts:237-322](web/src/lib/useChat.ts#L237-L322) — Session-change effect depends on `handleEvent`, whose identity changes with `activeSessionKey`, tearing down/reconnecting the WebSocket. Stash in a ref.

### God modules (Codex framing)

24. **[Codex]** Decompose along ownership boundaries: [src/discord.ts:938](src/discord.ts#L938), [src/web.ts:421](src/web.ts#L421), [src/web-tools.ts:1](src/web-tools.ts#L1), [src/memory/lcm/store.ts:125](src/memory/lcm/store.ts#L125), [src/config.ts:574](src/config.ts#L574), [src/agent.ts:121](src/agent.ts#L121). Not immediate typecheck failures, but where future regressions accumulate. (Item #17 is the first slice of discord.ts; #28-30 below address web.ts/web-tools.ts/config.ts.)

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
36. **Insert-then-re-read N+1** in LCM: [backfill.ts:127](src/memory/lcm/backfill.ts#L127), [indexer.ts:45](src/memory/lcm/indexer.ts#L45), [context-transformer.ts:395-396](src/memory/lcm/context-transformer.ts#L395-L396) — have `insertRecord` return the `StoredLcmRecord`.

### Backend hot-path inefficiencies

37. [src/runtime.ts:276-290](src/runtime.ts#L276-L290) — `getLastQueuedTriggerRecordId` / `getLastCompletedTriggerRecordId` scan full records array per inbound message. Maintain counters in `appendRecord`.
38. [src/runtime.ts:443-461](src/runtime.ts#L443-L461) — `buildPrompt` and `buildPromptAttachments` filter the same slice twice.
39. [src/runtime.ts:128](src/runtime.ts#L128) — `records: ChatLogRecord[]` grows unbounded per channel. Bound by reset or sliding window.
40. [src/web-static.ts:32-48](src/web-static.ts#L32-L48) — Per-request `existsSync(distDir)` + uncached `realpath(root)` for each attempt; cache at startup.
41. [src/web-static.ts:56-92](src/web-static.ts#L56-L92) — `serveAttachment` does ~9 syscalls per miss.
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
60. [src/inbound-attachments.ts:226-258](src/inbound-attachments.ts#L226-L258) — Derived attachment files aren't tracked in `writtenPaths`; partial failure leaks them. (See HIGH #5 for the Codex framing.)
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

76. `withEnv` / `withoutEnv` / `withDiscordToken` boilerplate appears in 8+ test files (`agent-reload`, `config`, `discord-attachments`, `image-gen`, `inbound-attachments`, `runtime`, `skills`, `tts`); consolidate in [test/helpers.ts](test/helpers.ts).
77. PNG/MP4 fixture bytes duplicated between [test/image-gen.test.ts](test/image-gen.test.ts) and [test/inbound-attachments.test.ts](test/inbound-attachments.test.ts).
78. `FakeEmbeddingProvider` cloned across 8+ memory tests (chunk-indexer, diary-chunks, diary-indexer, lcm-indexer, memory-backfill, memory-doctor, memory-tools, memory-index-store). Vector strategies are interchangeable for the assertions actually performed.
79. `FakeStore`/`FakeRetrievalStore` + `hit()` factory duplicated between `diary-ambient.test.ts:302-354` and `memory-retrieval.test.ts:391-437`.
80. `LcmSourceProvenance source` + `storedRecord()`/`record()` builder cloned 5× (eviction-score, lcm-condense, lcm-context, lcm-indexer, lcm-store).
81. `assistantMessage()` + `contentText()`/`renderMessages()` + `zeroUsage()` repeated in memory-service, lcm-context, lcm-condense.
82. 6 near-identical "debt" tests in [test/memory-service.test.ts:582-799](test/memory-service.test.ts#L582-L799) and 1109-1473 — parameterize.
83. `withEmbeddingFetch` used in ~25 places but bypassed in 2 (148-156, 212-219); fold them in and have it return `{ callCount }`.
84. `withMemoryService(config, fn)` / `withMemoryRuntime(config, fn)` harness would remove ~400 lines and 8 copies of `try/finally service.close()` from memory-service.test.ts.
85. [test/memory-service.test.ts](test/memory-service.test.ts) — ~30 tests reopen `LcmStore` mid-test (e.g. lines 261-271, 303-318) when `service.lcmStore` is already exposed. Gratuitous SQLite churn.
86. [test/cli.test.ts](test/cli.test.ts) — Each `it` spawns `tsx src/cli.ts` via `execFile` — seconds per test, serial.
87. [test/generated-media.test.ts:24-49](test/generated-media.test.ts#L24-L49) — Two byte-identical tests; delete one.

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
2. **Web correctness bugs (HIGH #13-16)** — TTL bug, WebSocket race, message-state leaks, cookie DoS. Small fixes, real impact.
3. **Memory hot-path fixes (HIGH #6-12)** — these run per turn; biggest perf wins. Worth a focused branch.
4. **Test hygiene — tmp-dir cleanup sweep (HIGH #18-21)** — easy, large blast radius, will reveal latent flakiness.
5. **Shared utilities sweep (MED #25-36)** — one PR creating `src/util/guards.ts`, `src/util/fs.ts`, `src/memory/util.ts`, plus the `createWriteQueue` + `atomicWriteJson` + `readEnum` helpers. Cascades into every other simplification.
6. **God-module decomposition (HIGH #17, #24)** — start with the `runAgentTurn` extraction in `discord.ts` since it's the most concentrated triplicate.
7. **Test helpers consolidation (MED #76-87)** — extract once, ripple through.
8. **Frontend hooks consolidation (HIGH #22-23, MED #69-75)** — meaningful for re-render perf.

Suggest small, scoped commits per category with regression testing after each — not one mega-PR.
