import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { getContactNickname } from "../src/conversation/contact-note.js";
import { HttpError } from "../src/web/http.js";
import { listWebFiles, readWebFile, writeWebFile } from "../src/web/file-routes.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function configWithWorkspace(t: Parameters<typeof configWithDataDir>[0]) {
	const dataDir = await createTempDataDir(t);
	return configWithDataDir(t, dataDir);
}

describe("web file routes", () => {
	it("lists the companion files in their room order", async (t) => {
		const config = await configWithWorkspace(t);
		await writeFile(resolve(config.workspacePath, "HEARTBEAT.md"), "# Heartbeat\n", "utf8");
		await writeFile(resolve(config.workspacePath, "CONTACT.md"), "q\n", "utf8");

		const files = await listWebFiles(config);

		assert.deepEqual(
			files.map((file) => file.name),
			["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "CONTACT.md"],
		);
		assert.equal(files.every((file) => file.exists), true);
		assert.equal(files[0]?.title, "soul");
		assert.equal(files[3]?.description, "what they do when the room gets quiet");
	});
	it("reads missing allowlisted files as empty editable notes", async (t) => {
		const config = await configWithWorkspace(t);

		const file = await readWebFile(config, "contact");

		assert.equal(file.name, "CONTACT.md");
		assert.equal(file.exists, false);
		assert.equal(file.content, "");
		assert.equal(file.mtimeMs, null);
	});

	it("writes only allowlisted files and refreshes the contact nickname", async (t) => {
		const config = await configWithWorkspace(t);

		const file = await writeWebFile(config, "contact", "darling\n");

		assert.equal(file.exists, true);
		assert.equal(file.content, "darling\n");
		assert.equal(await readFile(resolve(config.workspacePath, "CONTACT.md"), "utf8"), "darling\n");
		assert.equal(getContactNickname("you"), "darling");
	});

	it("rejects unknown file ids", async (t) => {
		const config = await configWithWorkspace(t);

		await assert.rejects(() => readWebFile(config, "../SOUL.md"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 400);
			assert.equal((error as Error).message, "unknown file: ../SOUL.md");
			return true;
		});
	});
});
