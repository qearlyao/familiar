import { join } from "node:path";

import type { Config } from "../config.js";

export interface WebMeme {
	name: string;
	url: string;
}

export interface WebMemeFamily {
	name: string;
	memes: WebMeme[];
}

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
		if (!currentFamily || !line.startsWith("- ") || !line.includes(" — ")) continue;
		const separator = line.indexOf(" — ");
		const name = line.slice(2, separator).trim();
		const suffix = line.slice(separator + " — ".length).trim();
		if (!name || !suffix) continue;
		currentFamily.memes.push({ name, url: `https://files.catbox.moe/${suffix}` });
	}
	return families;
}

export function memeCatalogPath(config: Config): string {
	return join(config.workspacePath, "skills", "memes", "SKILL.md");
}
