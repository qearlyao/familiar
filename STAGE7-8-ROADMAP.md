# Stage 7-8 Roadmap: LCM, Diary, and Ambient Recall

This roadmap captures the current implementation decisions for Stage 7 and
Stage 8. `PLAN.md` remains the high-level product roadmap; this file is the
working map for memory/index development.

## Goal

Build one shared indexing/retrieval foundation, then keep LCM and diary memory
as separate semantic layers.

- LCM is the factual conversation layer: raw-ish normalized turns, summaries,
  provenance, and what was said or done.
- Diary is the private affective layer. Its voice, format, and reflection rules
  are owned by Stage 9 heartbeat instructions, not hardcoded in the index layer.
- `INNER.md` is not a search corpus in v0. It is short, stable, and loaded in
  the cached prefix as the agent's current carried interior.
- Ambient recall is diary-first. LCM should not be automatically injected as
  private companion memory.

## Key Decisions

- Use a Familiar-owned internal service/module, not a dynamic plugin system yet.
- Port reusable patterns from `pi-lcm-memory`; do not import it as a Pi extension.
- Use shared index primitives for both Stage 7 and Stage 8:
  - embedding provider
  - vector store
  - FTS store
  - chunk indexer
  - diagnostics / reindex support
- Keep LCM and diary as separate modules with separate schemas/corpora/scopes.
- Remote embeddings are the primary path. Local Transformers.js worker support
  can be added later using `pi-lcm-memory` as the reference.
- Default embedding config uses Google Gemini embeddings. As of the checked
  docs, the default model is `gemini-embedding-2`, which supports multimodal
  embeddings. Operators can override the model name, provider, base URL, and API
  key env for gateways or preview models.
- Hybrid semantic recall replaces exact grep as the main memory search path.
  Exact grep remains useful for provenance/debugging.
- Do not build a separate regex-triggered auto-recall path in v0.
  Explicit "remember last time" requests should be handled by the agent choosing
  the recall tool.
- The v0 ambient path is always-on or lightly throttled diary recall:
  `similarity + valence + recency`.
- Primer can exist, but it should be optional, volatile, and companion-shaped.
  It should not repeat the tool menu; tool descriptions already live in the tool
  definitions.
- Store long-lived memory artifacts under workspace-root `memories/`, not under
  `data/`. `data/` remains runtime/audit/log storage.
- Include retention from the start. Chat/transcript logs, LCM normalized records,
  LCM summaries, and vector rows all need explicit prune/archive behavior.

## Proposed Module Shape

Working names; adjust to local style during implementation.

```text
src/memory/index/
  embedding-provider.ts   # remote embeddings by default, swappable
  vector-store.ts         # sqlite-vec wrapper / capability fallback
  fts-store.ts            # SQLite FTS5 wrapper
  chunk-indexer.ts        # generic re-embed-on-write/sweep helper
  schema.ts               # shared chunk/index tables if useful

src/memory/lcm/
  schema.ts               # normalized records, summaries, summary_sources
  normalize.ts            # chat/transcript -> normalized LCM stream
  summaries.ts            # summary DAG generation and provenance
  context.ts              # fresh-tail + summary transformContext assembly
  recall.ts               # factual memory search/rendering

src/memory/diary/
  schema.ts               # diary_chunks, atomic_facts
  chunks.ts               # markdown chunking + valence metadata
  ambient.ts              # diary-first ambient retrieval/rendering
  context.ts              # user-message-envelope injection
```

## Workspace Storage

Memory-owned state should live under the workspace root:

```text
memories/
  index/
    memory.sqlite          # shared index DB, or helper-owned DBs
  lcm/
    lcm.sqlite             # factual conversation source + summaries
    summaries/             # optional markdown exports/provenance views
  diaries/
    YYYY-MM-DD.md          # heartbeat-owned diary files
  archive/
    ...                    # optional cold storage after pruning
```

`data/` remains runtime/audit state:

- `data/chat/...` append-only channel/runtime logs. These drive WebUI history
  display and remain the transport/audit trail.
