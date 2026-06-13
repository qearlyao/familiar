import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { describe, it } from "node:test";

import {
	__browserToolsTest,
	createBrowserTools,
	type BrowserCommandResult,
	type BrowserRunSpec,
} from "../src/tools/browser-tools.js";
import { browserScreenshotsDir, createGeneratedMediaSink } from "../src/media/generated-media.js";
import { configWithDataDir, createTempDataDir, withEnv, withoutEnv } from "./helpers.js";

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
	it("does not register when disabled", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir);

		assert.deepEqual(createBrowserTools(config, createGeneratedMediaSink()), []);
	});

	it("loads browser defaults and allowlisted recurring sites", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
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

	it("builds OpenCLI page args with positional session", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
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

	it("passes browser timeout through to OpenCLI internals", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
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

	it("uses cross-spawn for browser helpers on Windows", () => {
		const spec: BrowserRunSpec = {
			command: "C:\\Users\\C\\AppData\\Roaming\\npm\\opencli.cmd",
			args: ["reddit", "saved", "--window", "background", "-f", "json"],
			backend: "opencli",
		};

		const invocation = __browserToolsTest.buildSpawnInvocation(spec, "win32");

		assert.equal(invocation.spawnKind, "cross-spawn");
		assert.equal(invocation.command, "C:\\Users\\C\\AppData\\Roaming\\npm\\opencli.cmd");
		assert.deepEqual(invocation.args, ["reddit", "saved", "--window", "background", "-f", "json"]);
		assert.equal(invocation.options.windowsVerbatimArguments, undefined);
	});

	it("keeps Windows .cmd paths and metacharacter args as argv", () => {
		const spec: BrowserRunSpec = {
			command: "C:\\Users\\C\\App Data\\npm\\opencli.cmd",
			args: ["browser", "familiar", "type", 'hello" & echo injected & "x'],
			backend: "opencli",
		};

		const invocation = __browserToolsTest.buildSpawnInvocation(spec, "win32");

		assert.equal(invocation.spawnKind, "cross-spawn");
		assert.equal(invocation.command, "C:\\Users\\C\\App Data\\npm\\opencli.cmd");
		assert.deepEqual(invocation.args, ["browser", "familiar", "type", 'hello" & echo injected & "x']);
	});

	it("keeps direct helper spawning on non-Windows platforms", () => {
		const spec: BrowserRunSpec = {
			command: "opencli",
			args: ["browser", "familiar", "state"],
			backend: "opencli",
		};

		const invocation = __browserToolsTest.buildSpawnInvocation(spec, "darwin");

		assert.equal(invocation.spawnKind, "node");
		assert.equal(invocation.command, "opencli");
		assert.deepEqual(invocation.args, ["browser", "familiar", "state"]);
		assert.equal(invocation.options.windowsVerbatimArguments, undefined);
	});

	it("builds read-only browser tab inspection args", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true } });

		assert.deepEqual(await __browserToolsTest.buildPageArgs({ mode: "page", action: "tab", kind: "list" }, config), [
			"browser",
			"familiar",
			"--window",
			"background",
			"tab",
			"list",
		]);
	});

	it("omits window mode from lifecycle commands", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true, readWrite: true } });

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

	it("blocks write-like page actions until read_write is enabled", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true } });

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

	it("allows tab lifecycle commands when read_write is enabled", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true, readWrite: true } });

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

	it("builds allowlisted site adapter commands as JSON", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true } });

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

	it("allows site write adapter commands and positional args when read_write is enabled", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
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

	it("executes through injected runner and returns bounded content/details", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true, maxOutputChars: 1200 } });
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
		assert.doesNotMatch(textFrom(result), /OpenCLI ok/);
		assert.doesNotMatch(textFrom(result), /Command:/);
		assert.match(textFrom(result), /"title":"Example"/);
		assert.equal(result.details?.ok, true);
		assert.deepEqual(result.details?.command, ["opencli", "browser", "familiar", "--window", "background", "state"]);
		assert.deepEqual(result.details?.json, { title: "Example", url: "https://example.com" });
	});

	it("executes browser-harness page commands through stdin scripts", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
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
		assert.deepEqual(result.details?.command, ["browser-harness"]);
		assert.deepEqual(result.details?.json, [{ targetId: "tab-1", title: "Inbox", url: "https://mail.example" }]);
		assert.doesNotMatch(textFrom(result), /browser-harness ok/);
		assert.doesNotMatch(textFrom(result), /Command:/);
		assert.match(textFrom(result), /"targetId":"tab-1"/);
	});

	it("passes configured browser-harness CDP websocket to the helper env", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: {
					mode: "cdp",
					cdpWs: "ws://127.0.0.1:9222/devtools/browser/local",
					launchArgs: [],
				},
			},
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: "{}",
				stderr: "",
				json: {},
				truncated: false,
			};
		});

		await tool.execute("call-1", { mode: "page", action: "state" });

		assert.equal(calls[0]?.env?.BU_NAME, "familiar");
		assert.equal(calls[0]?.env?.BU_CDP_WS, "ws://127.0.0.1:9222/devtools/browser/local");
		assert.equal(calls[0]?.env?.BU_CDP_URL, undefined);
	});

	it("normalizes trailing slashes from configured CDP URLs", async (t) => {
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
		});
		const probedUrls: string[] = [];
		globalThis.fetch = async (input) => {
			const url = String(input);
			probedUrls.push(url);
			if (url === "http://127.0.0.1:9222/json/version") {
				return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/local" }));
			}
			return new Response("not found", { status: 404 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: {
					mode: "cdp",
					cdpUrl: "http://127.0.0.1:9222///",
					launchArgs: [],
				},
			},
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: "{}",
				stderr: "",
				json: {},
				truncated: false,
			};
		});

		await tool.execute("call-1", { mode: "page", action: "state" });

		assert.deepEqual(probedUrls, ["http://127.0.0.1:9222/json/version"]);
		assert.equal(calls[0]?.env?.BU_CDP_URL, "http://127.0.0.1:9222///");
	});

	it("provisions configured Browser Use cloud profiles for browser-harness", async (t) => {
		__browserToolsTest.clearCloudBrowsers();
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
			__browserToolsTest.clearCloudBrowsers();
		});
		const requested: Array<{ url: string; body?: unknown }> = [];
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			requested.push({
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (url === "https://api.browser-use.com/api/v3/browsers") {
				return new Response(
					JSON.stringify({
						id: "browser-1",
						cdpUrl: "https://cloud.browser-use.example/cdp/browser-1",
						liveUrl: "https://live.browser-use.example/browser-1",
					}),
					{ status: 201 },
				);
			}
			if (url === "https://cloud.browser-use.example/cdp/browser-1/json/version") {
				return new Response(JSON.stringify({ webSocketDebuggerUrl: "wss://cloud.browser-use.example/ws/browser-1" }));
			}
			return new Response("not found", { status: 404 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: {
					mode: "cloud",
					apiKeyEnv: "BROWSER_USE_API_KEY",
					profileId: "profile-1",
					timeoutMinutes: 120,
					proxyCountryCode: "de",
				},
			},
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: "{}",
				stderr: "",
				json: {},
				truncated: false,
			};
		});

		await withEnv("BROWSER_USE_API_KEY", "browser-use-key", () =>
			tool.execute("call-1", { mode: "page", action: "state" }),
		);

		assert.deepEqual(requested[0], {
			url: "https://api.browser-use.com/api/v3/browsers",
			body: { profileId: "profile-1", timeout: 120, proxyCountryCode: "de" },
		});
		assert.equal(calls[0]?.env?.BU_CDP_WS, "wss://cloud.browser-use.example/ws/browser-1");
		assert.equal(calls[0]?.env?.BU_BROWSER_ID, "browser-1");
		assert.equal(calls[0]?.env?.BROWSER_USE_API_KEY, "browser-use-key");
	});

	it("reuses Browser Use cloud browsers until their timeoutAt expires", async (t) => {
		__browserToolsTest.clearCloudBrowsers();
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
			__browserToolsTest.clearCloudBrowsers();
		});
		let createdCount = 0;
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "https://api.browser-use.com/api/v3/browsers") {
				createdCount += 1;
				return new Response(
					JSON.stringify({
						id: `browser-${createdCount}`,
						cdpUrl: `https://cloud.browser-use.example/cdp/browser-${createdCount}`,
						timeoutAt: new Date(Date.now() + 60_000).toISOString(),
					}),
					{ status: 201 },
				);
			}
			const match = url.match(/https:\/\/cloud\.browser-use\.example\/cdp\/browser-(\d+)\/json\/version/);
			if (match) {
				return new Response(
					JSON.stringify({ webSocketDebuggerUrl: `wss://cloud.browser-use.example/ws/browser-${match[1]}` }),
				);
			}
			return new Response("not found", { status: 404 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: { mode: "cloud", apiKeyEnv: "BROWSER_USE_API_KEY", profileId: "profile-1" },
			},
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: "{}",
				stderr: "",
				json: {},
				truncated: false,
			};
		});

		await withEnv("BROWSER_USE_API_KEY", "browser-use-key", async () => {
			await tool.execute("call-1", { mode: "page", action: "state" });
			await tool.execute("call-2", { mode: "page", action: "state" });
		});

		assert.equal(createdCount, 1);
		assert.equal(calls[0]?.env?.BU_BROWSER_ID, "browser-1");
		assert.equal(calls[1]?.env?.BU_BROWSER_ID, "browser-1");
	});

	it("recreates expired Browser Use cloud browsers", async (t) => {
		__browserToolsTest.clearCloudBrowsers();
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
			__browserToolsTest.clearCloudBrowsers();
		});
		let createdCount = 0;
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "https://api.browser-use.com/api/v3/browsers") {
				createdCount += 1;
				return new Response(
					JSON.stringify({
						id: `browser-${createdCount}`,
						cdpUrl: `https://cloud.browser-use.example/cdp/browser-${createdCount}`,
						timeoutAt: new Date(Date.now() - 1_000).toISOString(),
					}),
					{ status: 201 },
				);
			}
			const match = url.match(/https:\/\/cloud\.browser-use\.example\/cdp\/browser-(\d+)\/json\/version/);
			if (match) {
				return new Response(
					JSON.stringify({ webSocketDebuggerUrl: `wss://cloud.browser-use.example/ws/browser-${match[1]}` }),
				);
			}
			return new Response("not found", { status: 404 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: { mode: "cloud", apiKeyEnv: "BROWSER_USE_API_KEY", profileId: "profile-1" },
			},
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: "{}",
				stderr: "",
				json: {},
				truncated: false,
			};
		});

		await withEnv("BROWSER_USE_API_KEY", "browser-use-key", async () => {
			await tool.execute("call-1", { mode: "page", action: "state" });
			await tool.execute("call-2", { mode: "page", action: "state" });
		});

		assert.equal(createdCount, 2);
		assert.equal(calls[0]?.env?.BU_BROWSER_ID, "browser-1");
		assert.equal(calls[1]?.env?.BU_BROWSER_ID, "browser-2");
	});

	it("fails cloud mode before provisioning when the Browser Use API key is missing", async (t) => {
		__browserToolsTest.clearCloudBrowsers();
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
			__browserToolsTest.clearCloudBrowsers();
		});
		let fetchCount = 0;
		globalThis.fetch = async () => {
			fetchCount += 1;
			return new Response("unexpected", { status: 500 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: { mode: "cloud", apiKeyEnv: "BROWSER_USE_API_KEY", profileId: "profile-1" },
			},
		});
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async () => {
			throw new Error("runner should not be called");
		});

		await withoutEnv("BROWSER_USE_API_KEY", () =>
			assert.rejects(() => tool.execute("call-1", { mode: "page", action: "state" }), /Missing Browser Use API key/),
		);

		assert.equal(fetchCount, 0);
	});

	it("rejects duplicate Browser Use cloud profile names", async (t) => {
		__browserToolsTest.clearCloudBrowsers();
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
			__browserToolsTest.clearCloudBrowsers();
		});
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "https://api.browser-use.com/api/v3/profiles?pageSize=100&pageNumber=1") {
				return new Response(JSON.stringify({ items: [{ id: "profile-1" }, { id: "profile-2" }], totalItems: 2 }));
			}
			if (url === "https://api.browser-use.com/api/v3/profiles/profile-1") {
				return new Response(JSON.stringify({ id: "profile-1", name: "work" }));
			}
			if (url === "https://api.browser-use.com/api/v3/profiles/profile-2") {
				return new Response(JSON.stringify({ id: "profile-2", name: "work" }));
			}
			return new Response("not found", { status: 404 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: { mode: "cloud", apiKeyEnv: "BROWSER_USE_API_KEY", profileName: "work" },
			},
		});
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async () => {
			throw new Error("runner should not be called");
		});

		await withEnv("BROWSER_USE_API_KEY", "browser-use-key", () =>
			assert.rejects(
				() => tool.execute("call-1", { mode: "page", action: "state" }),
				/Multiple Browser Use cloud profiles named "work"/,
			),
		);
	});

	it("launches a configured CDP browser process before passing BU_CDP_URL", async (t) => {
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
		});
		let versionChecks = 0;
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "http://127.0.0.1:9222/json/version") {
				versionChecks += 1;
				if (versionChecks === 1) return new Response("not ready", { status: 503 });
				return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/local" }));
			}
			return new Response("not found", { status: 404 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: {
					mode: "cdp",
					cdpUrl: "http://127.0.0.1:9222",
					launchCommand: process.execPath,
					launchArgs: ["-e", ""],
				},
			},
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			return {
				ok: true,
				backend: "browser-harness",
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: "{}",
				stderr: "",
				json: {},
				truncated: false,
			};
		});

		await tool.execute("call-1", { mode: "page", action: "state" });

		assert.equal(versionChecks, 2);
		assert.equal(calls[0]?.env?.BU_CDP_URL, "http://127.0.0.1:9222");
		assert.equal(calls[0]?.env?.BU_CDP_WS, undefined);
	});

	it("reports CDP launch failures before running browser-harness", async (t) => {
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
		});
		let versionChecks = 0;
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "http://127.0.0.1:9222/json/version") {
				versionChecks += 1;
				return new Response("not ready", { status: 503 });
			}
			return new Response("not found", { status: 404 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: {
					mode: "cdp",
					cdpUrl: "http://127.0.0.1:9222",
					launchCommand: "/definitely-not-a-familiar-browser",
					launchArgs: [],
				},
			},
		});
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async () => {
			throw new Error("runner should not be called");
		});

		await assert.rejects(
			() => tool.execute("call-1", { mode: "page", action: "state" }),
			/Failed to launch browser command "\/definitely-not-a-familiar-browser"/,
		);
		assert.equal(versionChecks, 1);
	});

	it("does not provision browser-harness cloud before rejected read_write actions", async (t) => {
		__browserToolsTest.clearCloudBrowsers();
		const previousFetch = globalThis.fetch;
		t.after(() => {
			globalThis.fetch = previousFetch;
			__browserToolsTest.clearCloudBrowsers();
		});
		let fetchCount = 0;
		globalThis.fetch = async () => {
			fetchCount += 1;
			return new Response("unexpected", { status: 500 });
		};
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: {
				enabled: true,
				backend: "browser-harness",
				harnessTarget: {
					mode: "cloud",
					apiKeyEnv: "BROWSER_USE_API_KEY",
					profileId: "profile-1",
				},
			},
		});
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async () => {
			throw new Error("runner should not be called");
		});

		await withEnv("BROWSER_USE_API_KEY", "browser-use-key", () =>
			assert.rejects(() => tool.execute("call-1", { mode: "page", action: "open", url: "https://example.com" }), {
				message: /browser\.read_write/,
			}),
		);

		assert.equal(fetchCount, 0);
	});

	it("routes site mode through OpenCLI even when page mode uses browser-harness", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: { enabled: true, backend: "browser-harness", opencliCommand: "opencli-dev" },
		});
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			if (spec.args.join(" ") === "reddit saved --help -f json") {
				const json = { site: "reddit", name: "saved", access: "read", usage: "opencli reddit saved" };
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
		assert.deepEqual(calls[0]?.args, ["reddit", "saved", "--help", "-f", "json"]);
		assert.deepEqual(calls[1]?.args, ["reddit", "saved", "--window", "background", "--limit", "5", "-f", "json"]);
		assert.equal(result.details?.backend, "opencli");
		assert.doesNotMatch(textFrom(result), /OpenCLI ok/);
		assert.doesNotMatch(textFrom(result), /Command:/);
		assert.match(textFrom(result), /"items":\[\]/);
	});

	it("lists OpenCLI commands for allowed sites from live metadata", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true } });
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

	it("falls back to plain OpenCLI site help when structured command listing is truncated", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true } });
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			if (spec.args.join(" ") === "twitter --help -f json") {
				return {
					ok: true,
					backend: spec.backend,
					command: [spec.command, ...spec.args],
					exitCode: 0,
					stdout: '{"site":"twitter","commands":[{"name":"timeline"',
					stderr: "",
					truncated: false,
				};
			}
			return {
				ok: true,
				backend: spec.backend,
				command: [spec.command, ...spec.args],
				exitCode: 0,
				stdout: [
					"Usage: opencli twitter <command> [args] [options]",
					"",
					"Commands:",
					"  timeline [options]                 [read] Fetch timeline",
					"  post <text> [options]               [write] Post a new tweet/thread",
					"",
					"Common options:",
				].join("\n"),
				stderr: "",
				truncated: false,
			};
		});

		const result = await tool.execute("call-1", { mode: "list_commands", site: "twitter" });

		assert.deepEqual(calls.map((call) => call.args), [
			["twitter", "--help", "-f", "json"],
			["twitter", "--help"],
		]);
		assert.match(textFrom(result), /read=\[timeline\]/);
		assert.match(textFrom(result), /write=\[post\]/);
		assert.match(textFrom(result), /from plain help/);
	});

	it("validates site execution with command-specific OpenCLI metadata", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true, readWrite: true } });
		const calls: BrowserRunSpec[] = [];
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			calls.push(spec);
			if (spec.args.join(" ") === "twitter post --help -f json") {
				const json = { site: "twitter", name: "post", access: "write" };
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
				stdout: JSON.stringify({ status: "success" }),
				stderr: "",
				json: { status: "success" },
				truncated: false,
			};
		});

		await tool.execute("call-1", {
			mode: "site",
			site: "twitter",
			command: "post",
			positional: ["hello"],
			args: { images: "/tmp/cat.png" },
		});

		assert.deepEqual(calls.map((call) => call.args), [
			["twitter", "post", "--help", "-f", "json"],
			["twitter", "post", "--window", "background", "hello", "--images", "/tmp/cat.png", "-f", "json"],
		]);
	});

	it("lists all configured site commands without a site filter", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true } });
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

	it("returns non-zero exits and truncates long command output", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true, maxOutputChars: 1000 } });
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
		assert.match(textFrom(result), /Command: opencli browser familiar --window background state/);
		assert.match(textFrom(result), /stderr:\nextension disconnected/);
		assert.match(textFrom(result), /\.\.\.$/);
		assert.equal(result.details?.ok, false);
		assert.equal(result.details?.truncated, true);
	});

	it("keeps browser-harness failure content diagnostic without echoing the bare command", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			browser: { enabled: true, backend: "browser-harness", maxOutputChars: 1200 },
		});
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => ({
			ok: false,
			backend: "browser-harness",
			command: [spec.command, ...spec.args],
			exitCode: 2,
			stdout: "",
			stderr: "no active tab",
			truncated: false,
		}));

		const result = await tool.execute("call-1", { mode: "page", action: "state" });

		assert.match(textFrom(result), /browser-harness failed \(exit 2\)/);
		assert.match(textFrom(result), /no active tab/);
		assert.doesNotMatch(textFrom(result), /Command: browser-harness/);
		assert.deepEqual(result.details?.command, ["browser-harness"]);
	});

	it("hints how to enable OpenCLI traces for failed site commands", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true, readWrite: true } });
		const [tool] = createBrowserTools(config, createGeneratedMediaSink(), async (spec) => {
			if (spec.args.join(" ") === "twitter post --help -f json") {
				const json = { site: "twitter", name: "post", access: "write" };
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

	it("stores screenshots under the Familiar screenshot bucket and adds them to the media sink", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true } });
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

	it("adds browser-harness screenshots to the media sink from JSON output", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, { browser: { enabled: true, backend: "browser-harness" } });
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
