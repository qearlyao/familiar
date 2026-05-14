import { readFile } from "node:fs/promises";

import type { Config } from "./config.js";

export interface Persona {
	soul: string;
	user: string;
	memory: string;
	inner: string | null;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readOptionalPersonaFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export async function loadPersona(config: Config): Promise<Persona> {
	const [soul, user, memory, inner] = await Promise.all([
		readFile(config.persona.soul, "utf8"),
		readFile(config.persona.user, "utf8"),
		readFile(config.persona.memory, "utf8"),
		readOptionalPersonaFile(config.persona.inner),
	]);
	return { soul, user, memory, inner };
}

type SystemPromptFile = {
	name: string;
	contents: string;
};

function renderSystemPromptFile(file: SystemPromptFile): string {
	return `<file name="${file.name}">
${file.contents.trim()}
</file>`;
}

export function buildSystemPrompt(persona: Persona, skillsBlock = ""): string {
	const files: SystemPromptFile[] = [
		{ name: "SOUL.md", contents: persona.soul },
		{ name: "USER.md", contents: persona.user },
		{ name: "MEMORY.md", contents: persona.memory },
		...(persona.inner !== null ? [{ name: "INNER.md", contents: persona.inner }] : []),
	];
	const renderedFiles = files.map(renderSystemPromptFile).join("\n\n");
	const renderedSkillsBlock = skillsBlock.trim() ? `\n\n${skillsBlock.trim()}` : "";
	return `<system-reminder>
${renderedFiles}

<instructions>
you can edit MEMORY.md when something about her is worth keeping.
output [[FAMILIAR_SILENT]] if there's nothing worth saying — quiet's a real choice.
</instructions>
${renderedSkillsBlock}
</system-reminder>`;
}

const NAME_FIELD_RE = /^\s*[-*]?\s*\*\*Name:\*\*\s*(.+?)\s*$/im;

export function parsePersonaName(soul: string, fallback = "Familiar"): string {
	const match = soul.match(NAME_FIELD_RE);
	if (!match) return fallback;
	return match[1].replace(/^["'`*_]+|["'`*_]+$/g, "").trim() || fallback;
}
