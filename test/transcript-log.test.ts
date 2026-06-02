import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadStoredMessages } from "../src/agent/transcript-log.js";
import { createTempDataDir } from "./helpers.js";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("transcript log", () => {
	it("skips superseded assistant messages on replay", async (t) => {
		const dataDir = await createTempDataDir(t);
		const transcriptsDir = resolve(dataDir, "transcripts");
		await mkdir(transcriptsDir, { recursive: true });
		const user: AgentMessage = { role: "user", content: "retry this", timestamp: 1 };
		const firstAssistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "first" }],
			api: "responses",
			provider: "openai",
			model: "gpt-5.5",
			stopReason: "stop",
			usage,
			timestamp: 2,
		};
		const secondAssistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "second" }],
			api: "responses",
			provider: "openai",
			model: "gpt-5.5",
			stopReason: "stop",
			usage,
			timestamp: 3,
		};
		const lines = [
			{ ts: "2026-06-01T00:00:00.000Z", sessionId: "s1", message: user },
			{ ts: "2026-06-01T00:00:01.000Z", sessionId: "s1", message: firstAssistant },
			{ ts: "2026-06-01T00:00:02.000Z", sessionId: "s1", type: "supersede", messageTimestamp: 2 },
			{ ts: "2026-06-01T00:00:03.000Z", sessionId: "s1", message: secondAssistant },
		];
		await writeFile(resolve(transcriptsDir, "2026-06-01.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const messages = await loadStoredMessages(dataDir, "s1");

		assert.deepEqual(messages.map((message) => message.timestamp), [1, 3]);
	});
});
