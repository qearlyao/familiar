import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { atomicWriteJson } from "../src/util/fs.js";
import { createTempDataDir } from "./helpers.js";

describe("util/fs", () => {
	it("atomically writes formatted json through a temp file", async (t) => {
		const dir = await createTempDataDir(t);
		const path = resolve(dir, "settings", "state.json");

		await atomicWriteJson(path, { value: "first" });
		await atomicWriteJson(path, { value: "second" });

		assert.equal(await readFile(path, "utf8"), '{\n  "value": "second"\n}\n');
		assert.deepEqual(
			(await readdir(resolve(dir, "settings"))).filter((entry) => entry.endsWith(".tmp")),
			[],
		);
	});
});
