import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { describe, it } from "node:test";

import {
	__browserToolsTest,
	createBrowserTools,
	type BrowserCommandResult,
	type BrowserRunSpec,
} from "../src/browser-tools.js";
import { browserScreenshotsDir, createGeneratedMediaSink } from "../src/generated-media.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function textFrom(result: Awaited<ReturnType<ReturnType<typeof createBrowserTools>[number]["execute"]>>): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

function siteHelp(site: string, commands: Array<{ name: string; access: string; description?: string }> = []) {
	return {
		site,
		commands: commands.map((command) => ({ ...command, usage: `opencli ${site} ${command.name}` })),
	};
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
		assert.equal(config.browser.opencliCommand, "opencli");
		assert.equal(config.browser.harnessCommand, "browser-harness");
		assert.equal(config.browser.session, "familiar");
		assert.equal(config.browser.windowMode, "background");
		assert.equal(config.browser.readWrite, false);
		assert.equal(config.browser.allowedSites.twitter, true);
		assert.equal(config.browser.allowedSites.reddit, true);
		assert.equal(config.browser.allowedSites.youtube, true);
		assert.equal(config.browser.allowedSites.spotify, true);
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
			["--profile", "work", "browser", "familiar-main", "--window", "foreground", "open", "https://example.com"],
		);
		assert.deepEqual(await __browserToolsTest.buildPageArgs({ mode: "page", action: "state" }, config), [
			"--profile",
			"work",
			"browser",
			"familiar-main",
			"--window",
			"foreground",
			"state",
		]);
	});

	it("passes browser timeout through to OpenCLI internals", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, {
			browser: {
				enabled: true,
				timeoutMs: 120_000,
			},
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "opencli",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: "{}",
				stderr: "",
				json: {},
				truncated: false,
			};
		});

		await tool.execute("call-1", { mode: "page", action: "state" });

		assert.equal(calls[0]?.env?.OPENCLI_BROWSER_COMMAND_TIMEOUT, "120");
	});

	it("spawns browser helpers through cmd.exe on Windows", () => {
		const spec: BrowserRunSpec = {
			command: "C:\\Users\\C\\AppData\\Roaming\\npm\\opencli.cmd",
			args: ["reddit", "saved", "--window", "background", "-f", "json"],
			backend: "opencli",
		};

		const invocation = __browserToolsTest.buildSpawnInvocation(spec, "win32", "C:\\Windows\\System32\\cmd.exe");

		assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
		assert.deepEqual(invocation.args, [
			"/d",
			"/s",
			"/c",
			'""C:\\Users\\C\\AppData\\Roaming\\npm\\opencli.cmd" "reddit" "saved" "--window" "background" "-f" "json""',
		]);
		assert.equal(invocation.options.windowsVerbatimArguments, true);
	});

	it("wraps Windows shell invocations so spaced .cmd paths keep argv", () => {
		const spec: BrowserRunSpec = {
			command: "C:\\Users\\C\\App Data\\npm\\opencli.cmd",
			args: ["twitter", "--help", "-f", "json"],
			backend: "opencli",
		};

		const invocation = __browserToolsTest.buildSpawnInvocation(spec, "win32", "cmd.exe");

		assert.deepEqual(invocation.args, [
			"/d",
			"/s",
			"/c",
			'""C:\\Users\\C\\App Data\\npm\\opencli.cmd" "twitter" "--help" "-f" "json""',
		]);
		assert.equal(invocation.options.windowsVerbatimArguments, true);
	});

	it("keeps direct helper spawning on non-Windows platforms", () => {
		const spec: BrowserRunSpec = {
			command: "opencli",
			args: ["browser", "familiar", "state"],
			backend: "opencli",
		};

		const invocation = __browserToolsTest.buildSpawnInvocation(spec, "darwin");

		assert.equal(invocation.command, "opencli");
		assert.deepEqual(invocation.args, ["browser", "familiar", "state"]);
		assert.equal(invocation.options.windowsVerbatimArguments, undefined);
	});

	it("builds read-only browser tab inspection args", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });

		assert.deepEqual(await __browserToolsTest.buildPageArgs({ mode: "page", action: "tab", kind: "list" }, config), [
			"browser",
			"familiar",
			"--window",
			"background",
			"tab",
			"list",
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
		await assert.rejects(
			() => __browserToolsTest.buildPageArgs({ mode: "page", action: "tab", kind: "new", url: "https://example.com" }, config),
			/browser\.read_write/,
		);
		await assert.rejects(
			() => __browserToolsTest.buildPageArgs({ mode: "page", action: "tab", kind: "select", target: "tab-1" }, config),
			/browser\.read_write/,
		);
		await assert.rejects(
			() => __browserToolsTest.buildPageArgs({ mode: "page", action: "tab", kind: "close", target: "tab-1" }, config),
			/browser\.read_write/,
		);
	});

	it("allows tab lifecycle commands when read_write is enabled", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, readWrite: true } });

		assert.deepEqual(
			await __browserToolsTest.buildPageArgs(
				{ mode: "page", action: "tab", kind: "new", url: "https://example.com" },
				config,
			),
			["browser", "familiar", "--window", "background", "tab", "new", "https://example.com"],
		);
		assert.deepEqual(
			await __browserToolsTest.buildPageArgs({ mode: "page", action: "tab", kind: "select", target: "tab-1" }, config),
			["browser", "familiar", "--window", "background", "tab", "select", "tab-1"],
		);
		assert.deepEqual(
			await __browserToolsTest.buildPageArgs({ mode: "page", action: "tab", kind: "close", target: "tab-1" }, config),
			["browser", "familiar", "--window", "background", "tab", "close", "tab-1"],
		);
	});

	it("builds allowlisted site adapter commands as JSON", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });

		assert.deepEqual(
			__browserToolsTest.buildSiteArgs(
				{ mode: "site", site: "reddit", command: "saved", args: { limit: 5 } },
				config,
				{ name: "saved", access: "read" },
			),
			["reddit", "saved", "--window", "background", "--limit", "5", "-f", "json"],
		);
		assert.throws(
			() =>
				__browserToolsTest.buildSiteArgs({ mode: "site", site: "reddit", command: "upvote" }, config, {
					name: "upvote",
					access: "write",
				}),
			/browser\.read_write/,
		);
		assert.throws(
			() =>
				__browserToolsTest.buildSiteArgs(
					{ mode: "site", site: "reddit", command: "saved", args: { limit: "-1" } },
					config,
					{ name: "saved", access: "read" },
				),
			/may not start/,
		);
	});

	it("allows site write adapter commands and positional args when read_write is enabled", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, {
			browser: { enabled: true, readWrite: true, windowMode: "foreground" },
		});

		assert.deepEqual(
			__browserToolsTest.buildSiteArgs(
				{
					mode: "site",
					site: "reddit",
					command: "comment",
					positional: ["1abc123", "Looks good"],
					args: { "keep-tab": true },
				},
				config,
				{ name: "comment", access: "write" },
			),
			["reddit", "comment", "--window", "foreground", "1abc123", "Looks good", "--keep-tab", "-f", "json"],
		);
		assert.throws(
			() =>
				__browserToolsTest.buildSiteArgs(
					{ mode: "site", site: "reddit", command: "comment", positional: ["-not-safe", "text"] },
					config,
					{ name: "comment", access: "write" },
				),
			/may not start/,
		);
	});

	it("executes through injected runner and returns bounded content/details", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, maxOutputChars: 1200 } });
		const calls: string[][] = [];
		const runner = async (spec: BrowserRunSpec): Promise<BrowserCommandResult> => {
			calls.push(spec.args);
			return {
				ok: true,
				backend: "opencli",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: JSON.stringify({ title: "Example", url: "https://example.com" }),
				stderr: "",
				json: { title: "Example", url: "https://example.com" },
				truncated: false,
			};
		};
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), runner);

		const result = await tool.execute("call-1", { mode: "page", action: "state" });

		assert.deepEqual(calls[0], ["browser", "familiar", "--window", "background", "state"]);
		assert.match(textFrom(result), /untrusted_browser_content/);
		assert.equal(result.details?.ok, true);
		assert.deepEqual(result.details?.json, { title: "Example", url: "https://example.com" });
	});

	it("executes browser-harness page commands through stdin scripts", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, {
			browser: { enabled: true, backend: "browser-harness", session: "personal" },
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: JSON.stringify([{ targetId: "tab-1", title: "Inbox", url: "https://mail.example" }]),
				stderr: "",
				json: [{ targetId: "tab-1", title: "Inbox", url: "https://mail.example" }],
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", { mode: "page", action: "tab", kind: "list" });

		assert.equal(calls[0]?.command, "browser-harness");
		assert.deepEqual(calls[0]?.args, []);
		assert.equal(calls[0]?.env?.BU_NAME, "personal");
		assert.doesNotMatch(calls[0]?.stdin ?? "", /BU_NAME/);
		assert.match(calls[0]?.stdin ?? "", /list_tabs\(include_chrome=False\)/);
		assert.equal(result.details?.backend, "browser-harness");
		assert.deepEqual(result.details?.json, [{ targetId: "tab-1", title: "Inbox", url: "https://mail.example" }]);
		assert.match(textFrom(result), /browser-harness ok/);
	});

	it("routes site mode through OpenCLI even when page mode uses browser-harness", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, {
			browser: { enabled: true, backend: "browser-harness", opencliCommand: "opencli-dev" },
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			if (spec.args.join(" ") === "reddit --help -f json") {
				const json = siteHelp("reddit", [{ name: "saved", access: "read" }]);
				return {
					ok: true,
					backend: spec.backend,
					command: [spec.command, ...spec.args],
					exitCode: 0,
					stdout: JSON.stringify(json),
					stderr: "",
					json,
					truncated: false,
				};
			}
			return {
				ok: true,
				backend: spec.backend,
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: JSON.stringify({ items: [] }),
				stderr: "",
				json: { items: [] },
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", {
			mode: "site",
			site: "reddit",
			command: "saved",
			args: { limit: 5 },
		});

		assert.equal(calls[0]?.backend, "opencli");
		assert.equal(calls[0]?.command, "opencli-dev");
		assert.deepEqual(calls[0]?.args, ["reddit", "--help", "-f", "json"]);
		assert.deepEqual(calls[1]?.args, ["reddit", "saved", "--window", "background", "--limit", "5", "-f", "json"]);
		assert.equal(result.details?.backend, "opencli");
		assert.match(textFrom(result), /OpenCLI ok/);
	});

	it("lists OpenCLI commands for allowed sites from live metadata", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			const json = siteHelp("twitter", [
				{ name: "timeline", access: "read" },
				{ name: "post", access: "write" },
				{ name: "sync", access: "admin" },
			]);
			return {
				ok: true,
				backend: spec.backend,
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: JSON.stringify(json),
				stderr: "",
				json,
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", { mode: "list_commands", site: "twitter" });

		assert.deepEqual(calls[0]?.args, ["twitter", "--help", "-f", "json"]);
		assert.match(textFrom(result), /twitter/);
		assert.match(textFrom(result), /timeline/);
		assert.match(textFrom(result), /post/);
		assert.match(textFrom(result), /admin=\[sync\]/);
	});

	it("lists all configured site commands without a site filter", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			const site = spec.args[0] ?? "unknown";
			const json = siteHelp(site, [{ name: "read-one", access: "read" }]);
			return {
				ok: true,
				backend: spec.backend,
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: JSON.stringify(json),
				stderr: "",
				json,
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", { mode: "list_commands" });

		assert.match(textFrom(result), /twitter/);
		assert.match(textFrom(result), /reddit/);
		assert.match(textFrom(result), /spotify/);
	});

	it("returns non-zero exits and truncates long command output", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, maxOutputChars: 1000 } });
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => ({
			ok: false,
			backend: "opencli",
			command: [spec.command, ...spec.args],
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

	it("hints how to enable OpenCLI traces for failed site commands", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, readWrite: true } });
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			if (spec.args.join(" ") === "twitter --help -f json") {
				const json = siteHelp("twitter", [{ name: "post", access: "write" }]);
				return {
					ok: true,
					backend: spec.backend,
					command: [spec.command, ...spec.args],
					exitCode: 0,
					stdout: JSON.stringify(json),
					stderr: "",
					json,
					truncated: false,
				};
			}
			return {
				ok: false,
				backend: "opencli",
				command: [spec.command, ...spec.args],
				exitCode: 1,
				stdout: "This operation was aborted",
				stderr: "",
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", {
			mode: "site",
			site: "twitter",
			command: "post",
			positional: ["hello"],
			args: { trace: "retain-on-failure" },
		});
		assert.doesNotMatch(textFrom(result), /args\.trace/);

		const hinted = await tool.execute("call-2", {
			mode: "site",
			site: "twitter",
			command: "post",
			positional: ["hello"],
		});
		assert.match(textFrom(hinted), /args\.trace="retain-on-failure"/);
	});

	it("stores screenshots under the Familiar screenshot bucket and adds them to the media sink", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true } });
		const sink = createGeneratedMediaSink();
		const [tool] = createBrowserTools(config, sink, async (spec) => {
			const screenshotPath = __browserToolsTest.screenshotPathFromCommand([spec.command, ...spec.args]);
			assert.ok(screenshotPath);
			await mkdir(resolve(screenshotPath, ".."), { recursive: true });
			await writeFile(screenshotPath, "png");
			return {
				ok: true,
				backend: "opencli",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: `Screenshot saved to: ${screenshotPath}`,
				stderr: "",
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", { mode: "page", action: "screenshot", path: "/tmp/model-picked.png" });
		const attachment = sink.drain()[0];

		assert.ok(attachment?.localPath);
		assert.ok(attachment.localPath.startsWith(browserScreenshotsDir(config)));
		assert.equal((await stat(attachment.localPath)).isFile(), true);
		assert.equal(result.details?.attachmentName, basename(attachment.localPath));
		assert.doesNotMatch(textFrom(result), /model-picked/);
	});

	it("adds browser-harness screenshots to the media sink from JSON output", async () => {
		const dataDir = await createTempDataDir();
		const config = await configWithDataDir(dataDir, { browser: { enabled: true, backend: "browser-harness" } });
		const sink = createGeneratedMediaSink();
		const [tool] = createBrowserTools(config, sink, async (spec) => {
			const match = spec.stdin?.match(/capture_screenshot\(("(?:[^"\\]|\\.)+")/);
			const screenshotPath = match ? (JSON.parse(match[1] ?? "\"\"") as string) : undefined;
			assert.ok(screenshotPath);
			await mkdir(resolve(screenshotPath, ".."), { recursive: true });
			await writeFile(screenshotPath, "png");
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: JSON.stringify({ path: screenshotPath }),
				stderr: "",
				json: { path: screenshotPath },
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", { mode: "page", action: "screenshot" });
		const attachment = sink.drain()[0];

		assert.ok(attachment?.localPath);
		assert.ok(attachment.localPath.startsWith(browserScreenshotsDir(config)));
		assert.equal(result.details?.backend, "browser-harness");
		assert.equal(result.details?.attachmentName, basename(attachment.localPath));
	});
});
