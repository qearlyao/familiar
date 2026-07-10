import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Model } from "@earendil-works/pi-ai/compat";
import {
	clampConfiguredThinkingLevel,
	isThinkingLevel,
	supportedThinkingLevels,
} from "../src/models/index.js";

const model: Model<"openai-completions"> = {
	id: "mapped-thinking",
	name: "Mapped Thinking",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	thinkingLevelMap: { xhigh: null, max: "max" },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

describe("thinking levels", () => {
	it("follows upstream extended-level mappings", () => {
		assert.equal(isThinkingLevel("max"), true);
		assert.deepEqual(supportedThinkingLevels(model), ["off", "minimal", "low", "medium", "high", "max"]);
		assert.equal(clampConfiguredThinkingLevel(model, "xhigh"), "max");
	});
});
