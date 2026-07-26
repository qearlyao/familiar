import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { buildRecordBase, type ChatChannelRef } from "../src/conversation/chat-log.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import { LCM_RECORD_CORPUS } from "../src/memory/lcm/indexer.js";
import { MemoryService, createMemoryService, __memoryServiceTest } from "../src/memory/service.js";
import { LcmStore } from "../src/memory/lcm/store.js";
import type { LcmSummarizer } from "../src/memory/lcm/summarizer.js";
import { ConversationRuntime } from "../src/runtime/conversation-runtime.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";
import { contentText, renderMessages, withMemoryService, zeroUsage } from "./memory-fakes.js";

async function memoryConfig(t: { after(fn: () => Promise<void>): void }) {
	const dataDir = await createTempDataDir(t);
	const memoryRootDir = await mkdtemp(resolve(tmpdir(), "familiar-memory-service-"));
	t.after(async () => {
		await Promise.all([
			rm(dataDir, { recursive: true, force: true }),
			rm(memoryRootDir, { recursive: true, force: true }),
		]);
	});
	return configWithDataDir(t, dataDir, {
		memory: {
			rootDir: memoryRootDir,
			indexDir: resolve(memoryRootDir, "index"),
			lcmDir: resolve(memoryRootDir, "lcm"),
			diariesDir: resolve(memoryRootDir, "diaries"),
			archiveDir: resolve(memoryRootDir, "archive"),
			embedding: {
				format: "gemini",
				provider: "google",
				model: "gemini-embedding-test",
				baseUrl: "https://embedding.test",
				apiKeyEnv: "",
				dimensions: 3,
				batchSize: 8,
			},
			lcm: {
				newSessionRetainDepth: 2,
				enabled: false,
				model: "anthropic/claude-sonnet-4-5",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
				contextThreshold: 0.75,
				freshTailCount: 64,
				leafChunkTokens: 20000,
				leafTargetTokens: 2400,
				promptAwareEvictionEnabled: true,
				condenseGroupSize: 4,
				maxSummaryDepth: 4,
				maxRounds: 10,
				cacheTtlMs: 300000,
				cacheTouchSlackMs: 30000,
				criticalOverflowTokens: 8000,
				timeoutMs: 60000,
			},
		},
	});
}

async function withEmbeddingFetch<T>(values: number[], run: () => Promise<T>): Promise<T> {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ embeddings: [{ values }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = previousFetch;
	}
}

function vector(values: number[]): Float32Array {
	return new Float32Array(values);
}

const channel: ChatChannelRef = {
	service: "web",
	scope: "web",
	channelId: "room",
};

