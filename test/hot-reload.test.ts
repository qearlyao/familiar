import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { __hotReloadTest, startWorkspaceHotReload } from "../src/lifecycle/hot-reload.js";

function waitForReload(timeoutMs = 1000): { promise: Promise<void>; resolve: () => void } {
	let resolveReload: () => void = () => undefined;
	const promise = new Promise<void>((resolveWait, rejectWait) => {
		const timeout = setTimeout(() => rejectWait(new Error("timed out waiting for hot reload")), timeoutMs);
		resolveReload = () => {
			clearTimeout(timeout);
			resolveWait();
		};
	});
	return { promise, resolve: resolveReload };
}

describe("workspace hot reload", () => {
	it("filters workspace files that should trigger reload", () => {
		const workspacePath = "/workspace";
		assert.equal(__hotReloadTest.shouldReloadForPath(workspacePath, "/workspace/config.toml"), true);
		assert.equal(__hotReloadTest.shouldReloadForPath(workspacePath, "/workspace/.env"), true);
		assert.equal(__hotReloadTest.shouldReloadForPath(workspacePath, "/workspace/SOUL.md"), true);
		assert.equal(__hotReloadTest.shouldReloadForPath(workspacePath, "/workspace/skills/image-style/SKILL.md"), true);
		assert.equal(__hotReloadTest.shouldReloadForPath(workspacePath, "/workspace/data/chat/log.jsonl"), false);
		assert.equal(__hotReloadTest.shouldReloadForPath(workspacePath, "/workspace/memories/index/memory.sqlite"), false);
		assert.equal(__hotReloadTest.shouldReloadForPath(workspacePath, "/outside/config.toml"), false);
	});

	it("debounces watched workspace changes into one reload", async () => {
		const watched = new Map<string, (eventType: string, filename: string | Buffer | null) => void>();
		const reloads: string[] = [];
		const { promise: reloadPromise, resolve: resolveReload } = waitForReload();
		const workspacePath = resolve(tmpdir(), "familiar-hot-reload-workspace");
		const skillPath = resolve(workspacePath, "skills", "image-style");
		const hotReload = startWorkspaceHotReload({
			workspacePath,
			debounceMs: 5,
			familiarAgent: {
				async reload() {
					reloads.push("reload");
					resolveReload();
					return "ok";
				},
			},
			watch(path, _options, listener) {
				watched.set(path, listener);
				return Object.assign(new EventEmitter(), { close() {} });
			},
			async listSkillDirectories() {
				return [skillPath];
			},
			logger: { info() {}, warn() {}, error() {} },
		});

		await Promise.resolve();
		watched.get(workspacePath)?.("change", "config.toml");
		watched.get(workspacePath)?.("change", ".env");
		watched.get(skillPath)?.("change", "SKILL.md");
		await reloadPromise;
		hotReload.close();

		assert.equal(reloads.length, 1);
		assert.ok(watched.has(workspacePath));
		assert.ok(watched.has(resolve(workspacePath, "skills")));
		assert.ok(watched.has(skillPath));
	});

	it("lists immediate skill directories and ignores missing skills dir", async () => {
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-hot-reload-"));
		try {
			assert.deepEqual(await __hotReloadTest.listSkillDirectories(resolve(workspacePath, "skills")), []);
			await mkdir(resolve(workspacePath, "skills", "image-style"), { recursive: true });
			await mkdir(resolve(workspacePath, "skills", "nested", "child"), { recursive: true });
			await writeFile(resolve(workspacePath, "skills", "README.md"), "# notes\n", "utf8");

			const dirs = await __hotReloadTest.listSkillDirectories(resolve(workspacePath, "skills"));
			assert.deepEqual(
				dirs.sort(),
				[
					resolve(workspacePath, "skills", "image-style"),
					resolve(workspacePath, "skills", "nested"),
					resolve(workspacePath, "skills", "nested", "child"),
				].sort(),
			);
		} finally {
			await rm(workspacePath, { recursive: true, force: true });
		}
	});
});
