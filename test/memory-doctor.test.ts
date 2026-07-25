import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { configWithDataDir } from "./helpers.js";
import { FakeEmbeddingProvider } from "./memory-fakes.js";
import { applyDoctorFixes, runDoctor } from "../src/memory/doctor.js";
import { LCM_RECORD_CORPUS } from "../src/memory/lcm/indexer.js";
import { lcmRecordIndexSourceId } from "../src/memory/lcm/store.js";
import { MemoryService } from "../src/memory/service.js";
import { __memoryOperatorTest } from "../src/memory/operator.js";

async function tempConfig(t: { after(fn: () => Promise<void>): void }, batchSize = 8) {
	const dataDir = await mkdtemp(resolve(tmpdir(), "familiar-memory-doctor-"));
	t.after(() => rm(dataDir, { recursive: true, force: true }));
	return configWithDataDir(t, dataDir, {
		memory: {
			embedding: {
				format: "gemini",
				provider: "fake",
				model: "fake-embedding",
				baseUrl: "https://embedding.test",
				dimensions: 3,
				apiKeyEnv: "",
				batchSize,
			},
		},
	});
}

function source(id: string | number) {
	return { sourceType: "manual" as const, sourceRecordId: id, sourceRef: `manual:${id}` };
}

function insertRecord(service: ReturnType<typeof MemoryService.createWithoutRuntime>, segmentId: string, text: string): number {
	return service.lcmStore.insertRecord({
		segmentId,
		kind: "user",
		text,
		happenedAt: "2026-05-10T01:00:00.000Z",
		source: source(text),
	});
}

function indexChunk(service: ReturnType<typeof MemoryService.createWithoutRuntime>, corpus: string, sourceId: string): number {
	return service.memoryStore.insertChunk({
		corpus,
		sourceId,
		text: `${corpus} ${sourceId}`,
		embedding: new Float32Array([1, 2, 3]),
	});
}

