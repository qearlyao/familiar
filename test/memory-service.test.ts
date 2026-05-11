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

function contentText(message: { content?: unknown } | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function serviceMemoryStore(service: ReturnType<typeof createMemoryService>): MemoryIndexStore & {
	deleteBySourceUnsafe(corpus: string, sourceId: string): void;
} {
	return (service as unknown as { memoryStore: MemoryIndexStore & { deleteBySourceUnsafe(corpus: string, sourceId: string): void } })
		.memoryStore;
}