- `data/transcripts/...` agent transcript reconstruction logs. These are what
  the agent wrapper currently replays after process restart, up to the latest
  reset marker for that session.
- `data/payloads/...` provider payload logs. These are debug/inspection logs and
  should not affect conversation continuity.
- `data/attachments/...` runtime/generated attachments

The LCM normalizer may read `data/chat` and `data/transcripts`, but those files
are not the LCM source of truth after normalization.

## Shared Index Semantics

The shared index layer may store all indexed chunks in one physical DB, but
callers must query by corpus/scope.

Suggested corpus values:

- `lcm_record`: normalized factual conversation records.
- `lcm_summary`: factual summaries with provenance.
- `diary_chunk`: first-person diary excerpts.
- `atomic_fact`: small durable facts promoted from diary/conversation.

Important: physical reuse does not mean semantic merging. Each source gets its
own scoring boosts, filters, rendering, and injection policy.

## Stage 7: LCM Slice

Purpose: factual continuity and context-window survival.

Inputs:

- `data/chat/{channel}/{date}.jsonl` remains audit/provenance.
- `data/transcripts/*.jsonl` is a cleaner secondary reconstruction source.
- Build a normalized LCM stream/table under `memories/lcm/` before indexing.

Do not feed raw `data/chat` directly into LCM. Current logs contain a lot of
non-conversation noise: `agent_event`, `checkpoint`, `job_queued`,
`job_completed`, `runtime`, streaming/tool lifecycle records, and control
records.

Keep in normalized LCM:

- inbound user text and useful attachment notes
- outbound assistant text and useful attachment notes
- selected tool/result facts when useful
- reset/control boundaries
- timestamps, channel/session/job ids
- source pointers back to chat records/transcripts

LCM transformContext:

- Protect fresh tail.
- Automatically summarize the oldest compactable raw chunk outside the fresh
  tail when leaf/budget pressure requires it, then replace that raw chunk with
  the generated summary for subsequent turns.
- Use `lossless-claw` for architecture ideas: ordered context items, summary DAG,
  fresh-tail protection, prompt-aware eviction, deferred compaction debt,
  integrity/doctor concepts, and cache-aware timing.

LCM recall:

- Hybrid semantic recall is the main factual search path.
- Exact grep remains available for source/provenance/debug.
- For explicit factual memory requests, expose a recall tool and let the agent
  choose it.

LCM retention:

- Existing `data/chat` and `data/transcripts` have no broad automatic cleanup
  today; only generated attachments have a retention cleanup path.
- Add config-driven retention for runtime logs before they become large:
  archive or prune old `data/chat`, `data/transcripts`, and `data/payloads`.
  Do not short-prune `data/transcripts` until LCM or another state source fully
  replaces transcript replay after restart.
- Add LCM retention separately from runtime-log retention. LCM is not the
  long-term memory source; diary/INNER own long-term continuity.
- Prefer boundary-based LCM pruning over simple age-based pruning. The unit of
  LCM lifecycle is the segment between `/new` commands:
  - `/new` creates a new LCM segment.
  - `newSessionRetainDepth` follows the upstream meaning: context retained after
    `/new`; `-1` keeps all context, `0` drops raw messages but keeps all
    summaries, and positive values keep summaries at that depth or higher. For
    example, `2` keeps `d2+` summaries.
  - If `newSessionRetainDepth > 0`, carry only summaries with
    `summary.depth >= newSessionRetainDepth` across the `/new` boundary. Prune
    the older segment's raw normalized records and summaries below the retained
    depth.
  - If `newSessionRetainDepth === 0`, prune raw normalized records after `/new`
    but keep all summaries for that segment.
  - If `newSessionRetainDepth === -1`, keep all LCM context for the previous
    segment until another retention policy removes it.
  - On the second `/new`, summaries from the segment before the previous one are
    dropped unless still inside the configured retain depth or explicitly
    pinned.
  - Once raw records for a segment are pruned, tools can still find retained
    summaries, but they cannot expand back into exact original turns for that
    segment unless a cold archive is kept.
  - Delete matching FTS/vector rows transactionally so recall never returns
    missing items.
  - Run optional `VACUUM`/checkpoint on explicit cleanup, not every startup.
