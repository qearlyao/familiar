import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../src/config.js";
import { buildSystemPrompt } from "../src/persona.js";
import { formatFamiliarSkillsForPrompt, loadFamiliarSkills } from "../src/skills.js";
import { createWorkspace, minimalConfigToml } from "./helpers.js";

describe("Familiar skills", () => {
	it("loads workspace skills from skills/ and formats only the skill XML block", async () => {
		const workspacePath = await createWorkspace(minimalConfigToml());
		const skillDir = resolve(workspacePath, "skills", "image-style");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			resolve(skillDir, "SKILL.md"),
			`---
name: image-style
description: Use for recurring image style preferences.
---

# Image Style

Prefer the reference board.
`,
			"utf8",
		);

		const previousDiscordToken = process.env.DISCORD_TOKEN;
		process.env.DISCORD_TOKEN = "discord-token";
		const config = await loadConfig(workspacePath);
		if (previousDiscordToken === undefined) delete process.env.DISCORD_TOKEN;
		else process.env.DISCORD_TOKEN = previousDiscordToken;
		const result = loadFamiliarSkills(config);
		const block = formatFamiliarSkillsForPrompt(result.skills);

		assert.equal(result.diagnostics.length, 0);
		assert.equal(result.skills.length, 1);
		assert.match(block, /^<available_skills>/);
		assert.match(block, /<name>image-style<\/name>/);
		assert.match(block, /<description>Use for recurring image style preferences\.<\/description>/);
		assert.match(block, new RegExp(`<location>${resolve(skillDir, "SKILL.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</location>`));
		assert.doesNotMatch(block, /The following skills provide specialized instructions/);
		assert.doesNotMatch(block, /Prefer the reference board/);
	});

	it("appends visible skills inside the persona system reminder after instructions", () => {
		const prompt = buildSystemPrompt(
			{ soul: "# Soul", user: "# User", memory: "# Memory" },
			"<available_skills>\n</available_skills>",
		);

		const instructionsEnd = prompt.indexOf("</instructions>");
		const reminderEnd = prompt.indexOf("</system-reminder>");
		const skillsStart = prompt.indexOf("<available_skills>");

		assert.ok(instructionsEnd > 0);
		assert.ok(reminderEnd > 0);
		assert.ok(skillsStart > instructionsEnd);
		assert.ok(skillsStart < reminderEnd);
	});

	it("omits skills disabled for model invocation", () => {
		const path = "/workspace/skills/private-skill/SKILL.md";
		const block = formatFamiliarSkillsForPrompt([
			{
				name: "private-skill",
				description: "Hidden unless explicitly invoked.",
				filePath: path,
				baseDir: "/workspace/skills/private-skill",
				sourceInfo: createSyntheticSourceInfo(path, { source: "local", baseDir: "/workspace/skills/private-skill" }),
				disableModelInvocation: true,
			},
		]);

		assert.equal(block, "");
	});
});
