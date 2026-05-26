import { readFile } from "node:fs/promises";

import type { Config } from "./config.js";
import { readFileOrNull } from "./util/fs.js";

export interface Persona {
	soul: string;
	user: string;
	memory: string;
	inner: string | null;
}

export async function loadPersona(config: Config): Promise<Persona> {
	const [soul, user, memory, inner] = await Promise.all([
		readFile(config.persona.soul, "utf8"),
		readFile(config.persona.user, "utf8"),
		readFile(config.persona.memory, "utf8"),
		readFileOrNull(config.persona.inner, "utf8"),
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

<note_to_self>
you can edit MEMORY.md when something about her is worth keeping.
CONTACT.md is what you call her in your contact book — like a nickname only you use. edit it whenever it feels right.
when there's nothing worth saying, reply with exactly the literal string [[FAMILIAR_SILENT]]. quiet's a real choice.
</note_to_self>
${renderedSkillsBlock}
</system-reminder>`;
}

const NAME_FIELD_RE = /^\s*[-*]?\s*\*\*Name:\*\*\s*(.+?)\s*$/im;

export function parsePersonaName(soul: string, fallback = "Familiar"): string {
	const match = soul.match(NAME_FIELD_RE);
	if (!match) return fallback;
	return match[1].replace(/^["'`*_]+|["'`*_]+$/g, "").trim() || fallback;
}
