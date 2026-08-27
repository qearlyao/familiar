#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

import { createFamiliarAgent } from "./agent/factory.js";
import { loadConfig } from "./config/index.js";
import { loadSettingsStore } from "./config/settings.js";
import { loadOwnerIdentity } from "./conversation/owner-identity.js";
import { startDiscordDaemon } from "./discord/daemon.js";
import { runDataRetention } from "./lifecycle/data-retention.js";
import { startWorkspaceHotReload } from "./lifecycle/hot-reload.js";
import {
	formatServiceResult,
	installService,
	restartService,
	serviceStatus,
	startService,
	stopService,
	uninstallService,
	upgradeFamiliar,
} from "./lifecycle/service.js";
import { cleanupGeneratedAttachments } from "./media/generated-media.js";
import { memoryHelp, runMemoryOperator } from "./memory/operator.js";
import { createMemoryService } from "./memory/service.js";
import { createModelRuntime } from "./models/runtime.js";
import { startQqDaemon } from "./qq/daemon.js";
import { createAgentCore } from "./runtime/agent-core.js";
import { startWebDaemon } from "./web/daemon.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, "..");
const DEFAULT_WORKSPACE_PATH = resolve(homedir(), ".familiar");
const MEMORY_SUBCOMMANDS = new Set(["status", "doctor", "reindex", "backfill", "prune", "backup", "help", "--help"]);
const RESTART_EXIT_DELAY_MS = 1500;

function loadWorkspaceEnv(envPath: string, override: boolean): void {
	if (!existsSync(envPath)) return;
	if (override) {
		Object.assign(process.env, parseEnv(readFileSync(envPath, "utf8")));
		return;
	}
	process.loadEnvFile(envPath);
}

interface PackageJson {
	version?: unknown;
}

interface WorkspaceDirs {
	dataDir: string;
	memoryIndexDir: string;
	memoryLcmDir: string;
	memoryDiariesDir: string;
	memoryArchiveDir: string;
}

function defaultWorkspaceDirs(workspacePath: string): WorkspaceDirs {
	const memoryRoot = resolve(workspacePath, "memories");
	return {
		dataDir: resolve(workspacePath, "data"),
		memoryIndexDir: resolve(memoryRoot, "index"),
		memoryLcmDir: resolve(memoryRoot, "lcm"),
		memoryDiariesDir: resolve(memoryRoot, "diaries"),
		memoryArchiveDir: resolve(memoryRoot, "archive"),
	};
}

function configuredWorkspaceDirs(config: Awaited<ReturnType<typeof loadConfig>>): WorkspaceDirs {
	return {
		dataDir: config.workspace.dataDir,
		memoryIndexDir: config.memory.indexDir,
		memoryLcmDir: config.memory.lcmDir,
		memoryDiariesDir: config.memory.diariesDir,
		memoryArchiveDir: config.memory.archiveDir,
	};
}

async function ensureWorkspaceDirs(dirs: WorkspaceDirs): Promise<void> {
	await Promise.all([
		mkdir(dirs.dataDir, { recursive: true }),
		mkdir(dirs.memoryIndexDir, { recursive: true }),
		mkdir(dirs.memoryLcmDir, { recursive: true }),
		mkdir(dirs.memoryDiariesDir, { recursive: true }),
		mkdir(dirs.memoryArchiveDir, { recursive: true }),
	]);
}

async function copyDefaultSkills(workspacePath: string): Promise<void> {
	const sourcePath = resolve(PROJECT_ROOT, "skills");
	if (!existsSync(sourcePath)) return;
	await cp(sourcePath, resolve(workspacePath, "skills"), {
		recursive: true,
		force: false,
	});
}

async function copyIfMissing(sourcePath: string, targetPath: string): Promise<void> {
	if (existsSync(targetPath)) return;
	await copyFile(sourcePath, targetPath);
}

function resolveWorkspaceInput(workspaceInput?: string): string {
	return workspaceInput ? resolve(workspaceInput) : DEFAULT_WORKSPACE_PATH;
}

function parseMemoryArgs(
	workspaceOrCommand: string | undefined,
	rest: string[],
): {
	workspacePath: string;
	args: string[];
} {
	if (workspaceOrCommand && !MEMORY_SUBCOMMANDS.has(workspaceOrCommand)) {
		return { workspacePath: resolveWorkspaceInput(workspaceOrCommand), args: rest };
	}
	return { workspacePath: DEFAULT_WORKSPACE_PATH, args: workspaceOrCommand ? [workspaceOrCommand, ...rest] : rest };
}

