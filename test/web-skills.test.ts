import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { parse as parseYaml } from "yaml";

import { HttpError } from "../src/web/http.js";
import { listWebSkills, readWebSkill, setWebSkillEnabled, writeWebSkill } from "../src/web/skill-routes.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

async function configWithWorkspace(t: Parameters<typeof configWithDataDir>[0]) {
	const dataDir = await createTempDataDir(t);
	const config = await configWithDataDir(t, dataDir);
	await mkdir(resolve(config.workspacePath, "skills"), { recursive: true });
	return config;
}

function parseSkillFrontmatter(raw: string): Record<string, unknown> {
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	assert.equal(normalized.startsWith("---\n"), true);
	const endIndex = normalized.indexOf("\n---", 4);
	assert.notEqual(endIndex, -1);
	return (parseYaml(normalized.slice(4, endIndex)) ?? {}) as Record<string, unknown>;
}

describe("web skill routes", () => {
	it("lists workspace skills with prompt visibility and diagnostics", async (t) => {
		const config = await configWithWorkspace(t);
		await mkdir(resolve(config.workspacePath, "skills", "alpha"), { recursive: true });
		await writeFile(
			resolve(config.workspacePath, "skills", "alpha", "SKILL.md"),
			`---
name: alpha
description: Alpha skill
---

alpha body
`,
			"utf8",
		);
		await writeFile(
			resolve(config.workspacePath, "skills", "quiet.md"),
			`---
name: quiet
description: Quiet skill
disable-model-invocation: true
---

quiet body
`,
			"utf8",
		);
		await mkdir(resolve(config.workspacePath, "skills", "broken"), { recursive: true });
		await writeFile(resolve(config.workspacePath, "skills", "broken", "SKILL.md"), "---\nname: broken\n---\n", "utf8");

		const skills = await listWebSkills(config);

		assert.deepEqual(
			skills.map((skill) => skill.name),
			["alpha", "broken", "quiet"],
		);
		assert.equal(skills[0]?.id, "alpha/SKILL.md");
		assert.equal(skills[0]?.enabled, true);
		assert.equal(skills[2]?.relativePath, "quiet.md");
		assert.equal(skills[2]?.enabled, false);
		assert.match(skills[1]?.diagnostics.join("\n") ?? "", /description is required/);
	});

	it("reads and saves skill frontmatter while preserving editable body text", async (t) => {
		const config = await configWithWorkspace(t);
		await mkdir(resolve(config.workspacePath, "skills", "image-gen"), { recursive: true });
		await writeFile(
			resolve(config.workspacePath, "skills", "image-gen", "SKILL.md"),
			`---
name: image-gen
description: Old description
---


# Body

Keep the blank line above.
`,
			"utf8",
		);

		const before = await readWebSkill(config, "image-gen/SKILL.md");
		assert.equal(before.content, "\n\n# Body\n\nKeep the blank line above.\n");

		const saved = await writeWebSkill(config, "image-gen/SKILL.md", {
			name: "image-gen",
			description: "New description",
			enabled: false,
			content: before.content,
		});

		assert.equal(saved.enabled, false);
		assert.equal(saved.description, "New description");
		assert.equal(saved.content, "\n\n# Body\n\nKeep the blank line above.\n");
		const raw = await readFile(resolve(config.workspacePath, "skills", "image-gen", "SKILL.md"), "utf8");
		assert.deepEqual(parseSkillFrontmatter(raw), {
			name: "image-gen",
			description: "New description",
			"disable-model-invocation": true,
		});
		assert.match(raw, /disable-model-invocation: true/);
		assert.match(raw, /\n\n\n# Body\n\nKeep the blank line above\.\n$/);
	});

	it("preserves unknown frontmatter when saving skill edits", async (t) => {
		const config = await configWithWorkspace(t);
		await mkdir(resolve(config.workspacePath, "skills", "image-gen"), { recursive: true });
		await writeFile(
			resolve(config.workspacePath, "skills", "image-gen", "SKILL.md"),
			`---
name: image-gen
description: Old description
tags:
  - image
  - tool
metadata:
  owner: q
  priority: 2
disable-model-invocation: true
---

body
`,
			"utf8",
		);

		await writeWebSkill(config, "image-gen/SKILL.md", {
			name: "image-gen",
			description: "New description",
			enabled: true,
			content: "new body\n",
		});

		const raw = await readFile(resolve(config.workspacePath, "skills", "image-gen", "SKILL.md"), "utf8");
		assert.deepEqual(parseSkillFrontmatter(raw), {
			name: "image-gen",
			description: "New description",
			tags: ["image", "tool"],
			metadata: { owner: "q", priority: 2 },
		});
		assert.match(raw, /\n---\nnew body\n$/);
	});

	it("toggles prompt visibility through disable-model-invocation", async (t) => {
		const config = await configWithWorkspace(t);
		await mkdir(resolve(config.workspacePath, "skills", "memes"), { recursive: true });
		await writeFile(
			resolve(config.workspacePath, "skills", "memes", "SKILL.md"),
			`---
name: memes
description: Meme skill
---

body
`,
			"utf8",
		);

		const disabled = await setWebSkillEnabled(config, "memes/SKILL.md", false);
		const enabled = await setWebSkillEnabled(config, "memes/SKILL.md", true);

		assert.equal(disabled.enabled, false);
		assert.equal(enabled.enabled, true);
		const raw = await readFile(resolve(config.workspacePath, "skills", "memes", "SKILL.md"), "utf8");
		assert.doesNotMatch(raw, /disable-model-invocation/);
	});

	it("preserves unknown frontmatter when toggling prompt visibility", async (t) => {
		const config = await configWithWorkspace(t);
		await mkdir(resolve(config.workspacePath, "skills", "memes"), { recursive: true });
		await writeFile(
			resolve(config.workspacePath, "skills", "memes", "SKILL.md"),
			`---
name: memes
description: Meme skill
tags:
  - fun
  - image
metadata:
  owner: q
  priority: 3
---

body
`,
			"utf8",
		);

		await setWebSkillEnabled(config, "memes/SKILL.md", false);
		const disabledRaw = await readFile(resolve(config.workspacePath, "skills", "memes", "SKILL.md"), "utf8");
		assert.deepEqual(parseSkillFrontmatter(disabledRaw), {
			name: "memes",
			description: "Meme skill",
			tags: ["fun", "image"],
			metadata: { owner: "q", priority: 3 },
			"disable-model-invocation": true,
		});
		assert.match(disabledRaw, /\n---\n\nbody\n$/);

		await setWebSkillEnabled(config, "memes/SKILL.md", true);
		const enabledRaw = await readFile(resolve(config.workspacePath, "skills", "memes", "SKILL.md"), "utf8");
		assert.deepEqual(parseSkillFrontmatter(enabledRaw), {
			name: "memes",
			description: "Meme skill",
			tags: ["fun", "image"],
			metadata: { owner: "q", priority: 3 },
		});
		assert.match(enabledRaw, /\n---\n\nbody\n$/);
	});

	it("honors canonical skill ignore files during discovery", async (t) => {
		const config = await configWithWorkspace(t);
		await writeFile(resolve(config.workspacePath, "skills", ".gitignore"), "ignored.md\nignored-dir/\n", "utf8");
		await writeFile(
			resolve(config.workspacePath, "skills", "visible.md"),
			`---
name: visible
description: Visible skill
---

visible body
`,
			"utf8",
		);
		await writeFile(
			resolve(config.workspacePath, "skills", "ignored.md"),
			`---
name: ignored
description: Ignored skill
---

ignored body
`,
			"utf8",
		);
		await mkdir(resolve(config.workspacePath, "skills", "ignored-dir"), { recursive: true });
		await writeFile(
			resolve(config.workspacePath, "skills", "ignored-dir", "SKILL.md"),
			`---
name: ignored-dir
description: Ignored directory skill
---

ignored body
`,
			"utf8",
		);

		const skills = await listWebSkills(config);

		assert.deepEqual(
			skills.map((skill) => skill.id),
			["visible.md"],
		);
	});

	it("rejects traversal and symlink skill edits", async (t) => {
		const config = await configWithWorkspace(t);
		await writeFile(
			resolve(config.workspacePath, "outside.md"),
			`---
name: linked
description: Linked skill
---

secret
`,
			"utf8",
		);
		await symlink(resolve(config.workspacePath, "outside.md"), resolve(config.workspacePath, "skills", "linked.md"));

		assert.deepEqual(await listWebSkills(config), []);
		await assert.rejects(() => readWebSkill(config, "../outside.md"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 400);
			return true;
		});
		await assert.rejects(() => readWebSkill(config, "linked.md"), (error) => {
			assert.equal(error instanceof HttpError, true);
			assert.equal((error as HttpError).status, 403);
			return true;
		});
	});
});
