import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { condense, renderCondensedSummariesForContext } from "../src/memory/lcm/condense.js";
import { LcmContextTransformer } from "../src/memory/lcm/context-transformer.js";
import { LcmSegmentManager } from "../src/memory/lcm/segment-manager.js";
import { LcmStore } from "../src/memory/lcm/store.js";
import type { LcmSummarizer } from "../src/memory/lcm/summarizer.js";
import type { LcmSummaryParentSnapshot, LcmSourceProvenance } from "../src/memory/lcm/types.js";

async function tempDbPath(): Promise<string> {
	const dir = await mkdtemp(resolve(tmpdir(), "familiar-lcm-condense-"));
	return resolve(dir, "memories", "lcm", "lcm.sqlite");
}

const source: LcmSourceProvenance = {
	sourceType: "chat",
	sourceRef: "chat:test",
};

describe("LCM condense", () => {
	it("drives 4 leaf-summary-triggering compactions in one segment; asserts a depth-2 summary is auto-created with 4 leaves as parents and covering range = union of child ranges", async () => {
		const store = new LcmStore({ path: await tempDbPath() });
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

	it("rendered context shows depth-2 summary instead of four depth-1 children (no double-count)", async () => {
		const store = new LcmStore({ path: await tempDbPath() });
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

	it("newSessionRetainDepth:2 end-to-end: build leaves + condensed depth-2 summary, close segment, retain; depth=2 survives with snapshot_json containing pruned children snapshots collapsed in", async () => {
		const store = new LcmStore({ path: await tempDbPath() });
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

	it("context transformer condenses after four runtime leaf summaries and renders the promoted summary", async () => {
		const store = new LcmStore({ path: await tempDbPath() });
		const segmentManager = new LcmSegmentManager({
			lcmStore: store,
			memoryStore: nullMemoryStore(),
			indexer: nullIndexer(),
			newSessionRetainDepth: 2,
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
			const text = rendered.map(contentText).join("\n");

			assert.match(text, /runtime depth two summary/);
			assert.doesNotMatch(text, /leaf summary for old detail 0[\s\S]*leaf summary for old detail 3/);
			assert.equal(store.listSummaries("room-runtime:seg-1").filter((summary) => summary.depth === 2).length, 1);
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

function contentText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}