describe("memory doctor and operator", () => {
	it("status output is well-formed as JSON", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			const recordId = insertRecord(service, "seg-status", "status record");
			service.lcmStore.insertSummary({
				segmentId: "seg-status",
				depth: 1,
				status: "ready",
				text: "status summary",
				coversFromRecordId: recordId,
				coversToRecordId: recordId,
				source: source("summary"),
			});
			indexChunk(service, LCM_RECORD_CORPUS, lcmRecordIndexSourceId(recordId));

			const status = __memoryOperatorTest.collectStatus(config, service);
			const parsed = JSON.parse(JSON.stringify(status)) as typeof status;
			assert.equal(parsed.counts.lcmRecords, 1);
			assert.equal(parsed.counts.lcmSummariesByDepth["1"], 1);
			assert.equal(parsed.counts.memoryChunksByCorpus.lcm_record, 1);
			assert.equal(parsed.embedding.model, "fake-embedding");
		} finally {
			service.close();
		}
	});

	it("detects each requested finding type", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			const staleChunkId = indexChunk(service, LCM_RECORD_CORPUS, "lcm_record:999999");
			service.memoryStore.db.pragma("foreign_keys = OFF");
			service.memoryStore.db
				.prepare("INSERT INTO memory_index_sources(chunk_id, corpus, source_id, chunk_index) VALUES (?, ?, ?, ?)")
				.run(999_999, "diary_chunk", "missing.md", 0);
			service.memoryStore.db.pragma("foreign_keys = ON");

			service.lcmStore.ensureSegment({ id: "seg-empty", startedAt: "2026-05-10T02:00:00.000Z" });
			service.lcmStore.closeSegment("seg-empty");

			const live = insertRecord(service, "seg-context", "context record");
			const summaryId = service.lcmStore.insertSummary({
				segmentId: "seg-context",
				depth: 1,
				status: "ready",
				text: "summary without snapshot",
				source: source("missing-snapshot"),
			});
			service.lcmStore.db
				.prepare(
					`INSERT INTO lcm_context_items(session_key, ordinal, summary_id, fingerprint, happened_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run("session-a", 1, summaryId, "a", "2026-05-10T01:00:00.000Z");
			service.lcmStore.db
				.prepare(
					`INSERT INTO lcm_context_items(session_key, ordinal, summary_id, fingerprint, happened_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run("session-a", 3, summaryId, "b", "2026-05-10T01:01:00.000Z");

			service.memoryStore.db
				.prepare("UPDATE memory_chunks SET embedding_dimensions = ? WHERE id = ?")
				.run(2, staleChunkId);

			const kinds = runDoctor({ lcm: service.lcmStore, index: service.memoryStore }).findings.map(
				(finding) => finding.kind,
			);
			assert.ok(kinds.includes("dangling_index_source"));
			assert.ok(kinds.includes("orphan_empty_segment"));
			assert.ok(kinds.includes("stale_lcm_index_source"));
			assert.ok(kinds.includes("broken_context_ordering"));
			assert.ok(kinds.includes("missing_pruned_summary_snapshot"));
			assert.ok(kinds.includes("embedding_mismatch"));
		} finally {
			service.close();
		}
	});

	it("cleans fixable findings without deleting LCM rows", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			const recordId = insertRecord(service, "seg-clean", "record to keep");
			const summaryId = service.lcmStore.insertSummary({
				segmentId: "seg-clean",
				depth: 1,
				status: "ready",
				text: "summary to keep",
				coversFromRecordId: recordId,
				coversToRecordId: recordId,
				source: source("summary-to-keep"),
			});
			indexChunk(service, LCM_RECORD_CORPUS, "lcm_record:999999");
			service.memoryStore.db.pragma("foreign_keys = OFF");
			service.memoryStore.db
				.prepare("INSERT INTO memory_index_sources(chunk_id, corpus, source_id, chunk_index) VALUES (?, ?, ?, ?)")
				.run(123_456, "diary_chunk", "missing.md", 0);
			service.memoryStore.db.pragma("foreign_keys = ON");
			service.lcmStore.ensureSegment({ id: "seg-empty" });
			service.lcmStore.closeSegment("seg-empty");
			service.lcmStore.db
				.prepare(
					`INSERT INTO lcm_context_items(session_key, ordinal, summary_id, fingerprint, happened_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run("session-clean", 2, summaryId, "fp", "2026-05-10T01:00:00.000Z");

			const report = runDoctor({ lcm: service.lcmStore, index: service.memoryStore });
			const result = applyDoctorFixes({ lcm: service.lcmStore, index: service.memoryStore }, report);
			assert.ok(result.fixed >= 3);
			const after = runDoctor({ lcm: service.lcmStore, index: service.memoryStore }).findings.filter(
				(finding) => finding.fixable,
			);
			assert.deepEqual(after, []);
			assert.equal(service.lcmStore.getRecord(recordId)?.text, "record to keep");
		} finally {
			service.close();
		}
	});

	it("reindexes LCM records", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			for (let index = 0; index < 5; index++) insertRecord(service, "seg-reindex", `record ${index}`);

			await __memoryOperatorTest.reindex(config, service, { corpus: "lcm_record", force: false }, new FakeEmbeddingProvider());

			const rows = service.memoryStore.db
				.prepare("SELECT corpus, embedding_model FROM memory_chunks ORDER BY id")
				.all() as Array<{ corpus: string; embedding_model: string }>;
			assert.equal(rows.length, 5);
			assert.ok(rows.every((row) => row.corpus === "lcm_record"));
			assert.ok(rows.every((row) => row.embedding_model === "fake-embedding"));
		} finally {
			service.close();
		}
	});

	it("clears requires_reindex only after a successful full forced reindex", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			insertRecord(service, "seg-reindex-flag", "record to reindex");
			service.memoryStore.db
				.prepare("INSERT OR REPLACE INTO memory_meta(k, v) VALUES ('requires_reindex', '1')")
				.run();
			await __memoryOperatorTest.reindex(
				config,
				service,
				{ corpus: "lcm_record", force: true },
				new FakeEmbeddingProvider(),
			);
			assert.equal(service.memoryStore.stats().requiresReindex, true);

			const failingProvider = new FakeEmbeddingProvider();
			failingProvider.embed = async () => {
				throw new Error("embedding failed");
			};
			await assert.rejects(
				__memoryOperatorTest.reindex(config, service, { force: true }, failingProvider),
				/embedding failed/,
			);
			assert.equal(service.memoryStore.stats().requiresReindex, true);

			await __memoryOperatorTest.reindex(config, service, { force: true }, new FakeEmbeddingProvider());
			assert.equal(service.memoryStore.stats().requiresReindex, false);
		} finally {
			service.close();
		}
	});

	it("resumes an interrupted reindex generation and restarts the next completed generation", async (t) => {
		const config = await tempConfig(t, 2);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			for (let index = 0; index < 5; index++) insertRecord(service, "seg-resume", `record ${index}`);
			const firstProvider = new FakeEmbeddingProvider();
			const embed = firstProvider.embed.bind(firstProvider);
			let calls = 0;
			firstProvider.embed = async (inputs, signal) => {
				calls += 1;
				if (calls === 2) throw new Error("second batch failed");
				return embed(inputs, signal);
			};

			await assert.rejects(
				__memoryOperatorTest.reindex(config, service, { force: true }, firstProvider),
				/second batch failed/,
			);
			assert.equal((service.memoryStore.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }).n, 2);
			assert.ok(
				service.memoryStore.db.prepare("SELECT v FROM memory_meta WHERE k = 'reindex_in_progress'").get(),
			);
			await assert.rejects(
				__memoryOperatorTest.reindex(
					config,
					service,
					{ corpus: "lcm_record", force: true },
					new FakeEmbeddingProvider(),
				),
				/different reindex is already in progress/,
			);
			assert.equal(
				(service.memoryStore.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }).n,
				2,
			);

			const resumedProvider = new FakeEmbeddingProvider();
			await __memoryOperatorTest.reindex(config, service, { force: true }, resumedProvider);
			assert.deepEqual(
				resumedProvider.batches.map((batch) => batch.length),
				[2, 1],
			);
			assert.equal(
				service.memoryStore.db.prepare("SELECT v FROM memory_meta WHERE k = 'reindex_in_progress'").get(),
				undefined,
			);

			const nextProvider = new FakeEmbeddingProvider();
			await __memoryOperatorTest.reindex(config, service, { force: true }, nextProvider);
			assert.deepEqual(
				nextProvider.batches.map((batch) => batch.length),
				[2, 2, 1],
			);
		} finally {
			service.close();
		}
	});

	it("restarts an interrupted reindex generation from the first batch", async (t) => {
		const config = await tempConfig(t, 2);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			for (let index = 0; index < 3; index++) insertRecord(service, "seg-restart", `restart ${index}`);
			const failingProvider = new FakeEmbeddingProvider();
			const embed = failingProvider.embed.bind(failingProvider);
			let calls = 0;
			failingProvider.embed = async (inputs, signal) => {
				calls += 1;
				if (calls === 2) throw new Error("second batch failed");
				return embed(inputs, signal);
			};
			await assert.rejects(
				__memoryOperatorTest.reindex(config, service, { force: true }, failingProvider),
				/second batch failed/,
			);

			config.memory.embedding.baseUrl = "https://replacement-embedding.test";
			const restartedProvider = new FakeEmbeddingProvider();
			await __memoryOperatorTest.reindex(config, service, { force: true, restart: true }, restartedProvider);
			assert.deepEqual(
				restartedProvider.batches.map((batch) => batch.length),
				[2, 1],
			);
		} finally {
			service.close();
		}
	});

	it("rejects a concurrent reindex for the same generation", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			insertRecord(service, "seg-concurrent", "concurrent record");
			const provider = new FakeEmbeddingProvider();
			const embed = provider.embed.bind(provider);
			let releaseBatch: () => void = () => {};
			const batchBlocked = new Promise<void>((resolve) => {
				releaseBatch = resolve;
			});
			let batchStarted: () => void = () => {};
			const started = new Promise<void>((resolve) => {
				batchStarted = resolve;
			});
			provider.embed = async (inputs, signal) => {
				batchStarted();
				await batchBlocked;
				return embed(inputs, signal);
			};

			const running = __memoryOperatorTest.reindex(config, service, { force: true }, provider);
			await started;
			try {
				await assert.rejects(
					__memoryOperatorTest.reindex(config, service, { force: true }, new FakeEmbeddingProvider()),
					/already running/,
				);
			} finally {
				releaseBatch();
			}
			await running;
		} finally {
			service.close();
		}
	});

	it("backs up both sqlite databases", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		const outDir = await mkdtemp(resolve(tmpdir(), "familiar-memory-backup-"));
		t.after(() => rm(outDir, { recursive: true, force: true }));
		try {
			insertRecord(service, "seg-backup", "backup record");
			indexChunk(service, "diary_chunk", "2026-05-10.md");

			await __memoryOperatorTest.backup(config, service, outDir);

			const lcmDb = new Database(resolve(outDir, "lcm.sqlite"), { readonly: true });
			const memoryDb = new Database(resolve(outDir, "memory.sqlite"), { readonly: true });
			try {
				assert.equal((lcmDb.prepare("SELECT COUNT(*) AS n FROM lcm_records").get() as { n: number }).n, 1);
				assert.equal((memoryDb.prepare("SELECT COUNT(*) AS n FROM memory_chunks").get() as { n: number }).n, 1);
			} finally {
				lcmDb.close();
				memoryDb.close();
			}
		} finally {
			service.close();
		}
	});

	it("prunes closed raw records while retaining the active segment", async (t) => {
		const config = await tempConfig(t);
		const service = MemoryService.createWithoutRuntime(config);
		try {
			insertRecord(service, "seg-closed", "closed raw");
			service.lcmStore.closeSegment("seg-closed");
			insertRecord(service, "seg-active", "active raw");

			await __memoryOperatorTest.prune(service, { retainDepth: 0, yes: true, vacuum: false });

			assert.deepEqual(
				service.lcmStore.listRecords().map((record) => record.text),
				["active raw"],
			);
			assert.equal(service.lcmStore.getSegment("seg-active")?.status, "active");
		} finally {
			service.close();
		}
	});
});
