import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, resolve } from "node:path";
import { describe, it } from "node:test";

import { __serviceTest, installService, serviceStatus, uninstallService, upgradeFamiliar } from "../src/service.js";

describe("service management", () => {
	it("renders launchd plist with escaped paths", () => {
		const spec = __serviceTest.buildSpec("/tmp/Familiar & Friends", {
			platform: "darwin",
			homeDir: "/Users/test",
			nodePath: "/opt/node",
			cliPath: "/tmp/familiar/dist/cli.js",
			resolvePath: posix.resolve,
		});

		const plist = __serviceTest.launchdPlist(spec);

		assert.match(plist, /com\.qearlyao\.familiar/);
		assert.match(plist, /<string>\/opt\/node<\/string>/);
		assert.match(plist, /<string>\/tmp\/Familiar &amp; Friends<\/string>/);
		assert.match(plist, /KeepAlive/);
		assert.match(plist, /ThrottleInterval/);
		assert.match(plist, /ExitTimeOut/);
	});

	it("renders systemd unit with quoted paths", () => {
		const spec = __serviceTest.buildSpec("/home/test/Familiar Workspace", {
			platform: "linux",
			homeDir: "/home/test",
			nodePath: "/usr/bin/node",
			cliPath: "/home/test/familiar/dist/cli.js",
			resolvePath: posix.resolve,
		});

		const unit = __serviceTest.systemdUnit(spec);

		assert.match(unit, /Description=Familiar companion agent/);
		assert.match(unit, /ExecStart=\/usr\/bin\/node \/home\/test\/familiar\/dist\/cli\.js run ".*Familiar Workspace"/);
		assert.match(unit, /Restart=on-failure/);
		assert.match(unit, /StartLimitIntervalSec=300/);
		assert.match(unit, /StartLimitBurst=5/);
		assert.match(unit, /SuccessExitStatus=75/);
		assert.match(unit, /RestartForceExitStatus=75/);
	});

	it("escapes launchd XML and systemd shell values", () => {
		assert.equal(__serviceTest.xmlEscape(`A&B<"'>`), "A&amp;B&lt;&quot;&apos;&gt;");
		assert.equal(__serviceTest.systemdQuote("/tmp/a b/$HOME"), '"/tmp/a b/\\$HOME"');
	});

	it("installs and uninstalls a macOS launchd service definition", async (t) => {
		const homeDir = await mkdtemp(resolve(tmpdir(), "familiar-service-home-"));
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-service-workspace-"));
		t.after(async () => {
			await Promise.all([
				rm(homeDir, { recursive: true, force: true }),
				rm(workspacePath, { recursive: true, force: true }),
			]);
		});
		const calls: string[] = [];

		const installed = await installService(workspacePath, {
			platform: "darwin",
			homeDir,
			nodePath: "/usr/bin/node",
			cliPath: "/usr/local/bin/familiar",
			userId: 501,
			runCommand: async (command, args) => {
				calls.push([command, ...args].join(" "));
			},
		});

		assert.match(installed.title, /installed/);
		assert.equal(calls.length, 3);
		assert.match(calls[0] ?? "", /^launchctl bootout gui\/\d+ /);
		assert.match(calls[1] ?? "", /^launchctl bootstrap gui\/\d+ /);
		assert.match(calls[2] ?? "", /^launchctl kickstart -k gui\/\d+\/com\.qearlyao\.familiar$/);
		assert.ok(calls[0]?.endsWith(resolve(homeDir, "Library", "LaunchAgents", "com.qearlyao.familiar.plist")));
		assert.ok(calls[1]?.endsWith(resolve(homeDir, "Library", "LaunchAgents", "com.qearlyao.familiar.plist")));
		assert.match(
			await readFile(resolve(homeDir, "Library", "LaunchAgents", "com.qearlyao.familiar.plist"), "utf8"),
			/familiar/,
		);

		const status = await serviceStatus(workspacePath, { platform: "darwin", homeDir });
		assert.ok(status.details.some((line) => line === "service_file: present"));
		assert.ok(status.details.some((line) => line === "supervisor_state: not-loaded"));

		const uninstalled = await uninstallService(workspacePath, {
			platform: "darwin",
			homeDir,
			userId: 501,
			runCommand: async (command, args) => {
				calls.push([command, ...args].join(" "));
			},
		});
		assert.match(uninstalled.title, /uninstalled/);
		assert.equal(existsSync(resolve(homeDir, "Library", "LaunchAgents", "com.qearlyao.familiar.plist")), false);
	});

	it("installs a Linux user systemd service definition", async (t) => {
		const homeDir = await mkdtemp(resolve(tmpdir(), "familiar-service-home-"));
		const workspacePath = await mkdtemp(resolve(tmpdir(), "familiar-service-workspace-"));
		t.after(async () => {
			await Promise.all([
				rm(homeDir, { recursive: true, force: true }),
				rm(workspacePath, { recursive: true, force: true }),
			]);
		});
		const calls: string[] = [];

		const installed = await installService(workspacePath, {
			platform: "linux",
			homeDir,
			nodePath: "/usr/bin/node",
			cliPath: "/usr/local/bin/familiar",
			commandExists: async (command) => command === "systemctl",
			runCommand: async (command, args) => {
				calls.push([command, ...args].join(" "));
			},
		});

		const unitPath = resolve(homeDir, ".config", "systemd", "user", "familiar.service");
		assert.match(installed.title, /installed/);
		assert.deepEqual(calls, [
			"systemctl --user daemon-reload",
			"systemctl --user enable --now familiar.service",
		]);
		assert.match(await readFile(unitPath, "utf8"), /StartLimitBurst=5/);

		const status = await serviceStatus(workspacePath, {
			platform: "linux",
			homeDir,
			captureCommand: async (command, args) => {
				assert.equal([command, ...args].join(" "), "systemctl --user is-active familiar.service");
				return "active\n";
			},
		});
		assert.ok(status.details.some((line) => line === "supervisor_state: active"));

		calls.length = 0;
		const uninstalled = await uninstallService(workspacePath, {
			platform: "linux",
			homeDir,
			commandExists: async (command) => command === "systemctl",
			runCommand: async (command, args) => {
				calls.push([command, ...args].join(" "));
			},
		});
		assert.match(uninstalled.title, /uninstalled/);
		assert.equal(existsSync(unitPath), false);
		assert.deepEqual(calls, [
			"systemctl --user disable --now familiar.service",
			"systemctl --user daemon-reload",
		]);
	});

	it("returns manual-run guidance on unsupported platforms", async () => {
		const result = await installService("/tmp/familiar", { platform: "win32" });

		assert.match(result.title, /not supported/);
		assert.ok(result.details.some((line) => line.includes("foreground terminal")));
	});

	it("warns when service paths are tied to a Node version manager", () => {
		const spec = __serviceTest.buildSpec("/tmp/familiar", {
			platform: "darwin",
			homeDir: "/Users/test",
			nodePath: "/Users/test/.nvm/versions/node/v24/bin/node",
			cliPath: "/Users/test/.nvm/versions/node/v24/bin/familiar",
			resolvePath: posix.resolve,
		});

		assert.match(__serviceTest.versionManagedPathWarning(spec) ?? "", /version-manager/);
	});

	it("refreshes missing workspace defaults after global upgrade", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];

		await upgradeFamiliar("/tmp/familiar workspace", {
			platform: "linux",
			runCommand: async (command, args) => {
				calls.push({ command, args });
			},
		});

		assert.deepEqual(calls, [
			{ command: "npm", args: ["install", "-g", "@qearlyao/familiar@latest"] },
			{ command: "npm", args: ["install", "-g", "@jackwener/opencli"] },
			{ command: "familiar", args: ["init", "/tmp/familiar workspace"] },
		]);
	});
});
