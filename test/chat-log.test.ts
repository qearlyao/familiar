import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ChatLogRecord, createChatLog } from "../src/conversation/chat-log.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("chat log", () => {
	it("keeps concurrent large appends as separate JSONL records", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const log = createChatLog(config, { service: "web", scope: "web", channelId: "owner" });
		const payload = "x".repeat(5 * 1024 * 1024);
		const records: ChatLogRecord[] = Array.from({ length: 6 }, (_, index) => ({
			type: "error",
			recordId: index + 1,
			ts: new Date(Date.UTC(2026, 6, 17, 0, 0, index)).toISOString(),
			service: "web",
			scope: "web",
			channelId: "owner",
			message: `${index}:${payload}`,
		}));

		await Promise.all(records.map((record) => log.append(record)));

		const stored = await log.read();
		assert.deepEqual(
			stored.map((record) => record.recordId),
			records.map((record) => record.recordId),
		);
	});
});
