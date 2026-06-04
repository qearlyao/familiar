import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { HttpError } from "../src/web/http.js";
import { listWebDiaries, readWebDiary } from "../src/web/diary-routes.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function configWithDiaries(t: Parameters<typeof configWithDataDir>[0]) {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir);
	await mkdir(config.memory.diariesDir, { recursive: true });
	return config;
}

describe("web diary routes", () => {
	it("lists dated diary summaries newest first without full content", async (t) => {
		const config = await configWithDiaries(t);
		await writeFile(
			resolve(config.memory.diariesDir, "2026-06-03.md"),
			"# a small day\n\nwalked outside and wrote a little note.",
			"utf8",
		);
		await writeFile(resolve(config.memory.diariesDir, "not-a-diary.md"), "# skipped\n", "utf8");
		await writeFile(
			resolve(config.memory.diariesDir, "2026-06-04.md"),
			"---\nvalence: 0.4\n---\n# the newer room\n\nthis one should be first.",
			"utf8",
		);

		const diaries = await listWebDiaries(config);

		assert.equal(diaries.length, 2);
		assert.deepEqual(
			diaries.map((diary) => diary.date),
			["2026-06-04", "2026-06-03"],
		);
		assert.equal(diaries[0]?.title, "the newer room");
		assert.equal("content" in (diaries[0] ?? {}), false);
	});

	it("reads one dated diary with frontmatter stripped", async (t) => {
		const config = await configWithDiaries(t);
		await writeFile(
			resolve(config.memory.diariesDir, "2026-06-04.md"),
			"---\nheading: ignored by web reader\n---\n# written day\n\nhello from the diary.",
			"utf8",
		);

		const diary = await readWebDiary(config, "2026-06-04");

		assert.equal(diary.title, "written day");
		assert.equal(diary.content, "# written day\n\nhello from the diary.");
		assert.match(diary.excerpt, /hello from the diary/);
	});

	it("rejects non-date diary reads", async (t) => {
		const config = await configWithDiaries(t);

		await assert.rejects(() => readWebDiary(config, "../CONTACT"), {
			name: "HttpError",
			message: "diary date must be YYYY-MM-DD",
		});
	});

	it("returns 404 for missing dated diaries", async (t) => {
		const config = await configWithDiaries(t);

		await assert.rejects(() => readWebDiary(config, "2026-06-04"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 404);
			return true;
		});
	});
});
