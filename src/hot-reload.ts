import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

import type { FamiliarAgent } from "./agent.js";

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
type WatchHandle = {
	close(): void;
	on(event: "error", listener: (error: Error) => void): unknown;
};
type WatchFn = (path: string, options: { persistent: boolean }, listener: WatchListener) => WatchHandle;
type ListSkillDirectoriesFn = (skillsPath: string) => Promise<string[]>;

export interface HotReloadWatcher {
	close(): void;
}

export interface HotReloadOptions {
	workspacePath: string;
	familiarAgent: Pick<FamiliarAgent, "reload">;
	debounceMs?: number;
	logger?: Pick<Console, "info" | "warn" | "error">;
	watch?: WatchFn;
	listSkillDirectories?: ListSkillDirectoriesFn;
}

const ROOT_FILES = new Set(["config.toml", ".env", "SOUL.md", "USER.md", "MEMORY.md", "INNER.md", "HEARTBEAT.md"]);
const SKILLS_DIR = "skills";

function isEnoent(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function shouldReloadForPath(workspacePath: string, changedPath: string): boolean {
	const relativePath = relative(workspacePath, resolve(changedPath));
	if (!relativePath || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) return false;
	if (ROOT_FILES.has(relativePath)) return true;
	return relativePath === SKILLS_DIR || relativePath.startsWith(`${SKILLS_DIR}${sep}`);
}

function isAtOrInsidePath(parentPath: string, childPath: string): boolean {
	const relativePath = relative(parentPath, childPath);
	return !relativePath || (!relativePath.startsWith("..") && !relativePath.split(sep).includes(".."));
}

async function listSkillDirectories(skillsPath: string): Promise<string[]> {
	try {
		const entries = await readdir(skillsPath, { withFileTypes: true });
		const directories: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const path = resolve(skillsPath, entry.name);
			directories.push(path, ...(await listSkillDirectories(path)));
		}
		return directories;
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

export function startWorkspaceHotReload(options: HotReloadOptions): HotReloadWatcher {
	const workspacePath = resolve(options.workspacePath);
	const debounceMs = options.debounceMs ?? 750;
	const logger = options.logger ?? console;
	const watchFn = options.watch ?? watch;
	const listSkills = options.listSkillDirectories ?? listSkillDirectories;
	const watchers = new Map<string, WatchHandle>();
	let debounce: NodeJS.Timeout | undefined;
	let reloadQueue: Promise<void> = Promise.resolve();
	let closed = false;

	const closeWatcher = (path: string): void => {
		const watcher = watchers.get(path);
		if (!watcher) return;
		watcher.close();
		watchers.delete(path);
	};

	const close = (): void => {
		closed = true;
		if (debounce) clearTimeout(debounce);
		debounce = undefined;
		for (const watcher of watchers.values()) watcher.close();
		watchers.clear();
	};

	const scheduleReload = (reason: string): void => {
		if (closed) return;
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = undefined;
			reloadQueue = reloadQueue.then(async () => {
				try {
					const result = await options.familiarAgent.reload();
					logger.info(`hot reload complete after ${reason}\n${result}`);
				} catch (error) {
					logger.error("hot reload failed", error);
				}
			});
		}, debounceMs);
	};

	const watchDirectory = (path: string): void => {
		const dirPath = resolve(path);
		if (closed || watchers.has(dirPath)) return;
		try {
			const watcher = watchFn(dirPath, { persistent: true }, (_eventType, filename) => {
				const changedPath = filename ? resolve(dirPath, String(filename)) : dirPath;
				if (basename(dirPath) === SKILLS_DIR || relative(workspacePath, dirPath).startsWith(`${SKILLS_DIR}${sep}`)) {
					void refreshSkillWatchers();
				}
				if (!filename || shouldReloadForPath(workspacePath, changedPath) || shouldReloadForPath(workspacePath, dirPath)) {
					scheduleReload(relative(workspacePath, changedPath) || relative(workspacePath, dirPath) || ".");
				}
			});
			watcher.on("error", (error) => {
				logger.warn(`hot reload watcher failed for ${dirPath}`, error);
				closeWatcher(dirPath);
			});
			watchers.set(dirPath, watcher);
		} catch (error) {
			if (isEnoent(error)) return;
			logger.warn(`hot reload watcher could not watch ${dirPath}`, error);
		}
	};

	const refreshSkillWatchers = async (): Promise<void> => {
		if (closed) return;
		const skillsPath = resolve(workspacePath, SKILLS_DIR);
		const wanted = new Set([skillsPath, ...(await listSkills(skillsPath))]);
		for (const path of wanted) watchDirectory(path);
		for (const path of watchers.keys()) {
			if (path !== workspacePath && isAtOrInsidePath(skillsPath, path) && !wanted.has(path)) {
				closeWatcher(path);
			}
		}
	};

	watchDirectory(workspacePath);
	void refreshSkillWatchers().catch((error) => logger.warn("hot reload skill watcher setup failed", error));

	return { close };
}

export const __hotReloadTest = {
	shouldReloadForPath,
	listSkillDirectories,
};
