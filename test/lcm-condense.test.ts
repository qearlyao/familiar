import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { condense, renderCondensedSummariesForContext } from "../src/memory/lcm/condense.js";
import { LcmContextTransformer } from "../src/memory/lcm/context-transformer.js";
import { LcmSegmentManager } from "../src/memory/lcm/segment-manager.js";
import { LcmStore } from "../src/memory/lcm/store.js";
import type { LcmSummarizer } from "../src/memory/lcm/summarizer.js";
import type { LcmSummaryParentSnapshot } from "../src/memory/lcm/types.js";
import { renderMessages, testLcmSource as source } from "./memory-fakes.js";

async function tempDbPath(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-lcm-condense-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return resolve(dir, "memories", "lcm", "lcm.sqlite");
}

describe("LCM condense", () => {
	it("drives 4 leaf-summary-triggering compactions in one segment; asserts a depth-2 summary is auto-created with 4 leaves as parents and covering range = union of child ranges", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		try {
			const segmentId = "seg-condense";
			const leafIds: number[] = [];
			for (let index = 0; index < 4; index += 1) {
				const recordId = store.insertRecord({
					segmentId,
					kind: "user",
					text: `leaf source ${index}`,
					happenedAt: `2026-05-10T01:0${index}:00.000Z`,
					source,
				});
				leafIds.push(
					store.insertSummary({
						segmentId,
						depth: 1,
						status: "ready",
						text: `leaf summary ${index}`,
						coversFromRecordId: recordId,
						coversToRecordId: recordId,
						source,
					}),
				);
			}
			const summarizer: LcmSummarizer = {
				async summarizeLeaf() {
					throw new Error("expected summarizeCondensed");
				},
				async summarizeCondensed(input) {
					assert.equal(input.childSummaryCount, 4);
					assert.equal(input.depth, 2);
					assert.match(input.text, /leaf summary 0/);
					assert.match(input.text, /leaf summary 3/);
					return "depth two condensed summary";
				},
			};

			const created = await condense({
				segmentId,
				depth: 1,
				store,
				summarizer,
				config: { condenseGroupSize: 4, maxSummaryDepth: 4, leafTargetTokens: 100 },
			});

			assert.equal(created.length, 1);
			const parent = created[0];
			assert.equal(parent?.depth, 2);
			assert.deepEqual(parent?.parents, leafIds);
			assert.equal(parent?.coversFromRecordId, 1);
			assert.equal(parent?.coversToRecordId, 4);
			assert.equal(store.listSummaries(segmentId).length, 5);
		} finally {
			store.close();
		}
	});

	it("continues condensing parented summaries into deeper DAG levels", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		try {
			const segmentId = "seg-deep-condense";
			for (let index = 0; index < 16; index += 1) {
				const recordId = store.insertRecord({
					segmentId,
					kind: "user",
					text: `deep source ${index}`,
					happenedAt: `2026-05-10T01:${String(index).padStart(2, "0")}:00.000Z`,
					source,
				});
				store.insertSummary({
					segmentId,
					depth: 1,
					status: "ready",
					text: `leaf summary ${index}`,
					coversFromRecordId: recordId,
					coversToRecordId: recordId,
					source,
				});
			}
			const summarizer: LcmSummarizer = {
				async summarizeLeaf() {
					throw new Error("expected summarizeCondensed");
				},
				async summarizeCondensed(input) {
					return `depth ${input.depth} from ${input.childSummaryCount} children`;
				},
			};

			const created = await condense({
				segmentId,
				depth: 1,
				store,
				summarizer,
				config: { condenseGroupSize: 4, maxSummaryDepth: 3, leafTargetTokens: 100 },
			});

			assert.equal(created.filter((summary) => summary.depth === 2).length, 4);
			const depthThree = created.filter((summary) => summary.depth === 3);
			assert.equal(depthThree.length, 1);
			assert.equal(depthThree[0]?.parents.length, 4);
			assert.match(depthThree[0]?.text ?? "", /depth 3/);
		} finally {
			store.close();
		}
	});

	it("passes human-readable time ranges into condensed summary prompts", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		try {
			const segmentId = "seg-condense-time-range";
			for (let index = 0; index < 4; index += 1) {
				const happenedAt = `2026-05-10T01:${String(index).padStart(2, "0")}:00.000Z`;
				const recordId = store.insertRecord({
					segmentId,
					kind: "user",
					text: `timed source ${index}`,
					happenedAt,
					source,
				});
				store.insertSummary({
					segmentId,
					depth: 1,
					status: "ready",
					text: `timed summary ${index}`,
					coversFromRecordId: recordId,
					coversToRecordId: recordId,
					source,
					metadata: { coverageFromHappenedAt: happenedAt, coverageToHappenedAt: happenedAt },
				});
			}
			let condensedInput = "";
			await condense({
				segmentId,
				depth: 1,
				store,
				summarizer: {
					async summarizeLeaf(input) {
						condensedInput = input.text;
						return "condensed timed summaries";
					},
				},
				config: { condenseGroupSize: 4, maxSummaryDepth: 2, leafTargetTokens: 100 },
			});

			assert.match(condensedInput, /\[time_range 2026-05-10T01:00:00\.000Z - 2026-05-10T01:00:00\.000Z\]/);
		} finally {
			store.close();
		}
	});

	it("rendered context shows depth-2 summary instead of four depth-1 children (no double-count)", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		try {
			const segmentId = "seg-render";
			const leaves = Array.from({ length: 4 }, (_, index) =>
				store.insertSummary({
					segmentId,
					depth: 1,
					status: "ready",
					text: `leaf ${index}`,
					source,
				}),
			);
			store.insertSummary({
				segmentId,
				depth: 2,
				status: "ready",
				text: "condensed depth two",
				source,
				parents: leaves,
			});

			const rendered = renderCondensedSummariesForContext(store.listSummaries(segmentId));

			assert.deepEqual(
				rendered.map((summary) => ({ depth: summary.depth, text: summary.text })),
				[{ depth: 2, text: "condensed depth two" }],
			);
		} finally {
			store.close();
		}
	});

	it("newSessionRetainDepth:2 end-to-end: build leaves + condensed depth-2 summary, close segment, retain; depth=2 survives with snapshot_json containing pruned children snapshots collapsed in", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		try {
			const segmentId = "seg-retain";
			const leaves: number[] = [];
			for (let index = 0; index < 4; index += 1) {
				const recordId = store.insertRecord({
					segmentId,
					kind: index % 2 === 0 ? "user" : "assistant",
					text: `raw retained detail ${index}`,
					happenedAt: `2026-05-10T01:0${index}:00.000Z`,
					source,
				});
				leaves.push(
					store.insertSummary({
						segmentId,
						depth: 1,
						status: "ready",
						text: `leaf retained detail ${index}`,
						coversFromRecordId: recordId,
						coversToRecordId: recordId,
						source,
					}),
				);
			}
			const parentId = store.insertSummary({
				segmentId,
				depth: 2,
				status: "ready",
				text: "depth two survives",
				coversFromRecordId: 1,
				coversToRecordId: 4,
				source,
				parents: leaves,
			});
			store.closeSegment(segmentId, "2026-05-10T02:00:00.000Z");

			store.applyNewSessionRetention({ newSessionRetainDepth: 2 });

			assert.deepEqual(store.listRecords(segmentId), []);
			assert.deepEqual(store.listSummaries(segmentId).map((summary) => summary.id), [parentId]);
			const parent = store.getSummary(parentId);
			assert.equal(parent?.depth, 2);
			const collapsed = parent?.snapshot as LcmSummaryParentSnapshot[] | null;
			assert.equal(collapsed?.length, 4);
			assert.deepEqual(
				collapsed?.map((item) => item.text),
				["leaf retained detail 0", "leaf retained detail 1", "leaf retained detail 2", "leaf retained detail 3"],
			);
			assert.deepEqual(
				collapsed?.map((item) => item.snapshot?.[0]?.text),
				["raw retained detail 0", "raw retained detail 1", "raw retained detail 2", "raw retained detail 3"],
			);
		} finally {
			store.close();
		}
	});

	it("context transformer condenses after four runtime leaf summaries and renders the promoted summary", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		const segmentManager = new LcmSegmentManager({
			lcmStore: store,
			memoryStore: nullMemoryStore(),
			indexer: nullIndexer(),
			newSessionRetainDepth: () => 2,
		});
		const summarizer: LcmSummarizer = {
			async summarizeLeaf(input) {
				if (input.text.includes("<summary")) return "runtime depth two summary";
				return `leaf summary for ${input.text.match(/old detail \d/)?.[0] ?? "old detail"}`;
			},
		};
		let now = 100_000;
		const transformer = new LcmContextTransformer({
			settings: {
				enabled: true,
				contextThreshold: 0.75,
				freshTailCount: 1,
				leafChunkTokens: 6,
				leafTargetTokens: 8,
				condenseGroupSize: 4,
				maxSummaryDepth: 4,
				maxRounds: 1,
				cacheTtlMs: 300_000,
				cacheTouchSlackMs: 30_000,
				criticalOverflowTokens: 8000,
				promptAwareEvictionEnabled: true,
			},
			lcmStore: store,
			indexer: nullIndexer(),
			summarizer,
			segmentManager,
			now: () => now,
		});
		try {
			const messages: AgentMessage[] = [];
			for (let index = 0; index < 5; index += 1) {
				now += 300_000;
				messages.push({ role: "user", content: `old detail ${index} ${"x".repeat(40)}`, timestamp: index + 1 });
				await transformer.transformLcmContext([...messages], undefined, {
					sessionKey: "room-runtime",
					sessionId: "session-runtime",
					model: { contextWindow: 10_000 } as any,
				});
			}

			const rendered = await transformer.transformLcmContext(messages, undefined, {
				sessionKey: "room-runtime",
				sessionId: "session-runtime",
				model: { contextWindow: 10_000 } as any,
			});
			const text = renderMessages(rendered);

			assert.match(text, /runtime depth two summary/);
			assert.doesNotMatch(text, /leaf summary for old detail 0[\s\S]*leaf summary for old detail 3/);
			assert.equal(store.listSummaries("room-runtime:seg-1").filter((summary) => summary.depth === 2).length, 1);
		} finally {
			store.close();
		}
	});

	it("does not persist runtime condensed summaries when live parents are not contiguous", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		const segmentManager = new LcmSegmentManager({
			lcmStore: store,
			memoryStore: nullMemoryStore(),
			indexer: nullIndexer(),
			newSessionRetainDepth: () => 2,
		});
		let condensedCalls = 0;
		let now = 100_000;
		const transformer = new LcmContextTransformer({
			settings: {
				enabled: true,
				contextThreshold: 0.75,
				freshTailCount: 1,
				leafChunkTokens: 6,
				leafTargetTokens: 8,
				condenseGroupSize: 4,
				maxSummaryDepth: 4,
				maxRounds: 1,
				cacheTtlMs: 300_000,
				cacheTouchSlackMs: 30_000,
				criticalOverflowTokens: 8000,
				promptAwareEvictionEnabled: true,
			},
			lcmStore: store,
			indexer: nullIndexer(),
			summarizer: {
				async summarizeLeaf(input) {
					if (input.text.includes("<summary")) {
						condensedCalls += 1;
						return "should not condense non-contiguous runtime parents";
					}
					return `leaf summary for ${input.text.match(/old detail \d/)?.[0] ?? "old detail"}`;
				},
			},
			segmentManager,
			now: () => now,
		});
		try {
			const history: AgentMessage[] = [];
			for (let index = 0; index < 2; index += 1) {
				now += 300_000;
				history.push({ role: "user", content: `old detail ${index} ${"x".repeat(40)}`, timestamp: index + 1 });
				await transformer.transformLcmContext([...history], undefined, {
					sessionKey: "room-noncontiguous",
					sessionId: "session-runtime",
					model: { contextWindow: 10_000 } as any,
				});
			}

			const strayRecord = store.insertRecord({
				segmentId: "room-noncontiguous:seg-1",
				kind: "user",
				text: "stray source",
				happenedAt: "2026-05-10T01:00:00.000Z",
				source,
			});
			store.insertSummary({
				segmentId: "room-noncontiguous:seg-1",
				depth: 1,
				status: "ready",
				text: "stray stored summary",
				coversFromRecordId: strayRecord,
				coversToRecordId: strayRecord,
				source,
			});

			now += 300_000;
			history.push({ role: "user", content: `old detail 2 ${"x".repeat(40)}`, timestamp: 3 });
			await transformer.transformLcmContext(history, undefined, {
				sessionKey: "room-noncontiguous",
				sessionId: "session-runtime",
				model: { contextWindow: 10_000 } as any,
			});

			assert.equal(condensedCalls, 0);
			assert.equal(store.listSummaries("room-noncontiguous:seg-1").filter((summary) => summary.depth === 2).length, 0);
		} finally {
			store.close();
		}
	});

	it("rehydrated condensed summary covers parent raw sources after restart", async (t) => {
		const store = new LcmStore({ path: await tempDbPath(t) });
		let now = 100_000;
		const createTransformer = () =>
			new LcmContextTransformer({
				settings: {
					enabled: true,
					contextThreshold: 0.75,
					freshTailCount: 1,
					leafChunkTokens: 6,
					leafTargetTokens: 8,
					condenseGroupSize: 4,
					maxSummaryDepth: 4,
					maxRounds: 1,
					cacheTtlMs: 300_000,
					cacheTouchSlackMs: 30_000,
					criticalOverflowTokens: 8000,
					promptAwareEvictionEnabled: true,
				},
				lcmStore: store,
				indexer: nullIndexer(),
				summarizer: {
					async summarizeLeaf(input) {
						if (input.text.includes("<summary")) return "condensed coverage survives restart";
						return `leaf summary for ${input.text.match(/old detail \d/)?.[0] ?? "old detail"}`;
					},
				},
				segmentManager: new LcmSegmentManager({
					lcmStore: store,
					memoryStore: nullMemoryStore(),
					indexer: nullIndexer(),
					newSessionRetainDepth: () => 2,
				}),
				now: () => now,
			});
		try {
			let transformer = createTransformer();
			const history: AgentMessage[] = [];
			for (let index = 0; index < 5; index += 1) {
				now += 300_000;
				history.push({ role: "user", content: `old detail ${index} ${"x".repeat(40)}`, timestamp: index + 1 });
				await transformer.transformLcmContext([...history], undefined, {
					sessionKey: "room-runtime-restart",
					sessionId: "session-runtime",
					model: { contextWindow: 10_000 } as any,
				});
			}
			assert.equal(store.listSummaries("room-runtime-restart:seg-1").filter((summary) => summary.depth === 2).length, 1);

			transformer = createTransformer();
			const afterRestart = await transformer.transformLcmContext(
				[...history, { role: "user", content: "fresh detail after restart", timestamp: 6 }],
				undefined,
				{
					sessionKey: "room-runtime-restart",
					sessionId: "session-runtime",
					model: { contextWindow: 10_000 } as any,
				},
			);
			const text = renderMessages(afterRestart);

			assert.match(text, /condensed coverage survives restart/);
			for (let index = 0; index < 4; index += 1) assert.doesNotMatch(text, new RegExp(`old detail ${index}`));
			assert.match(text, /old detail 4/);
			assert.match(text, /fresh detail after restart/);
		} finally {
			store.close();
		}
	});
});

function nullIndexer() {
	return {
		async indexChunks() {
			return { inserted: 0, updated: 0, deleted: 0 };
		},
		async deleteSourceIds() {
			return 0;
		},
	} as any;
}

function nullMemoryStore() {
	return {
		deleteSourceIds() {
			return 0;
		},
	} as any;
}
