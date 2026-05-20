import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

let contactNotePath = resolve(process.cwd(), "CONTACT.md");
let cachedNickname: string | null = null;

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function setContactNotePath(path: string): void {
	contactNotePath = path;
	cachedNickname = null;
}

export async function loadContactNote(): Promise<string | null> {
	try {
		return await readFile(contactNotePath, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export function parseContactNickname(raw: string | null, fallback: string): string {
	let remaining = raw?.trim() ?? "";
	while (remaining.startsWith("<!--")) {
		const end = remaining.indexOf("-->");
		if (end === -1) return fallback;
		remaining = remaining.slice(end + 3).trim();
	}
	const firstLine = remaining
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("<!--"));
	return firstLine ?? fallback;
}

export async function refreshContactNote(): Promise<void> {
	cachedNickname = parseContactNickname(await loadContactNote(), "");
}

export function getContactNickname(fallback: string): string {
	return cachedNickname || fallback;
}
