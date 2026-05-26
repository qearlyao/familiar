import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
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
