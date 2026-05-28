import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../src/config.js";
import { buildSystemPrompt, loadPersona } from "../src/persona.js";
import { formatFamiliarSkillsForPrompt, loadFamiliarSkills } from "../src/skills.js";
import { createWorkspace, minimalConfigToml, withDiscordToken } from "./helpers.js";

describe("Familiar skills", () => {
	it("loads workspace skills from skills/ and formats only the skill XML block", async (t) => {
		const workspacePath = await createWorkspace(t, minimalConfigToml());
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

		const config = await withDiscordToken(() => loadConfig(workspacePath));
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

	it("appends visible skills inside the persona system reminder after note-to-self", () => {
		const prompt = buildSystemPrompt(
			{ soul: "# Soul", user: "# User", memory: "# Memory", inner: null },
			"<available_skills>\n</available_skills>",
		);

		const noteEnd = prompt.indexOf("</note_to_self>");
		const reminderEnd = prompt.indexOf("</system-reminder>");
		const skillsStart = prompt.indexOf("<available_skills>");

		assert.ok(noteEnd > 0);
		assert.ok(reminderEnd > 0);
		assert.ok(skillsStart > noteEnd);
		assert.ok(skillsStart < reminderEnd);
	});

	it("omits missing optional INNER.md from the persona prompt", async (t) => {
		const workspacePath = await createWorkspace(t, minimalConfigToml());
		await withDiscordToken(async () => {
			const config = await loadConfig(workspacePath);
			const persona = await loadPersona(config);

			assert.equal(persona.inner, null);
			assert.doesNotMatch(buildSystemPrompt(persona), /INNER\.md/);
		});
	});

	it("surfaces configured INNER.md read errors", async (t) => {
		const workspacePath = await createWorkspace(
			t,
			minimalConfigToml(`
[persona]
inner = "inner-dir"
`),
		);
		await mkdir(resolve(workspacePath, "inner-dir"), { recursive: true });
		await withDiscordToken(async () => {
			const config = await loadConfig(workspacePath);

			await assert.rejects(() => loadPersona(config), /EISDIR|illegal operation on a directory/);
		});
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
