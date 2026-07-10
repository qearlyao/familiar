import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FamiliarAgent } from "../src/agent/factory.js";
import { createAgentWorkQueue } from "../src/runtime/agent-work-queue.js";
import type { ConversationRuntime } from "../src/runtime/conversation-runtime.js";

describe("agent work queue", () => {
	it("passes raw inbound text separately for ambient recall", async () => {
		let receivedInput: string | undefined;
		let receivedAmbientQuery: string | undefined;
		const promptFn: FamiliarAgent["prompt"] = async (_sessionKey, input, _images, _onEvent, options) => {
			receivedInput = input;
			receivedAmbientQuery = options?.ambientQuery;
			return { text: "ok", attachments: [] };
		};
		const familiarAgent = { prompt: promptFn } as unknown as FamiliarAgent;
		const runtime = {
			channelKey: "web-web-owner",
			hasActiveJob: () => true,
			ambientQueryForActiveJob: () => "mornig",
		} as unknown as ConversationRuntime;
		const queue = createAgentWorkQueue({ familiarAgent });
		const modelPrompt = "[qearlyao uid:owner @ 2026-05-09 11:34:16 GMT+8] mornig";

		await queue.promptForRuntime(runtime, "job-1", modelPrompt);

		assert.equal(receivedInput, modelPrompt);
		assert.equal(receivedAmbientQuery, "mornig");
	});
});