- Keep optional age-based pruning only as a backstop for abandoned/stale
  segments that never cross another `/new` boundary.
  Use `lossless-claw/src/prune.ts` as the reference for cascaded cleanup.

## Stage 8: Diary and Ambient Recall Slice

Purpose: companion continuity and felt memory.

Inputs:

- `memories/diaries/YYYY-MM-DD.md`
- future atomic facts derived from diary/conversation
- `INNER.md` as cached-prefix state, not normal vector recall

Diary semantics:

- Stage 9 owns the agent-facing diary instructions: voice, format, whether to
  write, and how reflective it should be.
- Stage 8 only assumes diary files are markdown documents that can be chunked,
  edited, and indexed.
- Empty or absent diary files must be valid. The indexer should not manufacture
  entries.
- Chunks may carry valence/emotional-intensity metadata when Stage 9 provides it.

Ambient recall:

- Diary-first.
- Inject into the volatile user-message envelope after the cache breakpoint.
- Initial v0 scoring: `similarity + valence + recency`.
- Keep top-K small, likely 3-5 excerpts.
- No separate regex-triggered auto-recall path in v0.

Manual recall:

- Provide a tool for active digging.
- Tool should support scopes, e.g. diary/factual/all, but default behavior should
  not blur private affective memory with factual transcript memory.

## Agent Tools and Operator Commands

All agent-visible memory tools should use the `memory_` prefix. Do not expose
`lcm_` tool names to the agent in Familiar v0.

V0 agent tools:

- `memory_recall`
  - Hybrid semantic/FTS recall.
  - Parameters include `query`, `scope` (`diary`, `factual`, `all`), `k`, time
    filters, and possibly `mode`.
  - Default scope should be context-sensitive but conservative. Ambient recall
    remains diary-first; explicit tool calls may use factual/all.
- `memory_open`
  - Open a returned memory item by id.
  - Handles diary chunks, normalized LCM records, summaries, and provenance.
  - Replaces most `describe`/`expand` needs in v0.

Possible later tools:

- `memory_similar`
  - "More like this" over an existing item id.
- `memory_expand`
  - Deeper summary-DAG expansion if `memory_open` is not enough.
  - Only worth adding when summary DAG compression makes deterministic opening
    too shallow.

Operator commands are separate from agent tools:

- `/memory status`
- `/memory reindex`
- `/memory prune`
- `/memory backup`
- `/memory settings` or config-file-only equivalent

Primer:

- Optional.
- More like a `/new` or fresh-session preface than stable identity.
- Can coexist with `INNER.md`.
- Should not include a duplicated tool menu.
- If implemented, inject as volatile context, not as a stable cached-prefix file.

## Implementation Order

1. Build shared index primitives first.
   - embedding provider interface
   - SQLite connection/migrations
   - FTS/vector capability fallback
   - chunk indexer with content-hash dedupe

2. Land the thin Stage 7 LCM slice.
   - normalized LCM source from chat/transcripts
   - automatic leaf summarization plus fresh-tail assembly
   - factual recall tool
   - provenance links back to source records

3. Land the thin Stage 8 diary slice.
   - diary markdown chunking
   - remote embedding indexing
   - diary-first ambient injection
   - manual diary recall scope

4. Add polish after the first end-to-end path works.
   - file watchers
   - reindex command
   - diagnostics/status
   - benchmark harness
   - optional primer
   - local embedding fallback

## Upstream Reference Strategy

### lossless-claw

Primary LCM architecture reference.

Use for:

- ordered context item model
- fresh-tail protection
- summary DAG metadata
- XML/markdown summary injection ideas
- prompt-aware eviction
- deferred compaction debt
- summary integrity/doctor concepts
- cache-aware timing

Do not use as a direct runtime dependency in v0. It is packaged as an OpenClaw
context-engine plugin and imports OpenClaw plugin-sdk contracts.

