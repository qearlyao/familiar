import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("install scripts", () => {
	it("keeps the publishable shrinkwrap aligned with the source lock", async () => {
		const [sourceLock, shrinkwrap] = await Promise.all([
			readFile(resolve(repoRoot, "package-lock.json"), "utf8"),
			readFile(resolve(repoRoot, "npm-shrinkwrap.json"), "utf8"),
		]);

		assert.equal(shrinkwrap, sourceLock);
	});

	it("prints shell installer help", async () => {
		const { stdout } = await execFileAsync("sh", ["scripts/install.sh", "--help"], { cwd: repoRoot });

		assert.match(stdout, /Usage: install\.sh/);
		assert.match(stdout, /--package <spec>/);
		assert.match(stdout, /--install-browser-deps/);
		assert.match(stdout, /trusted specs only/);
	});

	it("runs init even when the workspace already has a config file", async (t) => {
		const root = await mkdtemp(resolve(tmpdir(), "familiar-installer-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const binDir = resolve(root, "bin");
		const workspace = resolve(root, "workspace");
		await mkdir(binDir, { recursive: true });
		await mkdir(workspace, { recursive: true });
		await writeFile(resolve(workspace, "config.toml"), "[agent]\n", "utf8");
		await writeFile(
			resolve(binDir, "node"),
			"#!/usr/bin/env sh\nif [ \"$1\" = \"-p\" ]; then echo 24; else echo v24.0.0; fi\n",
			"utf8",
		);
		await writeFile(resolve(binDir, "npm"), "#!/usr/bin/env sh\nexit 0\n", "utf8");
		await writeFile(
			resolve(binDir, "familiar"),
			`#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${resolve(root, "familiar-args.log")}"\n`,
			"utf8",
		);
		await Promise.all([
			chmod(resolve(binDir, "node"), 0o755),
			chmod(resolve(binDir, "npm"), 0o755),
			chmod(resolve(binDir, "familiar"), 0o755),
		]);

		const { stdout } = await execFileAsync(
			"sh",
			["scripts/install.sh", "--workspace", workspace, "--package", "@qearlyao/familiar@local-test"],
			{
				cwd: repoRoot,
				env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
			},
		);

		assert.match(stdout, /Initializing or refreshing workspace defaults/);
		assert.match(await readFile(resolve(root, "familiar-args.log"), "utf8"), new RegExp(`init ${escapeRegExp(workspace)}`));
	});
});
