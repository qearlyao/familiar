import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { startWorkspaceHotReload } from "../src/lifecycle/hot-reload.js";
import { createTempDataDir } from "./helpers.js";

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

function settle(ms = 50): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function startWithFakeWatch(t: TestContext, workspacePath: string) {
	const watched = new Map<string, WatchListener>();
	const reloads: string[] = [];
	const hotReload = startWorkspaceHotReload({
		workspacePath,
		debounceMs: 5,
		familiarAgent: {
			async reload() {
				return "ok";
			},
		},
		watch(path, _options, listener) {
			watched.set(path, listener);
			return Object.assign(new EventEmitter(), { close() {} });
		},
		logger: {
			info(message: string) {
				reloads.push(message.replace(/^hot reload complete after /, "").split("\n")[0] ?? "");
			},
			warn() {},
			error() {},
		},
	});
	t.after(() => hotReload.close());
	return { watched, reloads };
}

describe("workspace hot reload", () => {
	it("reloads for workspace config, prompt files, and skills but not runtime data", async (t) => {
		const workspacePath = await createTempDataDir(t);
		const skillPath = resolve(workspacePath, "skills", "image-style");
		await mkdir(skillPath, { recursive: true });
		const { watched, reloads } = startWithFakeWatch(t, workspacePath);
		await settle();

		watched.get(workspacePath)?.("change", "data");
		watched.get(workspacePath)?.("change", "memories");
		watched.get(workspacePath)?.("change", "notes.txt");
		await settle();
		assert.deepEqual(reloads, []);

		watched.get(workspacePath)?.("change", "SOUL.md");
		await settle();
		watched.get(skillPath)?.("change", "SKILL.md");
		await settle();
		assert.deepEqual(reloads, ["SOUL.md", join("skills", "image-style", "SKILL.md")]);
	});

	it("debounces watched workspace changes into one reload", async (t) => {
		const workspacePath = await createTempDataDir(t);
		const skillPath = resolve(workspacePath, "skills", "image-style");
		await mkdir(skillPath, { recursive: true });
		const { watched, reloads } = startWithFakeWatch(t, workspacePath);
		await settle();

		watched.get(workspacePath)?.("change", "config.toml");
		watched.get(workspacePath)?.("change", ".env");
		watched.get(skillPath)?.("change", "SKILL.md");
		await settle();

		assert.equal(reloads.length, 1);
	});

	it("watches nested skill directories once they appear", async (t) => {
		const workspacePath = await createTempDataDir(t);
		const skillsPath = resolve(workspacePath, "skills");
		const { watched } = startWithFakeWatch(t, workspacePath);
		await settle();
		assert.deepEqual([...watched.keys()].sort(), [workspacePath, skillsPath].sort());

		await mkdir(resolve(skillsPath, "image-style"), { recursive: true });
		await mkdir(resolve(skillsPath, "nested", "child"), { recursive: true });
		await writeFile(resolve(skillsPath, "README.md"), "# notes\n", "utf8");
		watched.get(skillsPath)?.("rename", "nested");
		await settle();

		assert.deepEqual(
			[...watched.keys()].sort(),
			[
				workspacePath,
				skillsPath,
				resolve(skillsPath, "image-style"),
				resolve(skillsPath, "nested"),
				resolve(skillsPath, "nested", "child"),
			].sort(),
		);
	});
});