function isMemoryHelp(args: string[]): boolean {
	const command = args[0];
	return !command || command === "help" || command === "--help";
}

async function packageVersion(): Promise<string> {
	const raw = await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8");
	const packageJson = JSON.parse(raw) as PackageJson;
	return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

type AuthChoice = {
	providerId: string;
	providerName: string;
	type: AuthType;
	methodName: string;
};

async function choose<T>(
	rl: ReturnType<typeof createInterface>,
	message: string,
	choices: readonly { label: string; value: T }[],
): Promise<T> {
	if (choices.length === 0) throw new Error("No choices available");
	if (choices.length === 1) return choices[0].value;
	console.log(`\n${message}`);
	for (const [index, choice] of choices.entries()) console.log(`  ${index + 1}. ${choice.label}`);
	const index = Number.parseInt(await rl.question(`Enter number (1-${choices.length}): `), 10) - 1;
	const choice = choices[index];
	if (!choice) throw new Error("Invalid selection");
	return choice.value;
}

async function answerAuthPrompt(
	rl: ReturnType<typeof createInterface>,
	prompt: AuthPrompt,
	setMuted: (muted: boolean) => void,
): Promise<string> {
	if (prompt.type === "select") {
		return choose(
			rl,
			prompt.message,
			prompt.options.map((option) => ({
				label: option.description ? `${option.label} - ${option.description}` : option.label,
				value: option.id,
			})),
		);
	}
	const question = `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `;
	const ask = () =>
		prompt.signal
			? rl.question(prompt.type === "secret" ? "" : question, { signal: prompt.signal })
			: rl.question(prompt.type === "secret" ? "" : question);
	if (prompt.type !== "secret") return ask();
	process.stdout.write(question);
	setMuted(true);
	try {
		return await ask();
	} finally {
		setMuted(false);
		process.stdout.write("\n");
	}
}

function notifyAuth(event: AuthEvent): void {
	if (event.type === "auth_url") {
		console.log(`\nOpen this URL in your browser:\n${event.url}`);
		if (event.instructions) console.log(event.instructions);
	} else if (event.type === "device_code") {
		console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
		console.log(`Enter code: ${event.userCode}`);
	} else {
		console.log(event.message);
		if (event.type === "info") {
			for (const link of event.links ?? []) console.log(`${link.label ? `${link.label}: ` : ""}${link.url}`);
		}
	}
}

async function runAuthCommand(command: "login" | "logout", providerRef?: string): Promise<void> {
	const workspacePath = DEFAULT_WORKSPACE_PATH;
	loadWorkspaceEnv(resolve(workspacePath, ".env"), false);
	const runtime = await createModelRuntime(await loadConfig(workspacePath));
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) process.stdout.write(chunk);
			callback();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
	try {
		if (command === "logout") {
			const stored = await runtime.listCredentials();
			const choices = stored.map(({ providerId, type }) => {
				const providerName = runtime.getProvider(providerId)?.name ?? providerId;
				return { label: `${providerName} (${type})`, value: { providerId, providerName } };
			});
			const matches = providerRef
				? choices.filter(({ value }) =>
						[value.providerId, value.providerName].some(
							(value) => value.toLowerCase() === providerRef.toLowerCase(),
						),
					)
				: choices;
			if (matches.length === 0)
				throw new Error(providerRef ? `No stored credential for: ${providerRef}` : "No stored credentials");
			const selected = await choose(rl, "Select a provider to log out:", matches);
			await runtime.logout(selected.providerId);
			console.log(`Removed stored credential for ${selected.providerName}`);
			return;
		}

		const choices: AuthChoice[] = runtime.getProviders().flatMap((provider) => [
			...(provider.auth.oauth
				? [
						{
							providerId: provider.id,
							providerName: provider.name,
							type: "oauth" as const,
							methodName: provider.auth.oauth.name,
						},
					]
				: []),
			...(provider.auth.apiKey?.login
				? [
						{
							providerId: provider.id,
							providerName: provider.name,
							type: "api_key" as const,
							methodName: provider.auth.apiKey.name,
						},
					]
				: []),
		]);
		const matches = providerRef
			? choices.filter(({ providerId, providerName }) =>
					[providerId, providerName].some((value) => value.toLowerCase() === providerRef.toLowerCase()),
				)
			: choices;
		if (matches.length === 0)
			throw new Error(
				providerRef ? `Provider does not support login: ${providerRef}` : "No login providers available",
			);
		const selected = await choose(
			rl,
			providerRef ? `Select an authentication method for ${matches[0].providerName}:` : "Select a provider:",
			matches.map((choice) => ({ label: `${choice.providerName} - ${choice.methodName}`, value: choice })),
		);
		await runtime.login(selected.providerId, selected.type, {
			prompt: (prompt) => answerAuthPrompt(rl, prompt, (value) => (muted = value)),
			notify: notifyAuth,
		});
		console.log(`Logged in to ${selected.providerName} with ${selected.methodName}`);
	} finally {
		rl.close();
	}
}

