import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");

describe("install scripts", () => {
	it("prints shell installer help", async () => {
		const { stdout } = await execFileAsync("sh", ["scripts/install.sh", "--help"], { cwd: repoRoot });

		assert.match(stdout, /Usage: install\.sh/);
		assert.match(stdout, /--package <spec>/);
		assert.match(stdout, /trusted specs only/);
	});
});
