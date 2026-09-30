import { type Dirent, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

let tempFileCounter = 0;

/** a path the agent names: `~/...` from home, absolute as given, anything else from the workspace */
export function resolveAgentPath(workspacePath: string, raw: string): string {
	return raw === "~" || raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : resolve(workspacePath, raw);
}

export function isEnoent(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export async function readFileOrNull(path: string, encoding: BufferEncoding): Promise<string | null> {
	try {
		return await readFile(path, encoding);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function fsyncFile(path: string): Promise<void> {
	const handle = await open(path, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.${++tempFileCounter}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fsyncFile(tmpPath);
	await rename(tmpPath, path);
}

export function createWriteQueue(logLabel: string): <T>(write: () => Promise<T>) => Promise<T> {
	let queue = Promise.resolve();
	return async <T>(write: () => Promise<T>): Promise<T> => {
		const run = queue.then(write, write);
		queue = run.then(
			() => undefined,
			(error) => {
				console.error(`${logLabel} write failed`, error);
			},
		);
		return run;
	};
}

/** One JSON file under data/settings: read once and cached, written atomically in order.
    `parse` shapes whatever is on disk (or nothing) into the stored value. */
export function jsonSettingsStore<T>(file: string, parse: (raw: unknown) => T) {
	let path = resolve(process.cwd(), "data", "settings", file);
	let cache: T | undefined;
	const enqueueWrite = createWriteQueue(file);
	return {
		setDataDir(dataDir: string): void {
			path = resolve(dataDir, "settings", file);
			cache = undefined;
		},
		load(): T {
			if (cache === undefined) {
				try {
					cache = parse(JSON.parse(readFileSync(path, "utf8")));
				} catch (error) {
					if (!isEnoent(error)) throw error;
					cache = parse(undefined);
				}
			}
			return cache;
		},
		async save(value: T): Promise<void> {
			cache = value;
			await enqueueWrite(() => atomicWriteJson(path, value));
		},
	};
}

/** deletes regular files under root older than retentionDays; 0 keeps everything */
export async function removeOldFiles(root: string, retentionDays: number, now: number): Promise<number> {
	if (retentionDays <= 0) return 0;
	const cutoff = now - retentionDays * 86_400_000;
	let removed = 0;
	for (const path of await listFiles(root)) {
		const fileStat = await lstat(path).catch((error) => {
			if (isEnoent(error)) return null;
			throw error;
		});
		if (!fileStat?.isFile() || fileStat.mtimeMs > cutoff) continue;
		await rm(path).catch((error) => {
			if (!isEnoent(error)) throw error;
		});
		removed += 1;
	}
	return removed;
}

async function listFiles(root: string): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(root, entry.name);
			if (entry.isDirectory()) return listFiles(path);
			return entry.isFile() ? [path] : [];
		}),
	);
	return nested.flat();
}
