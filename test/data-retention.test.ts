import assert from "node:assert/strict";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

import { runDataRetention } from "../src/lifecycle/data-retention.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("data retention", () => {
	it("removes old data files and keeps recent files by category", async (t) => {
		const dataDir = await createTempDataDir(t);
		const oldDate = new Date("2026-04-11T00:00:00.000Z");
		const recentDate = new Date("2026-05-10T00:00:00.000Z");
		const now = Date.parse("2026-05-11T00:00:00.000Z");
		const files = {
			chatOld: resolve(dataDir, "chat", "room", "old.jsonl"),
			chatRecent: resolve(dataDir, "chat", "room", "recent.jsonl"),
			transcriptOld: resolve(dataDir, "transcripts", "old.jsonl"),
			transcriptRecent: resolve(dataDir, "transcripts", "recent.jsonl"),
			payloadOld: resolve(dataDir, "payloads", "old.json"),
			payloadRecent: resolve(dataDir, "payloads", "recent.json"),
		};
		for (const path of Object.values(files)) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, "x", "utf8");
		}
		for (const path of [files.chatOld, files.transcriptOld, files.payloadOld]) await utimes(path, oldDate, oldDate);
		for (const path of [files.chatRecent, files.transcriptRecent, files.payloadRecent]) {
			await utimes(path, recentDate, recentDate);
		}
		const config = await configWithDataDir(t, dataDir, {
			data: {
				chat: { retentionDays: 14 },
				transcripts: { retentionDays: 14 },
				payloads: { retentionDays: 14 },
			},
		});

		const report = await runDataRetention(config, now);

		assert.deepEqual(report, { chat: 1, transcripts: 1, payloads: 1 });
		await assert.rejects(() => stat(files.chatOld), /ENOENT/);
		await assert.rejects(() => stat(files.transcriptOld), /ENOENT/);
		await assert.rejects(() => stat(files.payloadOld), /ENOENT/);
		await stat(files.chatRecent);
		await stat(files.transcriptRecent);
		await stat(files.payloadRecent);
	});
});
