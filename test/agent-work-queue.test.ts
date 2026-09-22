import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { FamiliarAgent } from "../src/agent/factory.js";
import { createAgentWorkQueue } from "../src/runtime/agent-work-queue.js";
import { HEARTBEAT_SKIPPED } from "../src/runtime/turn.js";
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
			notesForActiveJob: () => [],
		} as unknown as ConversationRuntime;
		const queue = createAgentWorkQueue({ familiarAgent });
		const modelPrompt = "[qearlyao uid:owner @ 2026-05-09 11:34:16 GMT+8] mornig";

		await queue.promptForRuntime(runtime, "job-1", modelPrompt);

		assert.equal(receivedInput, modelPrompt);
		assert.equal(receivedAmbientQuery, "mornig");
	});

	it("hands a kept call waiting since the last turn to a scheduled turn, once", async () => {
		const call = "(we were on a voice call for a minute)";
		let receivedNotes: string[] | undefined;
		let notedThrough: number | undefined;
		const promptMessage: FamiliarAgent["promptMessage"] = async (_sessionKey, _message, _onEvent, options) => {
			receivedNotes = options?.notes;
			return { text: "ok", attachments: [] };
		};
		const familiarAgent = { promptMessage } as unknown as FamiliarAgent;
		const runtime = {
			channelKey: "web-web-owner",
			pendingCallNotes: () => ({ texts: [call], throughRecordId: 7 }),
			noteCallsDelivered: async (through: number) => {
				notedThrough = through;
			},
		} as unknown as ConversationRuntime;
		const queue = createAgentWorkQueue({ familiarAgent });
		const heartbeat: AgentMessage = { role: "user", content: [{ type: "text", text: "<heartbeat/>" }], timestamp: 1 };

		const reply = await queue.promptScheduledMessage(runtime, () => heartbeat);

		assert.deepEqual(receivedNotes, [call]);
		assert.equal(notedThrough, 7);
		assert.equal(typeof reply === "symbol" ? undefined : reply.text, "ok");

		// a turn that decides not to fire leaves the call waiting
		notedThrough = undefined;
		assert.equal(await queue.promptScheduledMessage(runtime, () => HEARTBEAT_SKIPPED), HEARTBEAT_SKIPPED);
		assert.equal(notedThrough, undefined);
	});
});
