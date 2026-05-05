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

export function buildSystemPrompt(persona: Persona): string {
	return `${persona.soul.trim()}\n\n${persona.user.trim()}\n\n${persona.memory.trim()}\n<system-reminder>\nIf you learn something durable about the user, you may edit MEMORY.md to keep it. Stay yourself.\nYou may output [[FAMILIAR_SILENT]] to end the conversation without sending a visible reply, optionally followed by a short reason.\n</system-reminder>`;
}