### pi-lcm-memory

Primary implementation reference for indexing/retrieval.

Use for:

- hook-plus-sweep indexer shape
- batched embeddings and batched SQLite writes
- content-hash dedupe
- many-to-one source-id mappings
- sqlite-vec soft-fail
- hybrid FTS/vector retrieval
- RRF merge
- diagnostics and benchmark discipline
- optional local Transformers.js worker reference

Do not use directly as a runtime package. Its entrypoint is a Pi extension,
assumes `pi-lcm` tables (`messages`, `summaries`, `messages_fts`), and injects
primer/auto-recall as extra system messages through Pi's context hook.

Relevant behavior:

- Primer scans prior `conversations` and recent depth>=1 summaries, renders a
  small `## Project memory` block, and injects it once on first context hook.
- Heuristic auto-recall is regex-triggered, not LLM-triggered. It matches terms
  like "remember", "earlier", "previously", "like last time", then runs hybrid
  recall and injects a `## Recall` system block for the current turn.
- Familiar v0 should not copy that auto-recall injection path. Ambient diary
  recall is the preferred path.

## LCM Architecture Comparison

### lossless-claw

Best reference for the LCM engine itself.

What it owns:

- `conversations`, `messages`, structured `message_parts`
- `summaries`, source links, parent links, and summary DAG metadata
- `context_items`, the ordered persisted model-visible window
- fresh-tail protection and budgeted context assembly
- prompt-aware eviction
- session bootstrap/reconciliation from host transcript files
- pruning/doctor/backup/maintenance concepts
- large-file externalization
- expansion tools for drilling from summaries back to source material

Why it matters:

- It is the mature implementation for "what should the LCM source and assembly
  model look like?"
- It has explicit retention/prune machinery.
- It has guardrails for `/new`, session bootstrap, context assembly, cache-aware
  deferral, and overflow recovery.

Risk:

- It is OpenClaw-specific and more complex than Familiar v0 needs.
- If OpenClaw previously injected full context after `/new` or gateway restart,
  that may have been host integration/bootstrap behavior rather than the desired
  LCM architecture. Familiar should copy the invariants, not the whole runtime
  integration.

### pi-lcm

Useful lightweight Pi reference, but less complete than `lossless-claw`.

What it owns:

- Pi extension lifecycle
- messages/summaries/summary_sources
- basic FTS
- DAG compaction via Pi's `session_before_compact`
- static LCM system preamble
- `lcm_grep`, `lcm_describe`, `lcm_expand`

Limitations for Familiar:

- No `context_items` model like `lossless-claw`.
- Retains messages/summaries indefinitely unless external cleanup is added.
- Its summary injection is tied to Pi's compaction entry rather than Familiar's
  desired `Agent.transformContext` assembly.

### pi-lcm-memory

Best reference for the vector/index/retrieval layer, not for LCM source
architecture.

What it owns:

- additive vector/index tables over pi-lcm's existing LCM DB
- hook-plus-sweep indexing
- batched embedding and SQLite writes
- hybrid FTS/vector retrieval
- RRF merge
- primer and regex-triggered auto-recall

Limitations for Familiar:

- It assumes `pi-lcm` already owns messages/summaries/FTS.
- It does not define the factual LCM source lifecycle, summary DAG assembly, or
  retention policy.

Decision:

- Use `lossless-claw` as the primary reference for LCM data model, compaction,
  context assembly, retention, and `/new`/restart invariants.
- Use `pi-lcm-memory` as the primary reference for shared indexing, vector
  retrieval, batching, diagnostics, and optional primer mechanics.
- Do not switch the LCM architecture center of gravity to `pi-lcm-memory`,
  because it is a memory/index layer on top of an LCM, not the LCM itself.

## File Reference Index

Local Familiar files:

- `PLAN.md`
  - Stage 7 and Stage 8 high-level roadmap.
  - Reference Index in section 6.
- `src/agent.ts`
  - direct upstream `Agent` wrapper
  - transcript/payload logging
  - future `transformContext` integration point