describe("MemoryService", () => {
	it("injects ambient diary recall into the last user message", () => {
		const messages = [
			{ role: "user" as const, content: "hello", timestamp: 1 },
			{ role: "assistant" as const, content: [], api: "test", provider: "test", model: "test", usage: zeroUsage(), stopReason: "stop" as const, timestamp: 2 },
			{ role: "user" as const, content: [{ type: "text" as const, text: "blue lantern" }], timestamp: 3 },
		];

		const next = __memoryServiceTest.injectAmbientDiaryRecall(messages, "<injected_memory>\n1. 2026-05-10: warm\n</injected_memory>");

		assert.deepEqual(messages[0], next[0]);
		const last = next[2];
		assert.equal(last?.role, "user");
		assert.equal(Array.isArray(last?.content), true);
		assert.match(Array.isArray(last?.content) ? (last.content.at(-1) as { text: string }).text : "", /<injected_memory>/);
	});

	it("recalls indexed diary chunks through transformContext", async (t) => {
		const config = await memoryConfig(t);
		const store = MemoryIndexStore.open(config);
		try {
			store.insertChunk({
				corpus: "diary_chunk",
				sourceId: "2026-05-10.md",
				text: "The blue lantern felt close.",
				snippet: "2026-05-10 Evening: The blue lantern felt close.",
				metadata: { date: "2026-05-10", heading: "Evening", valence: 1, intensity: 1 },
				embedding: vector([1, 0, 0]),
			});
		} finally {
			store.close();
		}

		await withEmbeddingFetch([1, 0, 0], async () => {
			await withMemoryService(config, async (service) => {
				const [message] = await service.transformContext([
					{ role: "user", content: "blue lantern", timestamp: Date.now() },
				]);
				assert.equal(message?.role, "user");
				assert.match(typeof message?.content === "string" ? message.content : "", /<injected_memory>/);
				assert.match(typeof message?.content === "string" ? message.content : "", /<\/injected_memory>/);
				assert.match(typeof message?.content === "string" ? message.content : "", /blue lantern/);
			});
		});
	});

	it("skips ambient diary retrieval when requested for a transform", async (t) => {
		const config = await memoryConfig(t);
		const store = MemoryIndexStore.open(config);
		try {
			store.insertChunk({
				corpus: "diary_chunk",
				sourceId: "2026-05-10.md",
				text: "The heartbeat lantern should stay out of ambient recall.",
				snippet: "2026-05-10 Evening: The heartbeat lantern should stay out of ambient recall.",
				metadata: { date: "2026-05-10", heading: "Evening", valence: 1, intensity: 1 },
				embedding: vector([1, 0, 0]),
			});
		} finally {
			store.close();
		}

		let embeddingCalls = 0;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			embeddingCalls += 1;
			return new Response(JSON.stringify({ embeddings: [{ values: [1, 0, 0] }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			await withMemoryService(config, async (service) => {
				const [message] = await service.transformContext(
					[{ role: "user", content: "heartbeat lantern", timestamp: Date.now() }],
					undefined,
					{ skipAmbient: true },
				);
				assert.equal(message?.role, "user");
				assert.doesNotMatch(typeof message?.content === "string" ? message.content : "", /<injected_memory>/);
				assert.equal(embeddingCalls, 0);
			});
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("debounces changed diary files into the shared memory index", async (t) => {
		const config = await memoryConfig(t);
		await mkdir(config.memory.diariesDir, { recursive: true });
		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { diaryWatchDebounceMs: 20 });
			try {
				service.watchDiaries();
				const diaryPath = resolve(config.memory.diariesDir, "2026-05-12.md");
				await writeFile(diaryPath, "first ambient watcher line", "utf8");
				await writeFile(diaryPath, "second ambient watcher line", "utf8");
				await writeFile(resolve(config.memory.diariesDir, "notes.md"), "not indexed", "utf8");

				await waitFor(() => {
					const hits = serviceMemoryStore(service).searchLexical("second", { corpus: "diary_chunk", limit: 5 });
					return hits.length === 1;
				});
				assert.equal(serviceMemoryStore(service).searchLexical("first", { corpus: "diary_chunk", limit: 5 }).length, 0);
				assert.equal(
					serviceMemoryStore(service).searchLexical("indexed", { corpus: "diary_chunk", limit: 5 }).length,
					0,
				);

				await rm(diaryPath);
				await waitFor(() => {
					return serviceMemoryStore(service).searchLexical("second", { corpus: "diary_chunk", limit: 5 }).length === 0;
				});
			} finally {
				service.close();
			}
		});
	});

	it("skips unchanged diary files during repeated startup indexing", async (t) => {
		const config = await memoryConfig(t);
		await mkdir(config.memory.diariesDir, { recursive: true });
		await writeFile(resolve(config.memory.diariesDir, "2026-05-12.md"), "startup diary once", "utf8");
		let embeddingCalls = 0;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			embeddingCalls += 1;
			return new Response(JSON.stringify({ embeddings: [{ values: [1, 0, 0] }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const service = createMemoryService(config);
			try {
				await service.indexDiaries();
				await service.indexDiaries();

				assert.equal(embeddingCalls, 1);
				assert.equal(serviceMemoryStore(service).searchLexical("startup", { corpus: "diary_chunk", limit: 5 }).length, 1);
			} finally {
				service.close();
			}
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("projects runtime records into LCM and rotates segments on reset", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: { ...baseConfig.memory, lcm: { ...baseConfig.memory.lcm, newSessionRetainDepth: -1 } },
		};
		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = MemoryService.createWithoutRuntime(config);
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "web-web-room",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			try {
				await runtime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "Remember the compact toolbar.",
				});
				await runtime.noteOutbound({ text: "I will remember the compact toolbar.", messageIds: ["m2"] });
				await runtime.resetConversation("new conversation requested");
				await service.flush();

				const records = service.lcmStore.listRecords();
				assert.deepEqual(
					records.map((record) => record.kind),
					["user", "assistant", "boundary"],
				);
				assert.equal(service.lcmStore.listSegments().some((segment) => segment.status === "closed"), true);
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("clears persisted LCM context items when runtime segment rotates on reset", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: { ...baseConfig.memory, lcm: { ...baseConfig.memory.lcm, newSessionRetainDepth: -1 } },
		};
		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = MemoryService.createWithoutRuntime(config);
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "web-web-room",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			try {
				await runtime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "Remember the compact toolbar.",
				});
				await service.flush();

				const lcmStoreBeforeReset = LcmStore.open(config);
				try {
					const record = lcmStoreBeforeReset.listRecords()[0];
					assert.ok(record);
					const summaryId = lcmStoreBeforeReset.insertSummary({
						segmentId: record.segmentId,
						depth: 1,
						status: "ready",
						text: "Remember the compact toolbar.",
						coversFromRecordId: record.id,
						coversToRecordId: record.id,
						source: { sourceType: "manual", sourceRef: "summary:compact-toolbar" },
					});
					lcmStoreBeforeReset.replaceContextItems("web-web-room", [
						{
							summaryId,
							fingerprint: "runtime:compact-toolbar",
							happenedAt: "2026-05-10T01:00:00.000Z",
						},
					]);
					assert.equal(lcmStoreBeforeReset.listContextItems("web-web-room").length, 1);
				} finally {
					lcmStoreBeforeReset.close();
				}

				await runtime.resetConversation("new conversation requested");
				await service.flush();

				assert.equal(service.lcmStore.listContextItems("web-web-room").length, 0);
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("continues segment IDs after restart instead of reusing closed segments", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: { ...baseConfig.memory, lcm: { ...baseConfig.memory.lcm, newSessionRetainDepth: -1 } },
		};
		await withEmbeddingFetch([1, 0, 0], async () => {
			const firstService = createMemoryService(config);
			const firstLog = memoryLog();
			const firstRuntime = await ConversationRuntime.connect({
				channelKey: "web-web-room",
				log: firstLog,
				ownerId: "owner",
			});
			const firstUnsubscribe = firstService.subscribeRuntime(firstRuntime, "session-a");
			try {
				await firstRuntime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "First session detail.",
				});
				await firstRuntime.resetConversation("new conversation requested");
				await firstService.flush();
			} finally {
				firstUnsubscribe();
				await firstRuntime.disconnect();
				firstService.close();
			}

			const secondService = createMemoryService(config);
			const secondLog = memoryLog();
			const secondRuntime = await ConversationRuntime.connect({
				channelKey: "web-web-room",
				log: secondLog,
				ownerId: "owner",
			});
			const secondUnsubscribe = secondService.subscribeRuntime(secondRuntime, "session-b");
			try {
				await secondRuntime.ingestInbound({
					messageId: "m2",
					authorId: "owner",
					text: "Second session detail.",
				});
				await secondService.flush();

				const lcmStore = LcmStore.open(config);
				try {
					assert.deepEqual(
						lcmStore.listRecords().map((record) => ({ kind: record.kind, segmentId: record.segmentId })),
						[
							{ kind: "user", segmentId: "web-web-room:seg-1" },
							{ kind: "boundary", segmentId: "web-web-room:seg-1" },
							{ kind: "user", segmentId: "web-web-room:seg-2" },
						],
					);
					assert.equal(lcmStore.getSegment("web-web-room:seg-1")?.status, "closed");
					assert.equal(lcmStore.getSegment("web-web-room:seg-2")?.status, "active");
				} finally {
					lcmStore.close();
				}
			} finally {
				secondUnsubscribe();
				await secondRuntime.disconnect();
				secondService.close();
			}
		});
	});

	it("removes pruned LCM records from the shared memory index on reset", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: { ...baseConfig.memory, lcm: { ...baseConfig.memory.lcm, newSessionRetainDepth: 0 } },
		};
		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = MemoryService.createWithoutRuntime(config);
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "web-web-room",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			try {
				await runtime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "Recall should not find the pruned toolbar detail.",
				});
				await service.flush();

				let memoryStore = MemoryIndexStore.open(config);
				try {
					assert.equal(memoryStore.searchLexical("toolbar", { corpus: LCM_RECORD_CORPUS }).length, 1);
				} finally {
					memoryStore.close();
				}

				await runtime.resetConversation("new conversation requested");
				await service.flush();

				assert.deepEqual(service.lcmStore.listRecords(), []);

				memoryStore = MemoryIndexStore.open(config);
				try {
					assert.equal(memoryStore.searchLexical("toolbar", { corpus: LCM_RECORD_CORPUS }).length, 0);
				} finally {
					memoryStore.close();
				}
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("uses the live new-session retention setting when rotating segments", async (t) => {
		const config = await memoryConfig(t);
		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = MemoryService.createWithoutRuntime(config);
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "web-web-live-retention",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			try {
				await runtime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "retention baseline",
				});
				await service.flush();
				service.lcmStore.insertSummary({
					segmentId: "web-web-live-retention:seg-1",
					depth: 2,
					status: "ready",
					text: "old retained summary",
					source: { sourceType: "manual", sourceRef: "summary:live-retention" },
				});
				assert.equal(service.lcmStore.listSummaries().length, 1);

				config.memory.lcm.newSessionRetainDepth = 3;
				await runtime.resetConversation("new conversation requested");
				await service.flush();

				assert.equal(service.lcmStore.listSummaries().length, 0);
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("automatically summarizes old LCM context once it exceeds the leaf trigger", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 23,
					leafTargetTokens: 8,
					maxRounds: 1,
				},
			},
		};
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf(input) {
				calls += 1;
				assert.match(input.text, /old detail alpha/);
				return 'Files: none\nThe old alpha and beta details were compacted.\nExpand for details about: old chat wording';
			},
		};
		await withEmbeddingFetch([1, 0, 0], async () => {
			await withMemoryService(config, { summarizer }, async (service) => {
				const messages = [
					{ role: "user" as const, content: "old detail alpha", timestamp: 1 },
					{ role: "assistant" as const, content: [{ type: "text" as const, text: "old detail beta" }], api: "test", provider: "test", model: "test", usage: zeroUsage(), stopReason: "stop" as const, timestamp: 2 },
					{ role: "user" as const, content: "fresh detail gamma", timestamp: 3 },
				];

				const first = await service.transformContext(messages, undefined, {
					sessionKey: "room-a",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 1);
				assert.equal(first.length, 2);
				assert.equal(first[0]?.role, "assistant");
				assert.match(contentText(first[0]), /<from_earlier\b/);
				assert.match(contentText(first[0]), /old alpha and beta/);
				assert.equal(first[1]?.role, "user");
				assert.match(contentText(first[1]), /fresh detail gamma/);

				const second = await service.transformContext(messages, undefined, {
					sessionKey: "room-a",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 1);
				assert.deepEqual(second.map((message) => message.role), first.map((message) => message.role));

				const summaries = service.lcmStore.listSummaries();
				assert.equal(summaries.length, 1);
				assert.match(summaries[0]?.text ?? "", /old alpha and beta/);
				assert.ok(summaries[0]?.coversFromRecordId);
				assert.ok(summaries[0]?.coversToRecordId);
				assert.ok(service.lcmStore.getRecord(summaries[0]?.coversFromRecordId as number));
				assert.ok(service.lcmStore.getRecord(summaries[0]?.coversToRecordId as number));
				const sources = service.lcmStore.getSummarySources(summaries[0]?.id as number);
				assert.equal(sources.length, 2);
				assert.equal(sources.every((source) => source.recordId !== null), true);
				for (const source of sources) assert.ok(service.lcmStore.getRecord(source.recordId as number));
			});
		});
	});

	it("returns a budget-guarded LCM context when compaction cannot finish", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 200_000,
					leafTargetTokens: 8,
					maxRounds: 1,
				},
			},
		};
		await withEmbeddingFetch([1, 0, 0], async () => {
			await withMemoryService(config, {
				summarizer: {
					async summarizeLeaf() {
						throw new Error("budget guard should not need summarization");
					},
				},
			}, async (service) => {
				const messages = [
					{ role: "user" as const, content: "old alpha ".repeat(200), timestamp: 1 },
					{ role: "user" as const, content: "old beta ".repeat(200), timestamp: 2 },
					{ role: "user" as const, content: "fresh gamma", timestamp: 3 },
				];

				const guarded = await service.transformContext(messages, undefined, {
					sessionKey: "room-budget-guard",
					sessionId: "session-budget-guard",
					model: { contextWindow: 200 } as any,
				});
				const rendered = guarded.map(contentText).join("\n");

				assert.doesNotMatch(rendered, /old alpha/);
				assert.doesNotMatch(rendered, /old beta/);
				assert.match(rendered, /fresh gamma/);
			});
		});
	});

	it("defers LCM compaction debt while cache is hot", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = lcmDebtConfig(baseConfig);
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nDeferred hot-cache pressure was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			await withMemoryService(config, { summarizer, now: () => now }, async (service) => {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-hot-defer",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(debtMessages(), undefined, {
					sessionKey: "room-hot-defer",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 0);

				assert.equal(service.lcmStore.listSummaries().length, 0);
				assert.ok((service.lcmStore.getSessionState("room-hot-defer")?.compactionDebt ?? 0) > 0);
			});
		});
	});

	it("services LCM compaction debt once cache is cold", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...lcmDebtConfig(baseConfig),
			memory: {
				...lcmDebtConfig(baseConfig).memory,
				lcm: {
					...lcmDebtConfig(baseConfig).memory.lcm,
					maxRounds: 10,
				},
			},
		};
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nCold-cache pressure was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			await withMemoryService(config, { summarizer, now: () => now }, async (service) => {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-cold-service",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(debtMessages(), undefined, {
					sessionKey: "room-cold-service",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 0);

				now = 105_000 + config.memory.lcm.cacheTtlMs - config.memory.lcm.cacheTouchSlackMs;
				await service.transformContext(debtMessages(), undefined, {
					sessionKey: "room-cold-service",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
					assert.equal(calls, 1);

				assert.equal(service.lcmStore.listSummaries().length, 1);
				assert.equal(service.lcmStore.getSessionState("room-cold-service")?.compactionDebt, 0);
			});
		});
	});

	it("forces LCM compaction during critical overflow even when cache is hot", async (t) => {
		const baseConfig = await memoryConfig(t);
		const debtConfig = lcmDebtConfig(baseConfig);
		const config = {
			...debtConfig,
			memory: {
				...debtConfig.memory,
				lcm: {
					...debtConfig.memory.lcm,
					leafChunkTokens: 200_000,
				},
			},
		};
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nCritical overflow was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			await withMemoryService(config, { summarizer, now: () => now }, async (service) => {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-critical-overflow",
					sessionId: "session-a",
					model: { contextWindow: 50_000 } as any,
				});
				now += 5_000;
				await service.transformContext(criticalDebtMessages(), undefined, {
					sessionKey: "room-critical-overflow",
					sessionId: "session-a",
					model: { contextWindow: 50_000 } as any,
				});
				assert.equal(calls, 1);

				assert.equal(service.lcmStore.listSummaries().length, 1);
				assert.ok(
					(service.lcmStore.getSessionState("room-critical-overflow")?.compactionDebt ?? 0) <
						config.memory.lcm.criticalOverflowTokens,
				);
			});
		});
	});

	it("persists deferred LCM compaction debt across restart", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...lcmDebtConfig(baseConfig),
			memory: {
				...lcmDebtConfig(baseConfig).memory,
				lcm: {
					...lcmDebtConfig(baseConfig).memory.lcm,
					maxRounds: 10,
				},
			},
		};
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nRestarted cold-cache debt was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			let service = createMemoryService(config, { summarizer, now: () => now });
			try {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-debt-restart",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(debtMessages(), undefined, {
					sessionKey: "room-debt-restart",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
			} finally {
				service.close();
			}

			let store = LcmStore.open(config);
			try {
				assert.ok((store.getSessionState("room-debt-restart")?.compactionDebt ?? 0) > 0);
			} finally {
				store.close();
			}

			now = 105_000 + config.memory.lcm.cacheTtlMs - config.memory.lcm.cacheTouchSlackMs;
			service = createMemoryService(config, { summarizer, now: () => now });
			try {
				await service.transformContext(debtMessages(), undefined, {
					sessionKey: "room-debt-restart",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 1);
			} finally {
				service.close();
			}

			store = LcmStore.open(config);
			try {
				assert.ok((store.getSessionState("room-debt-restart")?.compactionDebt ?? 0) >= 0);
				assert.equal(store.listSummaries().length, 1);
			} finally {
				store.close();
			}
		});
	});

	it("clears deferred LCM compaction debt when runtime segment rotates on reset", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = lcmDebtConfig(baseConfig);
		let now = 100_000;
		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer: fixedSummary("unused"), now: () => now });
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "room-new-clears-debt",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			try {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-new-clears-debt",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(debtMessages(), undefined, {
					sessionKey: "room-new-clears-debt",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});

				let store = LcmStore.open(config);
				try {
					assert.ok((store.getSessionState("room-new-clears-debt")?.compactionDebt ?? 0) > 0);
				} finally {
					store.close();
				}

				await runtime.resetConversation("new conversation requested");
				await service.flush();

				store = LcmStore.open(config);
				try {
					assert.equal(store.getSessionState("room-new-clears-debt"), null);
				} finally {
					store.close();
				}
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("invalidates in-memory LCM state on reset so summaries do not leak into the next segment", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = lcmCompactionConfig(baseConfig);
		const summarizer = fixedSummary("The old alpha and beta details were compacted.");

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer });
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "room-rotation-invalidate",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			const freshTail = { role: "user" as const, content: "fresh detail gamma", timestamp: 3 };
			try {
				await service.transformContext(
					[
						{ role: "user" as const, content: "old detail alpha", timestamp: 1 },
						{
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "old detail beta" }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "stop" as const,
							timestamp: 2,
						},
						freshTail,
					],
					undefined,
					{ sessionKey: "room-rotation-invalidate", sessionId: "session-a", model: { contextWindow: 10_000 } as any },
				);

				await runtime.resetConversation("new conversation requested");
				await service.flush();

				const afterReset = await service.transformContext(
					[{ role: "user" as const, content: "brand new tail delta", timestamp: 4 }],
					undefined,
					{
						sessionKey: "room-rotation-invalidate",
						sessionId: "session-a",
						model: { contextWindow: 10_000 } as any,
					},
				);

				assert.doesNotMatch(renderMessages(afterReset), /old detail alpha|old detail beta|<from_earlier\b/);

				const store = LcmStore.open(config);
				try {
					assert.equal(store.listContextItems("room-rotation-invalidate").length, 0);
				} finally {
					store.close();
				}
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("does not persist or rehydrate raw context items on restart", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					contextThreshold: 1,
					freshTailCount: 1,
					leafChunkTokens: 200_000,
					leafTargetTokens: 1_000,
					maxRounds: 1,
				},
			},
		};
		const summarizer = fixedSummary("unused");
		const rawMessages = Array.from({ length: 10 }, (_, index) => ({
			role: "user" as const,
			content: `history item ${index + 1}`,
			timestamp: index + 1,
		}));

		await withEmbeddingFetch([1, 0, 0], async () => {
			let service = createMemoryService(config, { summarizer });
			try {
				await service.transformContext(rawMessages, undefined, {
					sessionKey: "room-rehydrate-raws",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
			} finally {
				service.close();
			}

			service = createMemoryService(config, { summarizer });
			try {
				const afterRestart = await service.transformContext(
					[{ role: "user" as const, content: "fresh detail delta", timestamp: 13 }],
					undefined,
					{
						sessionKey: "room-rehydrate-raws",
						sessionId: "session-a",
						model: { contextWindow: 10_000 } as any,
					},
				);

				assert.equal(afterRestart.length, 1);
				assert.doesNotMatch(renderMessages(afterRestart), /history item/);
				assert.match(renderMessages(afterRestart), /fresh detail delta/);

				const store = LcmStore.open(config);
				try {
					assert.equal(store.listContextItems("room-rehydrate-raws").length, 0);
				} finally {
					store.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("services cold-turn compaction debt once after syncContextState", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 2_000,
					leafTargetTokens: 1_000,
					maxRounds: 1,
				},
			},
		};
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nCold-turn combined debt was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer, now: () => now });
			try {
				await service.transformContext(
					[
						{ role: "user" as const, content: "old detail alpha ".repeat(300), timestamp: 10 },
						{
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "old detail beta ".repeat(300) }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "stop" as const,
							timestamp: 11,
						},
						{ role: "user" as const, content: "fresh detail gamma", timestamp: 12 },
					],
					undefined,
					{ sessionKey: "room-cold-once", sessionId: "session-a", model: { contextWindow: 10_000 } as any },
				);
				now += 5_000;
				await service.transformContext(
					[
						{ role: "user" as const, content: "fresh detail gamma", timestamp: 12 },
						{ role: "user" as const, content: "fresh detail delta", timestamp: 13 },
					],
					undefined,
					{
						sessionKey: "room-cold-once",
						sessionId: "session-a",
						model: { contextWindow: 10_000 } as any,
					},
				);
				assert.equal(calls, 1);
			} finally {
				service.close();
			}
		});
	});

	it("invalidates in-memory LCM context state when runtime segment rotates", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = lcmCompactionConfig(baseConfig);
		const summarizer = fixedSummary("The old alpha and beta details were compacted.");
		let now = 100_000;

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = MemoryService.createWithoutRuntime(config, { summarizer, now: () => now });
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "room-rotate-invalidate",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			try {
				const firstTurn = await service.transformContext(
					[
						{ role: "user" as const, content: "old detail alpha", timestamp: 1 },
						{
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "old detail beta" }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "stop" as const,
							timestamp: 2,
						},
						{ role: "user" as const, content: "fresh detail gamma", timestamp: 3 },
					],
					undefined,
					{ sessionKey: "room-rotate-invalidate", sessionId: "session-a", model: { contextWindow: 10_000 } as any },
				);
				assert.match(renderMessages(firstTurn), /<from_earlier\b/);

				await runtime.resetConversation("new conversation requested");
				await service.flush();

				const afterReset = await service.transformContext(
					[{ role: "user" as const, content: "brand new tail delta", timestamp: 4 }],
					undefined,
					{
						sessionKey: "room-rotate-invalidate",
						sessionId: "session-a",
						model: { contextWindow: 10_000 } as any,
					},
				);

				assert.equal(afterReset.length, 1);
				assert.doesNotMatch(renderMessages(afterReset), /<from_earlier\b/);
				assert.match(renderMessages(afterReset), /brand new tail delta/);
				assert.equal(service.lcmStore.listContextItems("room-rotate-invalidate").length, 0);
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("accumulates LCM compaction debt additively and drains it in two rounds", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 500,
					leafTargetTokens: 0,
					maxRounds: 2,
				},
			},
		};
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "compact";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer, now: () => now });
			try {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-additive-debt",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(additiveDebtMessages("fresh detail gamma"), undefined, {
					sessionKey: "room-additive-debt",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 0);

				const storeBefore = LcmStore.open(config);
				let debtBefore = 0;
				try {
					debtBefore = storeBefore.getSessionState("room-additive-debt")?.compactionDebt ?? 0;
					assert.ok(debtBefore > 0);
				} finally {
					storeBefore.close();
				}

				now = 100_000 + config.memory.lcm.cacheTtlMs - config.memory.lcm.cacheTouchSlackMs;
				await service.serviceCompactionDebt("room-additive-debt");
				assert.ok(calls >= 1);

				const storeAfter = LcmStore.open(config);
				try {
					assert.ok((storeAfter.getSessionState("room-additive-debt")?.compactionDebt ?? 0) < debtBefore);
				} finally {
					storeAfter.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("services cold-cache debt once when rehydrated debt meets new pressure", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 500,
					leafTargetTokens: 0,
					maxRounds: 1,
				},
			},
		};
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nCold-cache debt was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			let service = createMemoryService(config, { summarizer, now: () => now });
			try {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-cold-once",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(additiveDebtMessages("fresh detail gamma"), undefined, {
					sessionKey: "room-cold-once",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
			} finally {
				service.close();
			}

			service = createMemoryService(config, { summarizer, now: () => now });
			try {
				now = 100_000 + config.memory.lcm.cacheTtlMs - config.memory.lcm.cacheTouchSlackMs;
				await service.transformContext(additiveDebtMessages("brand new tail delta"), undefined, {
					sessionKey: "room-cold-once",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 0);
				const store = LcmStore.open(config);
				try {
					assert.ok((store.getSessionState("room-cold-once")?.compactionDebt ?? 0) >= 0);
				} finally {
					store.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("deduplicates insertSummary calls for the same summary key across an interleaved insert", async (t) => {
		const config = await memoryConfig(t);
		const service: ReturnType<typeof MemoryService.createWithoutRuntime> = MemoryService.createWithoutRuntime(config);
		const peerStore = LcmStore.open(config);
		try {
			const input = {
				segmentId: "seg-summary-dedupe",
				depth: 1,
				status: "ready" as const,
				text: "duplicate summary",
				source: { sourceType: "manual" as const, sourceRef: "sum:dedupe" },
			};
			const first = peerStore.insertSummary(input);
			const second = service.lcmStore.insertSummary(input);

			assert.equal(first, second);
			assert.equal(service.lcmStore.listSummaries("seg-summary-dedupe").length, 1);
		} finally {
			service.close();
			peerStore.close();
		}
	});

	it("serviceCompactionDebt forces LCM compaction while cache is hot", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...lcmDebtConfig(baseConfig),
			memory: {
				...lcmDebtConfig(baseConfig).memory,
				lcm: {
					...lcmDebtConfig(baseConfig).memory.lcm,
					maxRounds: 10,
				},
			},
		};
			let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nForced deferred debt was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer, now: () => now });
			try {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-force-debt",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(debtMessages(), undefined, {
					sessionKey: "room-force-debt",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				assert.equal(calls, 0);

				await service.serviceCompactionDebt("room-force-debt");
				assert.equal(calls, 1);

				const store = LcmStore.open(config);
				try {
					assert.equal(store.listSummaries().length, 1);
					assert.equal(store.getSessionState("room-force-debt")?.compactionDebt, 0);
				} finally {
					store.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("subtracts serviced leaf tokens from compaction debt across multiple rounds", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...lcmDebtConfig(baseConfig),
			memory: {
				...lcmDebtConfig(baseConfig).memory,
				lcm: {
					...lcmDebtConfig(baseConfig).memory.lcm,
					leafChunkTokens: 500,
					leafTargetTokens: 0,
					maxRounds: 2,
				},
			},
		};
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return `compact ${calls}`;
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer, now: () => now });
			try {
				await service.transformContext([{ role: "user" as const, content: "warm cache tail", timestamp: 1 }], undefined, {
					sessionKey: "room-debt-accumulator",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});
				now += 5_000;
				await service.transformContext(
					[
						{ role: "user" as const, content: "old detail alpha ".repeat(150), timestamp: 10 },
						{
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "old detail beta ".repeat(150) }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "stop" as const,
							timestamp: 11,
						},
						{ role: "user" as const, content: "old detail gamma ".repeat(150), timestamp: 12 },
						{
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "old detail delta ".repeat(150) }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "stop" as const,
							timestamp: 13,
						},
						{ role: "user" as const, content: "fresh detail epsilon", timestamp: 14 },
					],
					undefined,
					{
						sessionKey: "room-debt-accumulator",
						sessionId: "session-a",
						model: { contextWindow: 10_000 } as any,
					},
				);
				const persistedDuringTurn = LcmStore.open(config);
				try {
					assert.ok((persistedDuringTurn.getSessionState("room-debt-accumulator")?.compactionDebt ?? 0) > 0);
				} finally {
					persistedDuringTurn.close();
				}

				const beforeDrain = LcmStore.open(config);
				let debtBefore = 0;
				try {
					debtBefore = beforeDrain.getSessionState("room-debt-accumulator")?.compactionDebt ?? 0;
					assert.ok(debtBefore > 0);
				} finally {
					beforeDrain.close();
				}

				await service.serviceCompactionDebt("room-debt-accumulator");
				assert.ok(calls >= 1);

				const store = LcmStore.open(config);
				try {
					const afterDrain = store.getSessionState("room-debt-accumulator")?.compactionDebt ?? 0;
					assert.ok(afterDrain < debtBefore);
					assert.ok(store.listSummaries().length >= 1);
				} finally {
					store.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("rehydrates persisted LCM summary after restart when runtime sends only the fresh tail", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = lcmCompactionConfig(baseConfig);
		const summarizer = fixedSummary("The old alpha and beta details were compacted.");

		await withEmbeddingFetch([1, 0, 0], async () => {
			let service = createMemoryService(config, { summarizer });
			const freshTail = { role: "user" as const, content: "fresh detail gamma", timestamp: 3 };
			try {
				await service.transformContext(
					[
						{ role: "user" as const, content: "old detail alpha", timestamp: 1 },
						{
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "old detail beta" }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "stop" as const,
							timestamp: 2,
						},
						freshTail,
					],
					undefined,
					{ sessionKey: "room-rehydrate-tail", sessionId: "session-a", model: { contextWindow: 10_000 } as any },
				);
			} finally {
				service.close();
			}

			service = createMemoryService(config, { summarizer });
			try {
				const afterRestart = await service.transformContext([freshTail], undefined, {
					sessionKey: "room-rehydrate-tail",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});

				assert.equal(afterRestart.length, 2);
				assert.match(contentText(afterRestart[0]), /<from_earlier\b/);
				assert.match(contentText(afterRestart[0]), /old alpha and beta/);
				assert.doesNotMatch(renderMessages(afterRestart), /old detail alpha/);
				assert.doesNotMatch(renderMessages(afterRestart), /old detail beta/);
				assert.match(contentText(afterRestart[1]), /fresh detail gamma/);
			} finally {
				service.close();
			}
		});
	});

	it("preserves rehydrated LCM summary before a different fresh tail after restart", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = lcmCompactionConfig(baseConfig);
		const summarizer = fixedSummary("The old alpha and beta details were compacted.");

		await withEmbeddingFetch([1, 0, 0], async () => {
			let service = createMemoryService(config, { summarizer });
			try {
				await service.transformContext(
					[
						{ role: "user" as const, content: "old detail alpha", timestamp: 1 },
						{
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "old detail beta" }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "stop" as const,
							timestamp: 2,
						},
						{ role: "user" as const, content: "fresh detail gamma", timestamp: 3 },
					],
					undefined,
					{ sessionKey: "room-rehydrate-new-tail", sessionId: "session-a", model: { contextWindow: 10_000 } as any },
				);
			} finally {
				service.close();
			}

			service = createMemoryService(config, { summarizer });
			try {
				const afterRestart = await service.transformContext(
					[{ role: "user" as const, content: "brand new tail delta", timestamp: 4 }],
					undefined,
					{
						sessionKey: "room-rehydrate-new-tail",
						sessionId: "session-a",
						model: { contextWindow: 10_000 } as any,
					},
				);

				assert.equal(afterRestart.length, 2);
				assert.match(contentText(afterRestart[0]), /<from_earlier\b/);
				assert.match(contentText(afterRestart[0]), /old alpha and beta/);
				assert.doesNotMatch(renderMessages(afterRestart), /fresh detail gamma/);
				assert.match(contentText(afterRestart[1]), /brand new tail delta/);
			} finally {
				service.close();
			}
		});
	});

	it("summary over span with tool_call record includes tool markers in rendered input", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 10,
					leafTargetTokens: 8,
					maxRounds: 1,
				},
			},
		};
		let renderedInput = "";
		const summarizer: LcmSummarizer = {
			async summarizeLeaf(input) {
				renderedInput = input.text;
				return "Files: none\nTool interaction was compacted.\nExpand for details about: tool call and result";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = MemoryService.createWithoutRuntime(config, { summarizer });
			try {
				await service.transformContext(
					[
						{
							role: "assistant" as const,
							content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "PLAN.md" } }],
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "toolUse" as const,
							timestamp: 1,
						},
						{
							role: "toolResult" as const,
							toolCallId: "call-1",
							toolName: "read",
							content: [{ type: "text" as const, text: "visible read output" }],
							details: { text: "details-only output" },
							isError: false,
							timestamp: 2,
						},
						{ role: "user" as const, content: "fresh detail", timestamp: 3 },
					],
					undefined,
					{ sessionKey: "room-tools", sessionId: "session-tools", model: { contextWindow: 10_000 } as any },
				);

				assert.match(renderedInput, /<tool_call name="read">/);
				assert.match(renderedInput, /"path": "PLAN\.md"/);
				assert.match(renderedInput, /<tool_result name="read">/);
				assert.match(renderedInput, /visible read output/);
				assert.doesNotMatch(renderedInput, /details-only output/);
				const toolRecord = service.lcmStore.listRecords().find((record) => record.kind === "tool");
				assert.deepEqual(toolRecord?.parts, [
					{ kind: "tool_result", toolCallId: "call-1", toolName: "read", output: "visible read output" },
				]);
			} finally {
				service.close();
			}
		});
	});

	it("strips provider signature metadata from leaf summary input", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 10,
					leafTargetTokens: 8,
					maxRounds: 1,
				},
			},
		};
		let renderedInput = "";
		const summarizer: LcmSummarizer = {
			async summarizeLeaf(input) {
				renderedInput = input.text;
				return "Files: none\nProvider signature metadata was stripped.\nExpand for details about: visible summary content";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer });
			try {
				await service.transformContext(
					[
						{
							role: "assistant" as const,
							content: [
								{
									type: "thinking" as const,
									thinking: "visible planning note",
									thinkingSignature: "thinkingSignature-secret",
									textSignature: "textSignature-secret",
									thoughtSignature: "thoughtSignature-secret",
									signature: { type: "encrypted", payload: "encrypted-signature-payload-marker" },
								},
								{
									type: "text" as const,
									text: "visible answer text",
									textSignature: "textSignature-secret",
								},
								{
									type: "toolCall" as const,
									id: "call-1",
									name: "read",
									arguments: { path: "PLAN.md" },
									thinkingSignature: "thinkingSignature-secret",
								},
							] as any,
							api: "test",
							provider: "test",
							model: "test",
							usage: zeroUsage(),
							stopReason: "toolUse" as const,
							timestamp: 1,
						},
						{ role: "user" as const, content: "fresh detail", timestamp: 2 },
					],
					undefined,
					{ sessionKey: "room-provider-signatures", sessionId: "session-signatures", model: { contextWindow: 10_000 } as any },
				);

				assert.match(renderedInput, /visible answer text/);
				assert.match(renderedInput, /<tool_call name="read">/);
				assert.match(renderedInput, /"path": "PLAN\.md"/);
				assert.equal(renderedInput.includes("thinkingSignature-secret"), false);
				assert.equal(renderedInput.includes("textSignature-secret"), false);
				assert.equal(renderedInput.includes("thoughtSignature-secret"), false);
				assert.equal(renderedInput.includes("encrypted-signature-payload-marker"), false);
			} finally {
				service.close();
			}
		});
	});

	it("prompt-aware LCM compaction skips records relevant to the last user message", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 32,
					leafTargetTokens: 8,
					maxRounds: 1,
					promptAwareEvictionEnabled: true,
				},
			},
		};
		let summarizedInput = "";
		const summarizer: LcmSummarizer = {
			async summarizeLeaf(input) {
				summarizedInput = input.text;
				return "Files: none\nPrompt-aware unrelated details were compacted.\nExpand for details about: evicted range";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer });
			try {
				await service.transformContext(promptAwareMessages(), undefined, {
					sessionKey: "room-prompt-aware",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});

				assert.match(summarizedInput, /weather|kanban/);
				assert.equal(summarizedInput.includes("rebar lattice beam"), false);
				assert.equal(summarizedInput.includes("rebar lattice footing"), false);
			} finally {
				service.close();
			}
		});
	});

	it("falls back to oldest-first LCM compaction when prompt-aware eviction is disabled", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: {
				...baseConfig.memory,
				lcm: {
					...baseConfig.memory.lcm,
					enabled: true,
					freshTailCount: 1,
					leafChunkTokens: 32,
					leafTargetTokens: 8,
					maxRounds: 1,
					promptAwareEvictionEnabled: false,
				},
			},
		};
		let summarizedInput = "";
		const summarizer: LcmSummarizer = {
			async summarizeLeaf(input) {
				summarizedInput = input.text;
				return "Files: none\nOldest-first details were compacted.\nExpand for details about: evicted range";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer });
			try {
				await service.transformContext(promptAwareMessages(), undefined, {
					sessionKey: "room-prompt-aware-disabled",
					sessionId: "session-a",
					model: { contextWindow: 10_000 } as any,
				});

				assert.equal(summarizedInput.includes("rebar lattice beam"), true);
				assert.equal(summarizedInput.includes("weather front"), false);
				assert.equal(summarizedInput.includes("kanban schedule owner"), false);
			} finally {
				service.close();
			}
		});
	});

	it("reconciles shared-index rows left behind after LCM retention committed", async (t) => {
		const baseConfig = await memoryConfig(t);
		const config = {
			...baseConfig,
			memory: { ...baseConfig.memory, lcm: { ...baseConfig.memory.lcm, newSessionRetainDepth: 0 } },
		};
		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config);
			const log = memoryLog();
			const runtime = await ConversationRuntime.connect({
				channelKey: "web-web-room",
				log,
				ownerId: "owner",
			});
			const unsubscribe = service.subscribeRuntime(runtime, "session-a");
			const originalDelete = serviceMemoryStore(service).deleteBySourceUnsafe.bind(serviceMemoryStore(service));
			const originalConsoleError = console.error;
			serviceMemoryStore(service).deleteBySourceUnsafe = () => {
				throw new Error("simulated index delete failure");
			};
			console.error = () => {};
			try {
				await runtime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "Dangling toolbar marker after retention.",
				});
				await service.flush();

				await runtime.resetConversation("new conversation requested");
				await service.flush();
			} finally {
				serviceMemoryStore(service).deleteBySourceUnsafe = originalDelete;
				console.error = originalConsoleError;
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}

			let lcmStore = LcmStore.open(config);
			try {
				assert.equal(lcmStore.listRecords().length, 0);
			} finally {
				lcmStore.close();
			}
			let memoryStore = MemoryIndexStore.open(config);
			try {
				assert.equal(memoryStore.searchLexical("toolbar", { corpus: LCM_RECORD_CORPUS }).length, 1);
			} finally {
				memoryStore.close();
			}

			const restarted = createMemoryService(config);
			try {
				memoryStore = MemoryIndexStore.open(config);
				try {
					assert.equal(memoryStore.searchLexical("toolbar", { corpus: LCM_RECORD_CORPUS }).length, 0);
				} finally {
					memoryStore.close();
				}
			} finally {
				restarted.close();
			}
			lcmStore = LcmStore.open(config);
			try {
				assert.equal(lcmStore.listSegments().filter((segment) => segment.status === "active").length, 1);
			} finally {
				lcmStore.close();
			}
		});
	});

});

