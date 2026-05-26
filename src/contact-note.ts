import { resolve } from "node:path";

import { readFileOrNull } from "./util/fs.js";

let contactNotePath = resolve(process.cwd(), "CONTACT.md");
let cachedNickname: string | null = null;

export function setContactNotePath(path: string): void {
	contactNotePath = path;
	cachedNickname = null;
}

export async function loadContactNote(): Promise<string | null> {
	return readFileOrNull(contactNotePath, "utf8");
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
