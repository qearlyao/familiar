import { join } from "node:path";

import type { Config } from "../config/index.js";

export interface WebMeme {
	name: string;
	url: string;
}

export interface WebMemeFamily {
	name: string;
	memes: WebMeme[];
}

// `- name — https://any.host/image.png`; an em dash, en dash, or plain hyphen separates name from link.
const MEME_LINE_RE = /^- (.+?)\s+[—–-]\s+(https?:\/\/\S+)\s*$/;

export function parseMemeCatalog(markdown: string): WebMemeFamily[] {
	const families: WebMemeFamily[] = [];
	let currentFamily: WebMemeFamily | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const familyMatch = line.match(/^## (.+)$/);
		if (familyMatch) {
			currentFamily = { name: familyMatch[1]?.trim() ?? "", memes: [] };
			families.push(currentFamily);
			continue;
		}
		const memeMatch = currentFamily ? line.trim().match(MEME_LINE_RE) : null;
		if (!currentFamily || !memeMatch) continue;
		currentFamily.memes.push({ name: (memeMatch[1] as string).trim(), url: memeMatch[2] as string });
	}
	return families.filter((family) => family.memes.length > 0);
}

export function memeCatalogPath(config: Config): string {
	return join(config.workspacePath, "skills", "memes", "SKILL.md");
}