function memoryLog() {
	const records: any[] = [];
	return {
		channel,
		dir: "memory",
		lockPath: "memory.lock",
		async read() {
			return records;
		},
		async append(record: any) {
			records.push(record);
		},
		async acquire() {},
		async release() {},
	};
}

function lcmCompactionConfig(baseConfig: Awaited<ReturnType<typeof memoryConfig>>) {
	return {
		...baseConfig,
		memory: {
			...baseConfig.memory,
			lcm: {
				...baseConfig.memory.lcm,
				enabled: true,
				freshTailCount: 1,
				leafChunkTokens: 23,
				leafTargetTokens: 8,
				maxRounds: 1,
			},
		},
	};
}

function lcmDebtConfig(baseConfig: Awaited<ReturnType<typeof memoryConfig>>) {
	return {
		...baseConfig,
		memory: {
			...baseConfig.memory,
			lcm: {
				...baseConfig.memory.lcm,
				enabled: true,
				freshTailCount: 1,
				leafChunkTokens: 2_000,
				leafTargetTokens: 1_000,
				maxRounds: 1,
			},
		},
	};
}

function debtMessages() {
	return [
		{ role: "user" as const, content: "old detail alpha ".repeat(300), timestamp: 10 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "old detail beta ".repeat(300) }],
			api: "test",
			provider: "test",
			model: "test",
			usage: zeroUsage(),
			stopReason: "stop" as const,
			timestamp: 11,
		},
		{ role: "user" as const, content: "fresh detail gamma", timestamp: 12 },
	];
}

