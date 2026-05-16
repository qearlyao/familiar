import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { describe, it } from "node:test";

import { __browserToolsTest, createBrowserTools, type BrowserCommandResult } from "../src/browser-tools.js";
import { createGeneratedMediaSink } from "../src/generated-media.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function textFrom(result: Awaited<ReturnType<ReturnType<typeof createBrowserTools>[number]["execute"]>>): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

describe("browser tools", () => {
	it("does not register when disabled", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir);

		assert.deepEqual(createBrowserTools(config, createGeneratedMediaSink()), []);
	});

	it("loads browser defaults and allowlisted recurring sites", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, {
			browser: {
				enabled: true,
			},
		});

		assert.equal(config.browser.backend, "opencli");
		assert.equal(config.browser.command, "opencli");
		assert.equal(config.browser.session, "familiar");
		assert.equal(config.browser.windowMode, "background");
		assert.equal(config.browser.readWrite, false);
		assert.ok(config.browser.allowedSites.twitter.read.includes("timeline"));
		assert.ok(config.browser.allowedSites.reddit.read.includes("saved"));
		assert.ok(config.browser.allowedSites.spotify.read.includes("status"));
	});

	it("builds OpenCLI page args with positional session", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, {
			browser: {
				enabled: true,
				session: "familiar-main",
				profile: "work",
				windowMode: "foreground",
			},
		});

		assert.deepEqual(
			await __browserToolsTest.buildPageArgs({ mode: "page", action: "open", url: "https://example.com" }, config),
			["--profile", "work", "browser", "familiar-main", "open", "https://example.com", "--window", "foreground"],
		);
		assert.deepEqual(await __browserToolsTest.buildPageArgs({ mode: "page", action: "state" }, config), [
			"--profile",
			"work",
			"browser",
			"familiar-main",
			"state",
			"--window",
			"foreground",
		]);
	});

	it("omits window mode from lifecycle commands", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, readWrite: true } });

		assert.deepEqual(await __browserToolsTest.buildPageArgs({ mode: "page", action: "close" }, config), [
			"browser",
			"familiar",
			"close",
		]);
		assert.deepEqual(await __browserToolsTest.buildPageArgs({ mode: "page", action: "bind" }, config), [
			"browser",
			"familiar",
			"bind",
		]);
	});

	it("blocks write-like page actions until read_write is enabled", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });

		await assert.rejects(
			() => __browserToolsTest.buildPageArgs({ mode: "page", action: "click", target: "1" }, config),
			/browser\.read_write/,
		);
		await assert.rejects(
			() => __browserToolsTest.buildPageArgs({ mode: "page", action: "eval", text: "document.cookie" }, config),
			/browser\.read_write/,
		);
		await assert.rejects(
			() => __browserToolsTest.buildPageArgs({ mode: "page", action: "close" }, config),
			/browser\.read_write/,
		);
	});

	it("builds allowlisted site adapter commands as JSON", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });

		assert.deepEqual(
			__browserToolsTest.buildSiteArgs(
				{ mode: "site", site: "reddit", command: "saved", args: { limit: 5 } },
				config,
			),
			["reddit", "saved", "--limit", "5", "-f", "json"],
		);
		assert.throws(
			() => __browserToolsTest.buildSiteArgs({ mode: "site", site: "reddit", command: "upvote" }, config),
			/not allowlisted/,
		);
		assert.throws(
			() => __browserToolsTest.buildSiteArgs({ mode: "site", site: "reddit", command: "saved", args: { limit: "-1" } }, config),
			/may not start/,
		);
	});

	it("executes through injected runner and returns bounded content/details", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, maxOutputChars: 1200 } });
		const calls: string[][] = [];
		const runner = async (args: string[]): Promise<BrowserCommandResult> => {
			calls.push(args);
			return {
				ok: true,
				backend: "opencli",
				command: ["opencli", ...args],
				exitCode: 0,
				stdout: JSON.stringify({ title: "Example", url: "https://example.com" }),
				stderr: "",
				json: { title: "Example", url: "https://example.com" },
				truncated: false,
			};
		};
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), runner);

		const result = await tool.execute("call-1", { mode: "page", action: "state" });

		assert.deepEqual(calls[0], ["browser", "familiar", "state", "--window", "background"]);
		assert.match(textFrom(result), /untrusted_browser_content/);
		assert.equal(result.details?.ok, true);
		assert.deepEqual(result.details?.json, { title: "Example", url: "https://example.com" });
	});

	it("lists configured site commands without shelling out", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async () => {
			throw new Error("runner should not be called");
		});

		const result = await tool.execute("call-1", { mode: "list_commands", site: "twitter" });

		assert.match(textFrom(result), /twitter/);
		assert.match(textFrom(result), /timeline/);
	});

	it("lists all configured site commands without a site filter", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async () => {
			throw new Error("runner should not be called");
		});

		const result = await tool.execute("call-1", { mode: "list_commands" });

		assert.match(textFrom(result), /twitter/);
		assert.match(textFrom(result), /reddit/);
		assert.match(textFrom(result), /spotify/);
	});

	it("returns non-zero exits and truncates long command output", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, maxOutputChars: 1000 } });
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (args) => ({
			ok: false,
			backend: "opencli",
			command: ["opencli", ...args],
			exitCode: 69,
			stdout: "x".repeat(1500),
			stderr: "extension disconnected",
			truncated: false,
		}));

		const result = await tool.execute("call-1", { mode: "page", action: "state" });

		assert.match(textFrom(result), /OpenCLI failed \(exit 69\)/);
		assert.match(textFrom(result), /\.\.\.$/);
		assert.equal(result.details?.ok, false);
		assert.equal(result.details?.truncated, true);
	});

	it("stores screenshots under the Familiar screenshot bucket and adds them to the media sink", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });
		const sink = createGeneratedMediaSink();
		const [tool] = createBrowserTools(config, sink, async (args) => {
			const screenshotPath = __browserToolsTest.screenshotPathFromCommand(["opencli", ...args]);
			assert.ok(screenshotPath);
			await mkdir(resolve(screenshotPath, ".."), { recursive: true });
			await writeFile(screenshotPath, "png");
			return {
				ok: true,
				backend: "opencli",
				command: ["opencli", ...args],
				exitCode: 0,
				stdout: `Screenshot saved to: ${screenshotPath}`,
				stderr: "",
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", { mode: "page", action: "screenshot", path: "/tmp/model-picked.png" });
		const attachment = sink.drain()[0];

		assert.ok(attachment?.localPath);
		assert.ok(attachment.localPath.startsWith(resolve(homedir(), ".familiar", "data", "attachments", "screenshot")));
		assert.equal((await stat(attachment.localPath)).isFile(), true);
		assert.equal(result.details?.attachmentName, basename(attachment.localPath));
		assert.doesNotMatch(textFrom(result), /model-picked/);
	});
});
