import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { createWorkspace, minimalConfigToml } from "./helpers.js";

const execFileAsync = promisify(execFile);

it("exits with a failure when startup fails after opening the diary watcher", async (t) => {
	const workspacePath = await createWorkspace(t, minimalConfigToml());
	const env = { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_OAUTH_TOKEN: "" };
	await assert.rejects(
		execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "run", workspacePath], {
			cwd: resolve(import.meta.dirname, ".."),
			env,
			timeout: 15_000,
		}),
		(error: unknown) => {
			const result = error as Error & { code: number; killed: boolean; stdout: string; stderr: string };
			assert.equal(result.killed, false, "startup failure must exit on its own, not on timeout");
			assert.equal(result.code, 1);
			assert.match(result.stdout, /prompt files loaded/);
			assert.match(result.stderr, /Familiar command failed/);
			assert.match(result.stderr, /Missing API key for anthropic/);
			return true;
		},
	);
});

describe("CLI init", () => {
	it("prints top-level help", async () => {
		const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], {
			cwd: resolve(import.meta.dirname, ".."),
		});

		assert.equal(stderr, "");
		assert.match(stdout, /^Usage:/);
		assert.match(stdout, /familiar --help/);
		assert.match(stdout, /familiar --version/);
		assert.match(stdout, /familiar login \[provider\]/);
		assert.match(stdout, /familiar logout \[provider\]/);
		assert.match(stdout, /familiar update --models \[workspace\]/);
	});

	it("prints the package version", async () => {
		const root = resolve(import.meta.dirname, "..");
		const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { version: string };

		const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
			cwd: root,
		});

		assert.equal(stdout.trim(), packageJson.version);
	});

	it("copies default skills into the workspace", async (t) => {
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-init-"));
		t.after(() => rm(workspacePath, { recursive: true, force: true }));

		await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "init", workspacePath], {
			cwd: resolve(import.meta.dirname, ".."),
		});

		const skill = await readFile(resolve(workspacePath, "skills", "image-gen", "SKILL.md"), "utf8");
		const normalizedSkill = skill.replace(/\r\n/g, "\n");

		assert.match(normalizedSkill, /^---\nname: image-gen/m);
		assert.match(normalizedSkill, /Read this skill before using the image_gen tool/);
	});

	it("does not restore a default skill the agent deleted", async (t) => {
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-init-deleted-"));
		t.after(() => rm(workspacePath, { recursive: true, force: true }));
		const init = () =>
			execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "init", workspacePath], {
				cwd: resolve(import.meta.dirname, ".."),
			});

		await init();
		await rm(resolve(workspacePath, "skills", "inkbox-setup"), { recursive: true });
		await init();

		assert.equal(existsSync(resolve(workspacePath, "skills", "inkbox-setup")), false);
		assert.equal(existsSync(resolve(workspacePath, "skills", "image-gen", "SKILL.md")), true);
	});

	it("does not overwrite existing workspace files", async (t) => {
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-init-existing-"));
		t.after(() => rm(workspacePath, { recursive: true, force: true }));
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
