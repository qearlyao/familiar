import assert from "node:assert/strict";
import { it } from "node:test";
import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { estimateAgentMessageTokens } from "../src/memory/lcm/context.js";
import { LcmContextTransformer } from "../src/memory/lcm/context-transformer.js";
import { LcmStore } from "../src/memory/lcm/store.js";
import type { LcmSegmentManager } from "../src/memory/lcm/segment-manager.js";
import type { ChunkIndexer } from "../src/memory/index/chunk-indexer.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

it("counts only selected context, separates fresh messages, and clears unavailable snapshots", async (t) => {
	const dir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dir);
	const store = new LcmStore({ path: resolve(dir, "lcm.sqlite") });
	t.after(() => store.close());
	const settings = { ...config.memory.lcm, enabled: true, freshTailCount: 1, leafChunkTokens: 1_000_000, maxRounds: 0 };
	const unexpectedSummary = async (): Promise<string> => {
		throw new Error("unexpected summary");
	};
	const transformer = new LcmContextTransformer({
		settings,
		lcmStore: store,
		indexer: {} as ChunkIndexer,
		summarizer: { summarizeLeaf: unexpectedSummary, summarizeCondensed: unexpectedSummary },
		segmentManager: { activeSegmentId: () => "room:seg-1" } as unknown as LcmSegmentManager,
	});
	const messages = [
		{ role: "user" as const, content: "older ".repeat(100), timestamp: 1 },
		{ role: "user" as const, content: "fresh", timestamp: 2 },
	];
	assert.equal(transformer.getContextBreakdown("room"), undefined);
	await transformer.transformLcmContext(messages, undefined, { sessionKey: "room" });
	assert.deepEqual(transformer.getContextBreakdown("room"), {
		summaries: 0, pending: estimateAgentMessageTokens(messages[0]), fresh: estimateAgentMessageTokens(messages[1]), other: 0,
	});
	const selected = await transformer.transformLcmContext(messages, undefined, {
		sessionKey: "room", model: { contextWindow: 50 } as Model<any>,
	});
	assert.deepEqual(selected, [messages[1]]);
	transformer.recordAdditionalContextTokens("room", 31);
	assert.deepEqual(transformer.getContextBreakdown("room"), {
		summaries: 0, pending: 0, fresh: estimateAgentMessageTokens(messages[1]), other: 31,
	});
	settings.enabled = false;
	assert.equal(transformer.getContextBreakdown("room"), undefined);
	settings.enabled = true;
	transformer.invalidateSession("room");
	assert.equal(transformer.getContextBreakdown("room"), undefined);
});