async function initWorkspace(workspaceInput?: string): Promise<void> {
	const workspacePath = resolveWorkspaceInput(workspaceInput);
	await mkdir(workspacePath, { recursive: true });
	await copyIfMissing(resolve(PROJECT_ROOT, ".env.example"), resolve(workspacePath, ".env"));
	await copyIfMissing(resolve(PROJECT_ROOT, "config.example.toml"), resolve(workspacePath, "config.toml"));
	await copyIfMissing(resolve(PROJECT_ROOT, "SOUL.md"), resolve(workspacePath, "SOUL.md"));
	await copyIfMissing(resolve(PROJECT_ROOT, "USER.md"), resolve(workspacePath, "USER.md"));
	await copyIfMissing(resolve(PROJECT_ROOT, "CONTACT.md"), resolve(workspacePath, "CONTACT.md"));
	await copyIfMissing(resolve(PROJECT_ROOT, "MEMORY.md"), resolve(workspacePath, "MEMORY.md"));
	await copyIfMissing(resolve(PROJECT_ROOT, "HEARTBEAT.md"), resolve(workspacePath, "HEARTBEAT.md"));
	await copyDefaultSkills(workspacePath);
	await ensureWorkspaceDirs(defaultWorkspaceDirs(workspacePath));
	console.log(`Initialized familiar workspace at ${workspacePath}`);
}

async function runDaemon(workspaceInput?: string): Promise<void> {
	const workspacePath = resolveWorkspaceInput(workspaceInput);
	const envPath = resolve(workspacePath, ".env");
	loadWorkspaceEnv(envPath, false);
	const config = await loadConfig(workspacePath);
	const reloadConfig = async () => {
		loadWorkspaceEnv(envPath, true);
		return loadConfig(workspacePath);
	};
	await ensureWorkspaceDirs(configuredWorkspaceDirs(config));
	const removedAttachments = await cleanupGeneratedAttachments(config);
	if (removedAttachments > 0) {
		console.log(`Removed ${removedAttachments} expired attachment(s)`);
	}
	const retention = await runDataRetention(config);
	const removedData = retention.chat + retention.transcripts + retention.payloads;
	if (removedData > 0) {
		console.log(`Removed ${removedData} expired data file(s)`);
	}
	const settings = await loadSettingsStore(config);
	const modelRuntime = await createModelRuntime(config);
	const memoryService = createMemoryService(config, { modelRuntime });
	await memoryService.indexDiaries().catch((error) => console.error("initial diary indexing failed", error));
	memoryService.watchDiaries();
	const familiarAgent = await createFamiliarAgent(config, settings, memoryService, { reloadConfig, modelRuntime });
	const hotReload = startWorkspaceHotReload({ workspacePath: config.workspacePath, familiarAgent });
	const agentCore = createAgentCore({ config, familiarAgent, memoryService });
	let stopping = false;
	let discordDaemon: ReturnType<typeof startDiscordDaemon> | undefined;
	let qqDaemon: ReturnType<typeof startQqDaemon> | undefined;
	let webDaemon: Awaited<ReturnType<typeof startWebDaemon>> | undefined;
	const stop = async (exitCode = 0) => {
		if (stopping) return;
		stopping = true;
		console.log("Stopping familiar");
		hotReload.close();
		await Promise.all([webDaemon?.stop(), discordDaemon?.stop(), qqDaemon?.stop()]);
		await agentCore.stop();
		memoryService.close();
		process.exit(exitCode);
	};
	const requestRestart = (): string => {
		console.log("Restart requested");
		setTimeout(() => void stop(75), RESTART_EXIT_DELAY_MS);
		return "Restart requested. If Familiar is managed by launchd/systemd, it should come back automatically; otherwise run familiar run again.";
	};
	const identity = await loadOwnerIdentity(config.workspace.dataDir);
	const token = config.discord.token;
	if (identity && config.discord.ownerId) await agentCore.useCachedIdentity(identity);
	await agentCore.start();
	webDaemon = await startWebDaemon(config, familiarAgent, agentCore, { restart: requestRestart });
	if (config.discord.enabled && token) {
		discordDaemon = startDiscordDaemon(config, token, familiarAgent, settings, memoryService, agentCore, {
			restart: requestRestart,
		});
	}
	if (config.qq.enabled && config.qq.wsUrl) {
		qqDaemon = startQqDaemon(config, familiarAgent, settings, agentCore, { restart: requestRestart });
	}
	console.log(`familiar running for workspace ${config.workspacePath}`);
	console.log("agent sessions are created per channel");
	console.log(`settings=${settings.path}`);

	process.once("SIGINT", () => void stop(0));
	process.once("SIGTERM", () => void stop(0));
	await new Promise<void>(() => {});
}

