import { resolve } from "node:path";

import { type LoadSkillsResult, loadSkills, type Skill } from "@earendil-works/pi-coding-agent";

import type { Config } from "./config.js";

export type FamiliarSkillsResult = LoadSkillsResult;

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function loadFamiliarSkills(config: Config): FamiliarSkillsResult {
	return loadSkills({
		cwd: config.workspacePath,
		agentDir: config.workspacePath,
		skillPaths: [resolve(config.workspacePath, "skills")],
		includeDefaults: false,
	});
}

export function formatFamiliarSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = ["<available_skills>"];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function logSkillDiagnostics(result: FamiliarSkillsResult): void {
	for (const diagnostic of result.diagnostics) {
		console.warn(`skill ${diagnostic.type}: ${diagnostic.path}: ${diagnostic.message}`);
	}
}
