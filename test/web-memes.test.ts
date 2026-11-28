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

	it("parses meme families from markdown with links from any host", () => {
		const families = parseMemeCatalog(`# How to Use
- not a meme — https://example.com/outside-a-family.png

## Cute
- cat smile — https://files.catbox.moe/cat.png
- typed with a hyphen - https://i.imgur.com/abc123.gif
- en dash – https://i.postimg.cc/x/y.webp?raw=1
- half-hearted - shrug — https://example.com/shrug.jpg
- bare suffix — rhd5nr.jpg

## Empty
- nothing here
`);

		assert.deepEqual(families, [
			{
				name: "Cute",
				memes: [
					{ name: "cat smile", url: "https://files.catbox.moe/cat.png" },
					{ name: "typed with a hyphen", url: "https://i.imgur.com/abc123.gif" },
					{ name: "en dash", url: "https://i.postimg.cc/x/y.webp?raw=1" },
					{ name: "half-hearted - shrug", url: "https://example.com/shrug.jpg" },
				],
			},
		]);
	});
});