- `src/chat-log.ts`
  - append-only chat record types and layout
  - current noisy audit log source
- `src/runtime.ts`
  - conversation runtime, control parser, reset boundaries
- `src/config.ts`
  - future memory/index/embedding config shape
- `src/models.ts`
  - provider/base-url/api-key mapping patterns

Local data refs:

- `~/.familiar/data/chat`
  - noisy audit/provenance logs; do not index directly.
- `~/.familiar/data/transcripts`
  - cleaner AgentMessage reconstruction source; lacks full channel/job
    provenance on its own.
- workspace-root `memories/`
  - future durable memory root; keep out of `data/`.

Upstream Pi refs:

- `/Users/qearl/pi-mono/packages/agent/src/agent.ts`
  - `Agent` state/options, direct runtime integration.
- `/Users/qearl/pi-mono/packages/agent/src/agent-loop.ts`
  - `transformContext` call site.
- `/Users/qearl/pi-mono/packages/agent/src/types.ts`
  - `AgentMessage`, tool shape, events.
- `/tmp/pi-chat/src/core/runtime-types.ts`
  - chat runtime/log type reference.
- `/tmp/pi-chat/src/runtime.ts`
  - trigger slicing and runtime state machine.
- `/tmp/pi-chat/src/log.ts`
  - append JSONL, locks, timestamps.

Research clones:

- `/private/tmp/familiar-research/lossless-claw`
  - primary LCM architecture reference.
- `/private/tmp/familiar-research/pi-lcm`
  - original Pi LCM extension reference.
- `/private/tmp/familiar-research/pi-lcm-memory`
  - primary indexing/retrieval implementation reference.

High-value `lossless-claw` files:

- `/private/tmp/familiar-research/lossless-claw/docs/architecture.md`
  - LCM data model, summary DAG, context assembly, expansion, reconciliation.
- `/private/tmp/familiar-research/lossless-claw/src/assembler.ts`
  - ordered context item assembly, fresh tail, budget selection, prompt-aware
    eviction, structured message reconstruction.
- `/private/tmp/familiar-research/lossless-claw/src/engine.ts`
  - lifecycle, ingest/bootstrap/maintain/compact orchestration, cache-aware
    compaction policies, transcript GC hooks.
- `/private/tmp/familiar-research/lossless-claw/src/compaction.ts`
  - leaf/condensed compaction behavior and summary generation.
- `/private/tmp/familiar-research/lossless-claw/src/store/conversation-store.ts`
  - conversations, messages, message parts.
- `/private/tmp/familiar-research/lossless-claw/src/store/summary-store.ts`
  - summaries, parents, sources, context items.
- `/private/tmp/familiar-research/lossless-claw/src/prune.ts`
  - age-based conversation pruning and cascaded cleanup.
- `/private/tmp/familiar-research/lossless-claw/src/retrieval.ts`
  - factual retrieval over messages/summaries and describe/expand foundations.
- `/private/tmp/familiar-research/lossless-claw/src/plugin/index.ts`
  - plugin wiring, prompt policy, tool registration, OpenClaw lifecycle bridge.
- `/private/tmp/familiar-research/lossless-claw/src/plugin/lcm-command.ts`
  - operator command patterns: status, backup, rotate, doctor/clean.

High-value `pi-lcm-memory` files:

- `/private/tmp/familiar-research/pi-lcm-memory/index.ts`
  - extension lifecycle, context hook injection, tool registration.
- `/private/tmp/familiar-research/pi-lcm-memory/src/db/schema.ts`
  - vector/index/meta schema and dimension/model reconciliation.
- `/private/tmp/familiar-research/pi-lcm-memory/src/db/store.ts`
  - batched writes, content-hash dedupe, id mappings, kNN.
- `/private/tmp/familiar-research/pi-lcm-memory/src/db/vec.ts`
  - sqlite-vec dynamic load and soft-fail.
- `/private/tmp/familiar-research/pi-lcm-memory/src/indexer.ts`
  - hook-plus-sweep indexer, batching, backoff, event-loop yielding.
