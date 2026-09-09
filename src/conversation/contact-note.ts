import { resolve } from "node:path";

import { readFileOrNull } from "../util/fs.js";
import { parseContactNickname } from "./contact-nickname.js";

let contactNotePath = resolve(process.cwd(), "CONTACT.md");
let cachedNickname: string | null = null;

export function setContactNotePath(path: string): void {
	contactNotePath = path;
	cachedNickname = null;
}

export async function loadContactNote(): Promise<string | null> {
	return readFileOrNull(contactNotePath, "utf8");
}

export async function refreshContactNote(): Promise<void> {
	cachedNickname = parseContactNickname(await loadContactNote(), "");
}

export function applyContactNoteContent(raw: string): void {
	cachedNickname = parseContactNickname(raw, "");
}

export function getContactNickname(fallback: string): string {
	return cachedNickname || fallback;
}
