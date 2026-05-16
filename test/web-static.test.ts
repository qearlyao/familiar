import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";

import { generatedAttachmentsDir } from "../src/generated-media.js";
import { serveAttachment } from "../src/web-static.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

class FakeResponse {
	statusCode?: number;
	headers?: Record<string, string>;
	body = "";

	writeHead(statusCode: number, headers: Record<string, string>): void {
		this.statusCode = statusCode;
		this.headers = headers;
	}

	write(chunk: string | Buffer): void {
		this.body += chunk.toString();
	}

	end(chunk?: string | Buffer): void {
		if (chunk) this.write(chunk);
	}

	on(): this {
		return this;
	}

	once(): this {
		return this;
	}

	emit(): boolean {
		return true;
	}
}

describe("serveAttachment", () => {
	it("serves generated audio files", async () => {
		const root = await createTempDataDir();
		const config = await configWithDataDir(root);
		const dir = generatedAttachmentsDir(config);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "voice.mp3"), "audio", "utf8");
		const response = new FakeResponse();

		const handled = await serveAttachment(config, response as any, "/api/web/attachments/voice.mp3");

		assert.equal(handled, true);
		assert.equal(response.statusCode, 200);
		assert.equal(response.headers?.["content-type"], "audio/mpeg");
	});

	it("serves browser screenshot files", async () => {
		const root = await createTempDataDir();
		const config = await configWithDataDir(root);
		const dir = resolve(homedir(), ".familiar", "data", "attachments", "screenshot");
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		await writeFile(resolve(dir, "screen.png"), "png", "utf8");
		const response = new FakeResponse();

		const handled = await serveAttachment(config, response as any, "/api/web/attachments/screenshot/screen.png");

		assert.equal(handled, true);
		assert.equal(response.statusCode, 200);
		assert.equal(response.headers?.["content-type"], "image/png");
	});

	it("rejects traversal attempts", async () => {
		const root = await createTempDataDir();
		const config = await configWithDataDir(root);
		await mkdir(generatedAttachmentsDir(config), { recursive: true });
		const response = new FakeResponse();

		await serveAttachment(config, response as any, "/api/web/attachments/../secret.mp3");

		assert.equal(response.statusCode, 403);
	});

	it("rejects symlinks inside the generated attachment directory", async () => {
		const root = await createTempDataDir();
		const config = await configWithDataDir(root);
		const dir = generatedAttachmentsDir(config);
		await mkdir(dir, { recursive: true });
		const target = join(root, "outside.mp3");
		await writeFile(target, "outside", "utf8");
		await symlink(target, join(dir, "link.mp3"));
		const response = new FakeResponse();

		await serveAttachment(config, response as any, "/api/web/attachments/link.mp3");

		assert.equal(response.statusCode, 403);
	});
});
