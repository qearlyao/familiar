#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { createFamiliarAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { startDiscordDaemon } from "./discord.js";
import { cleanupGeneratedAttachments } from "./generated-media.js";
import { loadSettingsStore } from "./settings.js";
import { startWebDaemon } from "./web.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SOURCE_DIR, "..");

async function initWorkspace(workspaceInput: string): Promise<void> {
	const workspacePath = resolve(workspaceInput);
	await mkdir(workspacePath, { recursive: true });
	const envPath = resolve(workspacePath, ".env");
	if (!existsSync(envPath)) {
		await copyFile(resolve(PROJECT_ROOT, ".env.example"), envPath);
	}
	await copyFile(resolve(PROJECT_ROOT, "config.example.toml"), resolve(workspacePath, "config.toml"));
	await copyFile(resolve(PROJECT_ROOT, "SOUL.md"), resolve(workspacePath, "SOUL.md"));
	await copyFile(resolve(PROJECT_ROOT, "USER.md"), resolve(workspacePath, "USER.md"));
	await copyFile(resolve(PROJECT_ROOT, "MEMORY.md"), resolve(workspacePath, "MEMORY.md"));
	await mkdir(resolve(workspacePath, "data"), { recursive: true });
	console.log(`Initialized familiar workspace at ${workspacePath}`);
}

async function runDaemon(workspaceInput: string): Promise<void> {
	const workspacePath = resolve(workspaceInput);
	const envPath = resolve(workspacePath, ".env");
	if (existsSync(envPath)) {
		loadDotenv({ path: envPath, override: false });
	}
	const config = await loadConfig(workspacePath);
	await mkdir(config.workspace.dataDir, { recursive: true });
	const removedAttachments = await cleanupGeneratedAttachments(config);
	if (removedAttachments > 0) {
		console.log(`Removed ${removedAttachments} expired generated attachment(s)`);
	}
	const settings = await loadSettingsStore(config);
	const familiarAgent = await createFamiliarAgent(config, settings);
	const discordDaemon = await startDiscordDaemon(config, familiarAgent, settings);
	const webDaemon = await startWebDaemon(config, familiarAgent, discordDaemon);
	console.log(`familiar running for workspace ${config.workspacePath}`);
	console.log("agent sessions are created per channel");
	console.log(`settings=${settings.path}`);

	const stop = async () => {
		console.log("Stopping familiar");
		await Promise.all([webDaemon.stop(), discordDaemon.stop()]);
		process.exit(0);
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
	await new Promise<void>(() => {});
}

function usage(): string {
	return [
		"Usage:",
		"  familiar init <workspace>",
		"  familiar run <workspace>",
		"  familiar install-service",
		"  familiar status",
		"  familiar upgrade",
	].join("\n");
}

async function main(): Promise<void> {
	const [, , command, workspace] = process.argv;
	if (command === "init") {
		if (!workspace) throw new Error(`Missing workspace\n${usage()}`);
		await initWorkspace(workspace);
		return;
	}
	if (command === "run") {
		if (!workspace) throw new Error(`Missing workspace\n${usage()}`);
		await runDaemon(workspace);
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