- `/private/tmp/familiar-research/pi-lcm-memory/src/retrieval.ts`
  - hybrid FTS/vector retrieval and RRF merge.
- `/private/tmp/familiar-research/pi-lcm-memory/src/bridge.ts`
  - Pi-specific read bridge to replace with Familiar source adapters.
- `/private/tmp/familiar-research/pi-lcm-memory/src/embeddings/embedder.ts`
  - local worker-thread embedder controller.
- `/private/tmp/familiar-research/pi-lcm-memory/src/embeddings/worker.mjs`
  - Transformers.js worker implementation.
- `/private/tmp/familiar-research/pi-lcm-memory/src/primer.ts`
  - first-turn primer behavior.
- `/private/tmp/familiar-research/pi-lcm-memory/src/auto-recall.ts`
  - regex-triggered recall behavior.
- `/private/tmp/familiar-research/pi-lcm-memory/bench/results/perf.latest.md`
  - current benchmark snapshot.
- `/private/tmp/familiar-research/pi-lcm-memory/ROADMAP.md`
  - stabilization history and reranker postmortem.

## TODOs From Recent Stage 7-8 Review

Recent thin-slice fixes handled FTS query sanitization, semantic-to-lexical
fallback, LCM segment restart continuity (segment counter only —
compressed-conversation continuity is still unwired), shared-index cleanup after
LCM retention with startup reconciliation, runtime-summary LCM provenance,
contentless FTS tables, many-to-one shared-index source mapping, and direct
dependency declaration for `typebox`.

### Correctness bugs surfaced during the 9-commit review

These are not greenfield TODOs — they are invariant breaks in code that already
shipped. Fix before adding more surface area.

- [x] Persist runtime summary provenance for real: today
  `service.ts` writes `summary_sources.record_id = NULL` and
  `lcm_summaries.covers_from_record_id / covers_to_record_id = NULL` because
  the summarizer hashes an in-memory `AgentMessage` fingerprint instead of
  resolving back to the LCM record id. Expansion (summary → source) is
  impossible until this is wired through `projectNormalizedLcmBatch`/
  `insertRecord` and the summarizer call site.
- [x] Wrap `/new` rotation in a single LCM transaction:
  `closeSegment` → `nextSegmentId` → `ensureSegment` → `applyNewSessionRetention`
  currently span four uncoordinated steps. Coordinate the shared-index delete
  with the LCM transaction (collect index deletes, apply after both succeed)
  or add a startup reconciliation sweep that drops `lcm_record:*` /
  `lcm_summary:*` index rows with no backing row.
- [x] Fix the FTS5 external-content desync in both index DBs: schemas declare
  `content='memory_chunks'` / `content='lcm_records'` etc. but writes are
  manual and text is double-stored inside the FTS table. Either install
  `AFTER INSERT/UPDATE/DELETE` triggers on the base table or switch the FTS
  tables to contentless (`content=''`). Today an UPDATE on `text_full` or any
  cascade-delete from `lcm_segments` silently desyncs FTS.
- [x] Sanitize FTS queries in `lcm/store.ts:searchRecordsLexical` the same way the
  shared index does — currently apostrophes/colons/quotes in user queries
  throw `fts5: syntax error`.
- [x] Stop indexing boundary records into FTS: `kind='boundary'` rows insert the
  literal text "Session boundary", polluting lexical recall over time. Either
  skip the FTS write for boundary kind or filter it out in lexical search.
- [x] Make `content_hash` content-identity, not row-identity:
  `index/store.ts:normalizeInput` and `chunk-indexer.ts:prepare` currently
  fold `sourceId` (and `chunkIndex`) into the hash, so the planned many-to-one
  dedupe table can never fire and a real content collision silently drops the
  second `source_id`. Either rename the column to `row_key` and document the
  intent, or remove `sourceId` from the hash inputs and land the many-to-one
  side table at the same time.
- [x] Open `MemoryIndexStore` and `EmbeddingProvider` once on service startup,
  not on every `memory_recall` / `memory_open` call. Inject them into
  `createMemoryTools` instead of constructing per-execute.
