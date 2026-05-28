import assert from "node:assert/strict";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import {
	browserScreenshotsDir,
	cleanupGeneratedAttachments,
	createGeneratedMediaSink,
	generatedAttachmentsDir,
	publicAttachmentPath,
} from "../src/generated-media.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("generated media", () => {
	it("drains generated attachments without leaking between prompts", () => {
		const sink = createGeneratedMediaSink();
		sink.add({ id: "one", name: "one.mp3" });

		assert.deepEqual(sink.drain(), [{ id: "one", name: "one.mp3" }]);
		assert.deepEqual(sink.drain(), []);
	});

	it("creates public URLs for generated attachment paths", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data");
		const localPath = resolve(generatedAttachmentsDir(config), "nested", "voice one.mp3");

		assert.equal(publicAttachmentPath(config, localPath), "/api/web/attachments/nested/voice%20one.mp3");
	});

	it("throws for paths outside the generated attachment directory", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data");

		assert.throws(() => publicAttachmentPath(config, "/tmp/outside.mp3"), /outside generated attachments dir/);
	});

	it("creates public URLs for browser screenshots", async (t) => {
		const config = await configWithDataDir(t, "/workspace/data");
		const localPath = resolve(browserScreenshotsDir(config), "screen one.png");

		assert.equal(publicAttachmentPath(config, localPath), "/api/web/attachments/screenshot/screen%20one.png");
	});

	it("removes generated attachments older than the retention window", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			media: { generatedRetentionDays: 30 },
		});
		const dir = generatedAttachmentsDir(config);
		await mkdir(dir, { recursive: true });
		const oldPath = join(dir, "old.mp3");
		const freshPath = join(dir, "fresh.mp3");
		await writeFile(oldPath, "old", "utf8");
		await writeFile(freshPath, "fresh", "utf8");
		const now = Date.parse("2026-05-07T00:00:00Z");
		await utimes(oldPath, new Date(now - 31 * 24 * 60 * 60 * 1000), new Date(now - 31 * 24 * 60 * 60 * 1000));
		await utimes(freshPath, new Date(now - 1 * 24 * 60 * 60 * 1000), new Date(now - 1 * 24 * 60 * 60 * 1000));

		const removed = await cleanupGeneratedAttachments(config, now);

		assert.equal(removed, 1);
		await assert.rejects(() => stat(oldPath), /ENOENT/);
		assert.equal((await stat(freshPath)).isFile(), true);
	});

	it("skips generated attachment cleanup when retention is disabled", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			media: { generatedRetentionDays: 0 },
		});
		const dir = generatedAttachmentsDir(config);
		await mkdir(dir, { recursive: true });
		const oldPath = join(dir, "old.mp3");
		await writeFile(oldPath, "old", "utf8");

		const removed = await cleanupGeneratedAttachments(config);

		assert.equal(removed, 0);
		assert.equal((await stat(oldPath)).isFile(), true);
	});
});
