import { readFile } from "node:fs/promises";

import type { Config } from "../config/index.js";
import type { FamiliarSkillsResult } from "./skills.js";

export interface Persona {
	soul: string;
	user: string;
	memory: string;
}

export async function loadPersona(config: Config): Promise<Persona> {
	const [soul, user, memory] = await Promise.all([
		readFile(config.persona.soul, "utf8"),
		readFile(config.persona.user, "utf8"),
		readFile(config.persona.memory, "utf8"),
	]);
	return { soul, user, memory };
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

function systemPromptFiles(persona: Persona): SystemPromptFile[] {
	return [
		{ name: "SOUL.md", contents: persona.soul },
		{ name: "USER.md", contents: persona.user },
		{ name: "MEMORY.md", contents: persona.memory },
	];
}

/** What went into the system prompt, without its contents: persona files hold private details. */
export function logPromptSources(persona: Persona, skills: FamiliarSkillsResult): void {
	console.log(
		`prompt files loaded: ${systemPromptFiles(persona)
			.map((file) => file.name)
			.join(", ")}`,
	);
	const names = skills.skills.map((skill) => (skill.disableModelInvocation ? `${skill.name} (hidden)` : skill.name));
	console.log(`skills loaded: ${names.length ? `${names.length} (${names.join(", ")})` : "none"}`);
	for (const diagnostic of skills.diagnostics) {
		console.warn(`skill ${diagnostic.type}: ${diagnostic.path}: ${diagnostic.message}`);
	}
}

export function buildSystemPrompt(persona: Persona, diariesDir: string, skillsBlock = ""): string {
	const renderedFiles = systemPromptFiles(persona).map(renderSystemPromptFile).join("\n\n");
	const renderedSkillsBlock = skillsBlock.trim() ? `\n\n${skillsBlock.trim()}` : "";
	return `<system-reminder>
${renderedFiles}

<note_to_self>
you can edit MEMORY.md when something about her is worth keeping.
CONTACT.md is what you call her in your contact book — like a nickname only you use. edit it whenever it feels right.
your diaries are in ${diariesDir}.
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