- [x] Stable `AgentMessage` fingerprint independent of array index: today
  `context.ts:createAgentMessageFingerprint` hashes `index` into the id, so
  any upstream reorder or truncation changes every downstream id and
  invalidates `syncContextState`. Hash (role, timestamp, content) instead.
- [x] Move `ensureSegment` inside the `insertRecord` transaction so a failed
  record insert cannot leave an orphan empty segment.
- [x] Cascade-delete `lcm_summary_sources` rows when their parent summary is
  pruned, or enable `PRAGMA foreign_keys = ON` and add `ON DELETE CASCADE`.
  Today retention leaves zombie rows pointing at vanished summary ids.
- [x] Fix RRF rank assignment under corpus fan-out in `index/retrieval.ts:
  mergeRankedHits` — current code concatenates per-corpus hit arrays and
  assigns ranks sequentially across the concatenation, systematically biasing
  RRF against later corpora. Rank per corpus, then merge.
- [x] Add the roadmap-required `time filter` and `mode` parameters to
  `memory_recall`'s tool schema (or document why they were dropped). The
  retrieval layer already supports `useLexical`/`useSemantic` — surface as
  `mode: lexical|semantic|hybrid`.

### Remaining migration TODOs

- Add persisted ordered LCM context items with ordinals, then make live
  compaction replace raw/summary ranges in that table instead of only in the
  in-memory `transformContext` state.
- Rehydrate `transformContext` from persisted LCM context items and retained
  summaries after daemon restart, so transcript replay is no longer the only
  continuity source for compressed long conversations. The recent
  segment-restart fix covers segment numbering only; compressed long
  conversations still rebuild solely from transcript replay.
- Add a `summary_parents` table (or equivalent edge table) so condensed
  summary passes can traverse the DAG. Today only `summary_sources` edges
  exist; there is no explicit parent linkage between summaries.
- Add condensed summary passes and depth promotion, not just leaf summaries.
  Today `persistRuntimeSummary` hardcodes `depth: 1`.
- [x] Add structured message reconstruction/sanitization around tool calls, tool
  results, and reasoning blocks before LCM summary generation and context
  assembly. Today `normalize.ts` drops tool records entirely and
  `lcmRecordToAgentMessage` only emits `user`/`assistant` text.
- Add prompt-aware eviction and budget selection from `lossless-claw` once the
  ordered context model exists.
- Add deferred compaction debt, cache-aware compaction timing, and compaction
  telemetry so prompt-mutating work can be delayed or retried safely.
- Add LCM integrity/doctor/clean checks for dangling summary sources, stale
  shared-index rows, broken context ordering, missing source records, and
  orphan empty segments.
- Add startup/backfill sweep over existing `data/chat` and `data/transcripts`,
  plus a transcript source adapter for normalized LCM ingestion. Pair with
  event-loop yielding (1024-row chunks) so backfill cannot starve Discord/HTTP
  loops.
- Add config-driven retention/archive for `data/chat`, `data/transcripts`, and
  `data/payloads`; keep transcript pruning conservative until LCM can fully
  replace replay after restart.
- Add an optional age-based LCM segment backstop
  (`memory.lcm.segment_max_age_days`) for segments that never cross another
  `/new` boundary.
- Add operator memory commands or CLI equivalents: status, reindex, prune,
  backup, doctor/clean, and relevant diagnostics. Agent-facing
  `memory_recall` / `memory_open` exist; no operator surface does.
- Add sqlite-vec dynamic loading and soft-fail behavior; keep the current
  linear BLOB scan as fallback when sqlite-vec is unavailable. Expose a real
  capability probe so `stats().vectorAvailable` and `meta.vector_capability`
  stop lying.
- [x] Add many-to-one source mappings for content-hash dedupe so identical
  chunks can share one embedding while retaining every source id. Landed
  together with the `content_hash` fix via `memory_index_sources` table.
