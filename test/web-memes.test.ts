import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chdir, cwd } from "node:process";
import { describe, it } from "node:test";

import { memeCatalogPath, parseMemeCatalog } from "../src/web/memes.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

describe("web meme catalog pathing", () => {
	it("resolves the meme catalog from the workspace root", async (t) => {
		const previousCwd = cwd();
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);
		try {
			chdir("/");

			assert.equal(memeCatalogPath(config), resolve(config.workspacePath, "skills", "memes", "SKILL.md"));
		} finally {
			chdir(previousCwd);
		}
	});

	it("parses meme families from markdown", () => {
		const families = parseMemeCatalog(`## Cute
- cat smile — cute/cat.png
`);

		assert.deepEqual(families, [
			{
				name: "Cute",
				memes: [{ name: "cat smile", url: "https://files.catbox.moe/cute/cat.png" }],
			},
		]);
	});
});
