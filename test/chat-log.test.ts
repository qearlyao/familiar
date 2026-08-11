import assert from "node:assert/strict";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { type ChatLogRecord, createChatLog } from "../src/conversation/chat-log.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("chat log", () => {
	it("rejects a second live lease and preserves the owner diagnostic", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const channel = { service: "web", scope: "web", channelId: "owner" } as const;
		const first = createChatLog(config, channel);
		const second = createChatLog(config, channel);
		t.after(() => Promise.all([first.release(), second.release()]));

		await first.acquire("familiar-111-web-web-owner");
		await assert.rejects(second.acquire("familiar-222-web-web-owner"), /already locked by familiar-111-web-web-owner/);
		await first.release();
		await second.acquire("familiar-222-web-web-owner");
	});

	it("reclaims an aged lease without trusting its recorded PID", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const channel = { service: "discord", scope: "dm", channelId: "dm-1" } as const;
		const log = createChatLog(config, channel);
		t.after(() => log.release());

		await mkdir(log.lockPath, { recursive: true });
		await writeFile(log.lockPath + ".owner", `familiar-${process.pid}-discord-dm-dm-1\n`, "utf8");
		const staleAt = new Date(Date.now() - 60_000);
		await utimes(log.lockPath, staleAt, staleAt);

		await log.acquire("familiar-333-discord-dm-dm-1");
		assert.equal((await stat(log.lockPath)).isDirectory(), true);
		assert.equal(await readFile(log.lockPath + ".owner", "utf8"), "familiar-333-discord-dm-dm-1\n");
	});

	it("reclaims a v0.8.1 legacy file lock whose owner is gone", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const log = createChatLog(config, { service: "discord", scope: "dm", channelId: "dm-2" });
		t.after(() => log.release());
		await mkdir(dirname(log.lockPath), { recursive: true });
		await writeFile(log.lockPath, "familiar-2147483646-discord-dm-dm-2\n", "utf8");

		await log.acquire("familiar-444-discord-dm-dm-2");
		assert.equal((await stat(log.lockPath)).isDirectory(), true);
	});

	it("refuses a v0.8.1 legacy file lock whose owner is still running", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		const log = createChatLog(config, { service: "discord", scope: "dm", channelId: "dm-3" });
		await mkdir(dirname(log.lockPath), { recursive: true });
		await writeFile(log.lockPath, `familiar-${process.pid}-discord-dm-dm-3\n`, "utf8");

		await assert.rejects(log.acquire("familiar-555-discord-dm-dm-3"), /already locked by familiar-/);
	});

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
