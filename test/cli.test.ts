import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);

describe("CLI init", () => {
	it("copies default skills into the workspace", async () => {
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-init-"));

		await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "init", workspacePath], {
			cwd: resolve(import.meta.dirname, ".."),
		});

		const skill = await readFile(resolve(workspacePath, "skills", "image-gen", "SKILL.md"), "utf8");

		assert.match(skill, /^---\nname: image-gen/m);
		assert.match(skill, /Read this skill before using the image_gen tool/);
	});

	it("does not overwrite existing workspace files", async () => {
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-init-existing-"));
		const configPath = resolve(workspacePath, "config.toml");
		const soulPath = resolve(workspacePath, "SOUL.md");
		await writeFile(configPath, "custom config\n", "utf8");
		await writeFile(soulPath, "custom soul\n", "utf8");

		await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "init", workspacePath], {
			cwd: resolve(import.meta.dirname, ".."),
		});

		assert.equal(await readFile(configPath, "utf8"), "custom config\n");
		assert.equal(await readFile(soulPath, "utf8"), "custom soul\n");
		assert.match(await readFile(resolve(workspacePath, ".env"), "utf8"), /DISCORD_TOKEN/);
	});
});
