#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

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
import { createAgentCore } from "./runtime/agent-core.js";
import { startWebDaemon } from "./web/daemon.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, "..");
const DEFAULT_WORKSPACE_PATH = resolve(homedir(), ".familiar");
const MEMORY_SUBCOMMANDS = new Set(["status", "doctor", "reindex", "backfill", "prune", "backup", "help", "--help"]);
const RESTART_EXIT_DELAY_MS = 1500;

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
	if (existsSync(envPath)) {
		loadDotenv({ path: envPath, override: false });
	}
	const config = await loadConfig(workspacePath);
	const reloadConfig = async () => {
		if (existsSync(envPath)) {
			loadDotenv({ path: envPath, override: true });
		}
		return loadConfig(workspacePath);
	};
	await ensureWorkspaceDirs(configuredWorkspaceDirs(config));
	const removedAttachments = await cleanupGeneratedAttachments(config);
	if (removedAttachments > 0) {
		console.log(`Removed ${removedAttachments} expired generated attachment(s)`);
	}
	const retention = await runDataRetention(config);
	const removedData = retention.chat + retention.transcripts + retention.payloads;
	if (removedData > 0) {
		console.log(`Removed ${removedData} expired data file(s)`);
	}
	const settings = await loadSettingsStore(config);
	const memoryService = createMemoryService(config);
	await memoryService.indexDiaries().catch((error) => console.error("initial diary indexing failed", error));
	memoryService.watchDiaries();
	const familiarAgent = await createFamiliarAgent(config, settings, memoryService, { reloadConfig });
	const hotReload = startWorkspaceHotReload({ workspacePath: config.workspacePath, familiarAgent });
	const agentCore = createAgentCore({ config, familiarAgent, memoryService });
	let stopping = false;
	let discordDaemon: ReturnType<typeof startDiscordDaemon> | undefined;
	let webDaemon: Awaited<ReturnType<typeof startWebDaemon>> | undefined;
	const stop = async (exitCode = 0) => {
		if (stopping) return;
		stopping = true;
		console.log("Stopping familiar");
		hotReload.close();
		await Promise.all([webDaemon?.stop(), discordDaemon?.stop()]);
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
	if (!identity && !token) {
		throw new Error(
			"First-time setup needs a DISCORD_TOKEN to establish owner identity. Set DISCORD_TOKEN and run again.",
		);
	}
	// The scheduler starts with the first session source to arrive: the cached identity
	// here, or the live Discord connection below when there is no cache yet.
	if (identity) await agentCore.useCachedIdentity(identity);
	webDaemon = await startWebDaemon(config, familiarAgent, agentCore, { restart: requestRestart });
	if (token) {
		discordDaemon = startDiscordDaemon(config, token, familiarAgent, settings, memoryService, agentCore, {
			restart: requestRestart,
		});
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
		"  familiar memory [workspace] <subcommand>",
		"  familiar install-service [workspace]",
		"  familiar uninstall-service [workspace]",
		"  familiar start [workspace]",
		"  familiar stop [workspace]",
		"  familiar restart [workspace]",
		"  familiar status [workspace]",
		"  familiar upgrade [workspace]",
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
	if (command === "memory") {
		const { workspacePath, args } = parseMemoryArgs(workspace, rest);
		if (isMemoryHelp(args)) {
			console.log(memoryHelp());
			return;
		}
		const envPath = resolve(workspacePath, ".env");
		if (existsSync(envPath)) {
			loadDotenv({ path: envPath, override: false });
		}
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
		console.log("Upgrading @qearlyao/familiar and OpenCLI globally...");
		await upgradeFamiliar(resolveWorkspaceInput(workspace));
		return;
	}
	console.error(usage());
	process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
