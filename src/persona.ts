import { readFile } from "node:fs/promises";

import type { Config } from "./config.js";

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

export function buildSystemPrompt(persona: Persona): string {
	const files: SystemPromptFile[] = [
		{ name: "SOUL.md", contents: persona.soul },
		{ name: "USER.md", contents: persona.user },
		{ name: "MEMORY.md", contents: persona.memory },
	];
	const renderedFiles = files.map(renderSystemPromptFile).join("\n\n");
	return `<system-reminder>
${renderedFiles}

<instructions>
If you learn something durable about the user, you may edit MEMORY.md to keep it. Stay yourself.
Relative paths resolve from the workspace root; absolute paths and ~/... are also accepted.
You may output [[FAMILIAR_SILENT]] to end the conversation without sending a visible reply, optionally followed by a short reason.
</instructions>
</system-reminder>`;
}

const NAME_FIELD_RE = /^\s*[-*]?\s*\*\*Name:\*\*\s*(.+?)\s*$/im;

export function parsePersonaName(soul: string, fallback = "Familiar"): string {
	const match = soul.match(NAME_FIELD_RE);
	if (!match) return fallback;
	return match[1].replace(/^["'`*_]+|["'`*_]+$/g, "").trim() || fallback;
}