function criticalDebtMessages() {
	return [
		{ role: "user" as const, content: "critical overflow alpha ".repeat(9000), timestamp: 20 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "critical overflow beta ".repeat(9000) }],
			api: "test",
			provider: "test",
			model: "test",
			usage: zeroUsage(),
			stopReason: "stop" as const,
			timestamp: 21,
		},
		{ role: "user" as const, content: "fresh critical tail", timestamp: 22 },
	];
}

function promptAwareMessages() {
	return [
		{ role: "user" as const, content: "rebar lattice beam splice detail ".repeat(8), timestamp: 30 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "rebar lattice footing cage detail ".repeat(8) }],
			api: "test",
			provider: "test",
			model: "test",
			usage: zeroUsage(),
			stopReason: "stop" as const,
			timestamp: 31,
		},
		{ role: "user" as const, content: "weather front barometer pressure ".repeat(8), timestamp: 32 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "weather rainfall humidity forecast ".repeat(8) }],
			api: "test",
			provider: "test",
			model: "test",
			usage: zeroUsage(),
			stopReason: "stop" as const,
			timestamp: 33,
		},
		{ role: "user" as const, content: "kanban schedule owner swimlane ".repeat(8), timestamp: 34 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "kanban schedule milestone review ".repeat(8) }],
			api: "test",
			provider: "test",
			model: "test",
			usage: zeroUsage(),
			stopReason: "stop" as const,
			timestamp: 35,
		},
		{ role: "user" as const, content: "What are the rebar lattice details?", timestamp: 36 },
	];
}

function fixedSummary(text: string): LcmSummarizer {
	return {
		async summarizeLeaf() {
			return `Files: none\n${text}\nExpand for details about: old chat wording`;
		},
	};
}

function additiveDebtMessages(freshTail: string) {
	const heavyText = "a".repeat(1482);
	return [
		{ role: "user" as const, content: heavyText, timestamp: 10 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: heavyText }],
			api: "test",
			provider: "test",
			model: "test",
			usage: zeroUsage(),
			stopReason: "stop" as const,
			timestamp: 11,
		},
		{ role: "user" as const, content: freshTail, timestamp: 12 },
	];
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	assert.equal(predicate(), true);
}

function serviceMemoryStore(service: ReturnType<typeof createMemoryService>): MemoryIndexStore & {
	deleteBySourceUnsafe(corpus: string, sourceId: string): void;
} {
	return (service as unknown as { memoryStore: MemoryIndexStore & { deleteBySourceUnsafe(corpus: string, sourceId: string): void } })
		.memoryStore;
}
