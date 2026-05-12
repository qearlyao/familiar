#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { createFamiliarAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { runDataRetention } from "./data-retention.js";
import { startDiscordDaemon } from "./discord.js";
import { cleanupGeneratedAttachments } from "./generated-media.js";
import { memoryHelp, runMemoryOperator } from "./memory/operator.js";
import { createMemoryService } from "./memory/service.js";
import { loadSettingsStore } from "./settings.js";
import { startWebDaemon } from "./web.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, "..");
const DEFAULT_WORKSPACE_PATH = resolve(homedir(), ".familiar");
const MEMORY_SUBCOMMANDS = new Set(["status", "doctor", "reindex", "backfill", "prune", "backup", "help", "--help"]);

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

async function initWorkspace(workspaceInput?: string): Promise<void> {
	const workspacePath = resolveWorkspaceInput(workspaceInput);
	await mkdir(workspacePath, { recursive: true });
	const envPath = resolve(workspacePath, ".env");
	if (!existsSync(envPath)) {
		await copyFile(resolve(PROJECT_ROOT, ".env.example"), envPath);
	}
	await copyFile(resolve(PROJECT_ROOT, "config.example.toml"), resolve(workspacePath, "config.toml"));
	await copyFile(resolve(PROJECT_ROOT, "SOUL.md"), resolve(workspacePath, "SOUL.md"));
	await copyFile(resolve(PROJECT_ROOT, "USER.md"), resolve(workspacePath, "USER.md"));
	await copyFile(resolve(PROJECT_ROOT, "MEMORY.md"), resolve(workspacePath, "MEMORY.md"));
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
	const familiarAgent = await createFamiliarAgent(config, settings, memoryService);
	const discordDaemon = await startDiscordDaemon(config, familiarAgent, settings, memoryService);
	const webDaemon = await startWebDaemon(config, familiarAgent, discordDaemon);
	console.log(`familiar running for workspace ${config.workspacePath}`);
	console.log("agent sessions are created per channel");
	console.log(`settings=${settings.path}`);

	const stop = async () => {
		console.log("Stopping familiar");
		await Promise.all([webDaemon.stop(), discordDaemon.stop()]);
		memoryService.close();
		process.exit(0);
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
	await new Promise<void>(() => {});
}

function usage(): string {
	return [
		"Usage:",
		"  familiar init [workspace]",
		"  familiar run [workspace]",
		"  familiar memory [workspace] <subcommand>",
		"  familiar install-service",
		"  familiar status",
		"  familiar upgrade",
		"",
		`Default workspace: ${DEFAULT_WORKSPACE_PATH}`,
	].join("\n");
}

async function main(): Promise<void> {
	const [, , command, workspace, ...rest] = process.argv;
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
	if (command === "install-service" || command === "status" || command === "upgrade") {
		console.log("not yet implemented");
		return;
	}
	console.error(usage());
	process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
