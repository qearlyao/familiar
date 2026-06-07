import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { generatedAttachmentsDir } from "../src/media/generated-media.js";
import { listWebGallery, writeWebGalleryNote } from "../src/web/gallery-routes.js";
import { HttpError } from "../src/web/http.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function configWithGeneratedAttachments(t: Parameters<typeof configWithDataDir>[0]) {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir);
	await mkdir(generatedAttachmentsDir(config), { recursive: true });
	return config;
}

describe("web gallery routes", () => {
	it("lists generated images and audio with stored notes", async (t) => {
		const config = await configWithGeneratedAttachments(t);
		const dir = generatedAttachmentsDir(config);
		await writeFile(resolve(dir, "voice.mp3"), "audio", "utf8");
		await writeFile(resolve(dir, "drawing.png"), "image", "utf8");
		await writeFile(resolve(dir, "notes.txt"), "skip", "utf8");
		await writeWebGalleryNote(config, "voice.mp3", "kept sound");

		const items = await listWebGallery(config);

		assert.deepEqual(
			items.map((item) => item.id).sort(),
			["drawing.png", "voice.mp3"],
		);
		assert.equal(items.find((item) => item.id === "voice.mp3")?.note, "kept sound");
	});

	it("writes notes only for existing generated media items", async (t) => {
		const config = await configWithGeneratedAttachments(t);
		const dir = generatedAttachmentsDir(config);
		await mkdir(resolve(dir, "nested"), { recursive: true });
		await writeFile(resolve(dir, "nested", "voice.wav"), "audio", "utf8");

		const note = await writeWebGalleryNote(config, "nested/voice.wav", "inside");

		assert.equal(note, "inside");
		const item = (await listWebGallery(config)).find((entry) => entry.id === "nested/voice.wav");
		assert.equal(item?.note, "inside");
	});

	it("removes stored notes when the new note is empty", async (t) => {
		const config = await configWithGeneratedAttachments(t);
		const dir = generatedAttachmentsDir(config);
		await writeFile(resolve(dir, "voice.mp3"), "audio", "utf8");
		await writeWebGalleryNote(config, "voice.mp3", "temporary");

		await writeWebGalleryNote(config, "voice.mp3", "");

		assert.equal((await listWebGallery(config)).find((item) => item.id === "voice.mp3")?.note, "");
	});

	it("rejects notes for missing, non-media, and non-canonical gallery ids", async (t) => {
		const config = await configWithGeneratedAttachments(t);
		const dir = generatedAttachmentsDir(config);
		await writeFile(resolve(dir, "voice.mp3"), "audio", "utf8");
		await writeFile(resolve(dir, "notes.txt"), "text", "utf8");

		await assert.rejects(() => writeWebGalleryNote(config, "missing.mp3", "nope"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 404);
			return true;
		});
		await assert.rejects(() => writeWebGalleryNote(config, "notes.txt", "nope"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 404);
			return true;
		});
		await assert.rejects(() => writeWebGalleryNote(config, "../voice.mp3", "nope"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 400);
			return true;
		});
		await assert.rejects(() => writeWebGalleryNote(config, "nested/../voice.mp3", "nope"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 400);
			return true;
		});
		assert.equal(await readFile(resolve(dir, "voice.mp3"), "utf8"), "audio");
	});
});