- Add a reindex-from-source registry so embedding-model or dimension changes
  can repopulate the index automatically instead of permanently wiping
  content the operator must re-feed.
- Cascade-delete shared-index rows when their LCM record or diary chunk is
  deleted (today the wiring runs only inside the retention path; ad-hoc
  deletes leak rows).
- Add `memory_similar` or deeper `memory_open`/expand behavior once summary DAG
  compression needs deterministic drill-down. `memory_open` today returns
  only the immediate chunk row; for summaries it should follow
  `summary_sources` back to the underlying records.
- Generalize `memory.embedding.api` beyond the locked `"gemini"` enum (or
  rename to `embedding.format`) and document the wire-protocol contract in
  `config.example.toml`.
- Expose ambient diary recall tuning knobs (top-K, valence/recency/intensity
  weights, throttle interval, minimum-query-length gate) rather than the
  hardcoded `limit = 3` and unconditional fire on every non-empty user turn.
- Document the cache-boundary contract for ambient injection: ambient text
  mutates only the current user turn, never the assistant tail that
  upstream caches up to. Add an explicit assertion or sentinel.
- [x] Decompose `MemoryService` (511 lines) into `LcmSegmentManager`,
  `LcmContextTransformer`, and `AmbientDiaryInjector`. Today the runtime
  subscription, segment lifecycle, transformContext orchestration, and
  ambient injection share one class and one ad-hoc projection queue.
- [x] Either wire `assembleLcmContext` / `selectRetainedSummaries` /
  `selectFreshTailRecords` (`lcm/context.ts`) into the real
  `transformContext` path or delete them. Today the runtime ignores them and
  operates directly over `state.items`; the dead code is a maintenance trap.
  (Partially done: `assembleLcmContext` and `renderLcmSummaryContext` are
  gone, but `detectLcmCompactionPressure` is a new orphan — defined and
  unit-tested in `lcm/context.ts` but never called from the real
  `LcmContextTransformer` flow. Wire it as the actual compaction-trigger
  signal or delete it on a follow-up pass.)
- [x] Default `memory_recall.scope` should be `factual`, not `all`. Roadmap calls
  for "context-sensitive but conservative" and the current default leaks
  diary into provenance-style queries.
- Snapshot summary content into `lcm_summaries.snapshot_json` (column exists,
  nothing populates it) at retention time so summaries remain meaningful
  after raw records are pruned. Today `covers_from_record_id` /
  `covers_to_record_id` are nulled by `ON DELETE SET NULL`, losing range
  provenance permanently.
- Plumb the `vacuum` flag of `applyNewSessionRetention` to an opt-in operator
  command; do not run on every `/new`. Index growth on prune is currently
  unbounded because vacuum is always `false`.
- Add FTS prefix matching (`lantern*` form) for recall — current sanitizer
  strips `*` so "lanterns" never matches "lantern".
- Add basic timing/structured-log hooks at indexer batch boundaries; the
  current pipeline is silent and hard to debug for embedding throughput.
- Add diagnostic visibility for the projection-queue failure path (repeat
  rejection counts, last error). Today failures are swallowed into a chained
  `.catch` that only flush callers can observe.
- Cover positive-depth retention end-to-end in tests
  (`newSessionRetainDepth >= 1` keeps `d>=N` and prunes lower); today only
  `-1` and `0` paths are exercised.
- Handle empty/missing diary directories gracefully in `indexAllDiaryFiles`;
  today `readdir` throws ENOENT on misconfigured workspaces.
- Document or fix the `agent.cacheRetention` camelCase TOML key — every other
  key in `config.example.toml` is snake-case.

## Open Questions

- Exact DB layout: one shared physical DB with corpus-scoped tables, or separate
  LCM/diary tables sharing common helper code.
- Whether to pin the default embedding model to official `gemini-embedding-2`
  or a preview alias if Google exposes one through the configured endpoint.
- Whether primer ships in v0 or waits until ambient diary recall feels right.
- Final user-facing wording for factual memory blocks and tool results, since
  agent tools use `memory_` names even when the backing corpus is LCM.
