import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { buildRecordBase, type ChatChannelRef } from "../src/chat-log.js";
import { MemoryIndexStore } from "../src/memory/index/store.js";
import { LCM_RECORD_CORPUS } from "../src/memory/lcm/indexer.js";
import { createMemoryService, __memoryServiceTest } from "../src/memory/service.js";
import { LcmStore } from "../src/memory/lcm/store.js";
import type { LcmSummarizer } from "../src/memory/lcm/summarizer.js";
import { ConversationRuntime } from "../src/runtime.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function memoryConfig() {
	const dataDir = await createTempDataDir();
	const memoryRootDir = await mkdtemp(resolve(tmpdir(), "familiar-memory-service-"));
	return configWithDataDir(dataDir, {
		memory: {
			rootDir: memoryRootDir,
			indexDir: resolve(memoryRootDir, "index"),
			lcmDir: resolve(memoryRootDir, "lcm"),
			diariesDir: resolve(memoryRootDir, "diaries"),
			archiveDir: resolve(memoryRootDir, "archive"),
			embedding: {
				api: "gemini",
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

		const next = __memoryServiceTest.injectAmbientDiaryRecall(messages, "[Familiar diary recall]\n1. 2026-05-10: warm");

		assert.deepEqual(messages[0], next[0]);
		const last = next[2];
		assert.equal(last?.role, "user");
		assert.equal(Array.isArray(last?.content), true);
		assert.match(Array.isArray(last?.content) ? (last.content.at(-1) as { text: string }).text : "", /diary recall/);
	});

	it("recalls indexed diary chunks through transformContext", async () => {
		const config = await memoryConfig();
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
			const service = createMemoryService(config);
			try {
				const [message] = await service.transformContext([
					{ role: "user", content: "blue lantern", timestamp: Date.now() },
				]);
				assert.equal(message?.role, "user");
				assert.match(typeof message?.content === "string" ? message.content : "", /Familiar diary recall/);
				assert.match(typeof message?.content === "string" ? message.content : "", /blue lantern/);
			} finally {
				service.close();
			}
		});
	});

	it("projects runtime records into LCM and rotates segments on reset", async () => {
		const baseConfig = await memoryConfig();
		const config = {
			...baseConfig,
			memory: { ...baseConfig.memory, lcm: { ...baseConfig.memory.lcm, newSessionRetainDepth: -1 } },
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
			try {
				await runtime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "Remember the compact toolbar.",
				});
					await runtime.noteOutbound({ text: "I will remember the compact toolbar.", messageIds: ["m2"] });
				await runtime.resetConversation("new conversation requested");
				await service.flush();

				const lcmStore = LcmStore.open(config);
				try {
					const records = lcmStore.listRecords();
					assert.deepEqual(
						records.map((record) => record.kind),
						["user", "assistant", "boundary"],
					);
					assert.equal(lcmStore.listSegments().some((segment) => segment.status === "closed"), true);
					} finally {
					lcmStore.close();
				}
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("clears persisted LCM context items when runtime segment rotates on reset", async () => {
		const baseConfig = await memoryConfig();
		const config = {
			...baseConfig,
			memory: { ...baseConfig.memory, lcm: { ...baseConfig.memory.lcm, newSessionRetainDepth: -1 } },
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
			try {
				await runtime.ingestInbound({
					messageId: "m1",
					authorId: "owner",
					text: "Remember the compact toolbar.",
				});
				await service.flush();

				const lcmStoreBeforeReset = LcmStore.open(config);
				try {
					const recordId = lcmStoreBeforeReset.listRecords()[0]?.id;
					assert.ok(recordId);
					lcmStoreBeforeReset.replaceContextItems("web-web-room", [
						{
							type: "raw",
							recordId,
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

				const lcmStoreAfterReset = LcmStore.open(config);
				try {
					assert.equal(lcmStoreAfterReset.listContextItems("web-web-room").length, 0);
				} finally {
					lcmStoreAfterReset.close();
				}
			} finally {
				unsubscribe();
				await runtime.disconnect();
				service.close();
			}
		});
	});

	it("continues segment IDs after restart instead of reusing closed segments", async () => {
		const baseConfig = await memoryConfig();
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

	it("removes pruned LCM records from the shared memory index on reset", async () => {
		const baseConfig = await memoryConfig();
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

				const lcmStore = LcmStore.open(config);
				try {
					assert.deepEqual(lcmStore.listRecords(), []);
				} finally {
					lcmStore.close();
				}

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

	it("automatically summarizes old LCM context once it exceeds the leaf trigger", async () => {
		const baseConfig = await memoryConfig();
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
			const service = createMemoryService(config, { summarizer });
			try {
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
				assert.match(contentText(first[0]), /Familiar retained LCM summary/);
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

				const lcmStore = LcmStore.open(config);
				try {
					const summaries = lcmStore.listSummaries();
					assert.equal(summaries.length, 1);
					assert.match(summaries[0]?.text ?? "", /old alpha and beta/);
					assert.ok(summaries[0]?.coversFromRecordId);
					assert.ok(summaries[0]?.coversToRecordId);
					assert.ok(lcmStore.getRecord(summaries[0]?.coversFromRecordId as number));
					assert.ok(lcmStore.getRecord(summaries[0]?.coversToRecordId as number));
					const sources = lcmStore.getSummarySources(summaries[0]?.id as number);
					assert.equal(sources.length, 2);
					assert.equal(sources.every((source) => source.recordId !== null), true);
					for (const source of sources) assert.ok(lcmStore.getRecord(source.recordId as number));
				} finally {
					lcmStore.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("defers LCM compaction debt while cache is hot", async () => {
		const baseConfig = await memoryConfig();
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
			const service = createMemoryService(config, { summarizer, now: () => now });
			try {
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

				const store = LcmStore.open(config);
				try {
					assert.equal(store.listSummaries().length, 0);
					assert.ok((store.getSessionState("room-hot-defer")?.compactionDebt ?? 0) > 0);
				} finally {
					store.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("services LCM compaction debt once cache is cold", async () => {
		const baseConfig = await memoryConfig();
		const config = lcmDebtConfig(baseConfig);
		let now = 100_000;
		let calls = 0;
		const summarizer: LcmSummarizer = {
			async summarizeLeaf() {
				calls += 1;
				return "Files: none\nCold-cache pressure was compacted.\nExpand for details about: old chat wording";
			},
		};

		await withEmbeddingFetch([1, 0, 0], async () => {
			const service = createMemoryService(config, { summarizer, now: () => now });
			try {
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

				const store = LcmStore.open(config);
				try {
					assert.equal(store.listSummaries().length, 1);
					assert.equal(store.getSessionState("room-cold-service")?.compactionDebt, 0);
				} finally {
					store.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("forces LCM compaction during critical overflow even when cache is hot", async () => {
		const baseConfig = await memoryConfig();
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
			const service = createMemoryService(config, { summarizer, now: () => now });
			try {
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

				const store = LcmStore.open(config);
				try {
					assert.equal(store.listSummaries().length, 1);
					assert.ok((store.getSessionState("room-critical-overflow")?.compactionDebt ?? 0) < config.memory.lcm.criticalOverflowTokens);
				} finally {
					store.close();
				}
			} finally {
				service.close();
			}
		});
	});

	it("persists deferred LCM compaction debt across restart", async () => {
		const baseConfig = await memoryConfig();
		const config = lcmDebtConfig(baseConfig);
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
				await service.transformContext([debtMessages().at(-1)!], undefined, {
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
				assert.equal(store.getSessionState("room-debt-restart")?.compactionDebt, 0);
				assert.equal(store.listSummaries().length, 1);
			} finally {
				store.close();
			}
		});
	});

	it("clears deferred LCM compaction debt when runtime segment rotates on reset", async () => {
		const baseConfig = await memoryConfig();
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

	it("serviceCompactionDebt forces LCM compaction while cache is hot", async () => {
		const baseConfig = await memoryConfig();
		const config = lcmDebtConfig(baseConfig);
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

	it("rehydrates persisted LCM summary after restart when runtime sends only the fresh tail", async () => {
		const baseConfig = await memoryConfig();
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
				assert.match(contentText(afterRestart[0]), /Familiar retained LCM summary/);
				assert.match(contentText(afterRestart[0]), /old alpha and beta/);
				assert.doesNotMatch(renderMessages(afterRestart), /old detail alpha/);
				assert.doesNotMatch(renderMessages(afterRestart), /old detail beta/);
				assert.match(contentText(afterRestart[1]), /fresh detail gamma/);
			} finally {
				service.close();
			}
		});
	});

	it("preserves rehydrated LCM summary before a different fresh tail after restart", async () => {
		const baseConfig = await memoryConfig();
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
				assert.match(contentText(afterRestart[0]), /Familiar retained LCM summary/);
				assert.match(contentText(afterRestart[0]), /old alpha and beta/);
				assert.match(contentText(afterRestart[1]), /brand new tail delta/);
				assert.doesNotMatch(renderMessages(afterRestart), /fresh detail gamma/);
			} finally {
				service.close();
			}
		});
	});

	it("summary over span with tool_call record includes tool markers in rendered input", async () => {
		const baseConfig = await memoryConfig();
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
			const service = createMemoryService(config, { summarizer });
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
							content: [{ type: "text" as const, text: "structured reconstruction TODO" }],
							details: { text: "structured reconstruction TODO" },
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
				assert.match(renderedInput, /structured reconstruction TODO/);
			} finally {
				service.close();
			}
		});
	});

	it("prompt-aware LCM compaction skips records relevant to the last user message", async () => {
		const baseConfig = await memoryConfig();
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

	it("falls back to oldest-first LCM compaction when prompt-aware eviction is disabled", async () => {
		const baseConfig = await memoryConfig();
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

	it("reconciles shared-index rows left behind after LCM retention committed", async () => {
		const baseConfig = await memoryConfig();
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

	it("drops persisted LCM raw context item with missing record during rehydrate", async () => {
		const baseConfig = await memoryConfig();
		const config = lcmCompactionConfig(baseConfig);
		const store = LcmStore.open(config);
		try {
			const recordId = store.insertRecord({
				segmentId: "room-missing-record:seg-1",
				kind: "user",
				text: "orphaned raw context",
				happenedAt: "2026-05-10T01:00:00.000Z",
				channelKey: "room-missing-record",
				source: { sourceType: "manual", sourceRef: "runtime:orphan" },
			});
			store.replaceContextItems("room-missing-record", [
				{
					type: "raw",
					recordId,
					fingerprint: "runtime:orphan",
					happenedAt: "2026-05-10T01:00:00.000Z",
				},
			]);
			store.db.pragma("foreign_keys = OFF");
			store.db.prepare("DELETE FROM lcm_records WHERE id = ?").run(recordId);
			store.db.pragma("foreign_keys = ON");
		} finally {
			store.close();
		}

		const originalConsoleError = console.error;
		const errors: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		try {
			await withEmbeddingFetch([1, 0, 0], async () => {
				const service = createMemoryService(config, { summarizer: fixedSummary("unused") });
				try {
					const rendered = await service.transformContext(
						[{ role: "user" as const, content: "fresh after orphan", timestamp: 2 }],
						undefined,
						{ sessionKey: "room-missing-record", sessionId: "session-a", model: { contextWindow: 10_000 } as any },
					);
					assert.equal(rendered.length, 1);
					assert.match(contentText(rendered[0]), /fresh after orphan/);
				} finally {
					service.close();
				}
			});
		} finally {
			console.error = originalConsoleError;
		}
		assert.equal(
			errors.some((args) => String(args[0]).includes("record") && String(args[0]).includes("missing")),
			true,
		);
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

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function contentText(message: unknown): string {
	if (!message) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function renderMessages(messages: unknown[]): string {
	return messages.map(contentText).join("\n");
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

function serviceMemoryStore(service: ReturnType<typeof createMemoryService>): MemoryIndexStore & {
	deleteBySourceUnsafe(corpus: string, sourceId: string): void;
} {
	return (service as unknown as { memoryStore: MemoryIndexStore & { deleteBySourceUnsafe(corpus: string, sourceId: string): void } })
		.memoryStore;
}