function usage(): string {
	return [
		"Usage:",
		"  familiar --help",
		"  familiar --version",
		"  familiar init [workspace]",
		"  familiar run [workspace]",
		"  familiar login [provider]",
		"  familiar logout [provider]",
		"  familiar memory [workspace] <subcommand>",
		"  familiar install-service [workspace]",
		"  familiar uninstall-service [workspace]",
		"  familiar start [workspace]",
		"  familiar stop [workspace]",
		"  familiar restart [workspace]",
		"  familiar status [workspace]",
		"  familiar upgrade [workspace] [--with-opencli]",
		"",
		`Default workspace: ${DEFAULT_WORKSPACE_PATH}`,
	].join("\n");
}

async function main(): Promise<void> {
	const [, , command, workspace, ...rest] = process.argv;
	if (!command || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}
	if (command === "--version" || command === "-v") {
		console.log(await packageVersion());
		return;
	}
	if (command === "init") {
		await initWorkspace(workspace);
		return;
	}
	if (command === "run") {
		await runDaemon(workspace);
		return;
	}
	if (command === "login" || command === "logout") {
		if (rest.length > 0) throw new Error(`Usage: familiar ${command} [provider]`);
		await runAuthCommand(command, workspace);
		return;
	}
	if (command === "memory") {
		const { workspacePath, args } = parseMemoryArgs(workspace, rest);
		if (isMemoryHelp(args)) {
			console.log(memoryHelp());
			return;
		}
		const envPath = resolve(workspacePath, ".env");
		loadWorkspaceEnv(envPath, false);
		const config = await loadConfig(workspacePath);
		await ensureWorkspaceDirs(configuredWorkspaceDirs(config));
		await runMemoryOperator(config, args);
		return;
	}
	if (command === "install-service") {
		console.log(formatServiceResult(await installService(resolveWorkspaceInput(workspace))));
		return;
	}
	if (command === "uninstall-service") {
		console.log(formatServiceResult(await uninstallService(resolveWorkspaceInput(workspace))));
		return;
	}
	if (command === "start") {
		console.log(formatServiceResult(await startService(resolveWorkspaceInput(workspace))));
		return;
	}
	if (command === "stop") {
		console.log(formatServiceResult(await stopService(resolveWorkspaceInput(workspace))));
		return;
	}
	if (command === "restart") {
		console.log(formatServiceResult(await restartService(resolveWorkspaceInput(workspace))));
		return;
	}
	if (command === "status") {
		console.log(formatServiceResult(await serviceStatus(resolveWorkspaceInput(workspace))));
		return;
	}
	if (command === "upgrade") {
		const upgradeArgs = [workspace, ...rest].filter((arg): arg is string => arg !== undefined);
		const upgradeOpenCli = upgradeArgs.includes("--with-opencli");
		const workspaceArgs = upgradeArgs.filter((arg) => arg !== "--with-opencli");
		if (workspaceArgs.length > 1 || upgradeArgs.some((arg) => arg.startsWith("-") && arg !== "--with-opencli")) {
			console.error(usage());
			process.exitCode = 1;
			return;
		}
		console.log(`Upgrading @qearlyao/familiar${upgradeOpenCli ? " and OpenCLI" : ""} globally...`);
		console.log(
			formatServiceResult(await upgradeFamiliar(resolveWorkspaceInput(workspaceArgs[0]), { upgradeOpenCli })),
		);
		return;
	}
	console.error(usage());
	process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
