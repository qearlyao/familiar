import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diaryMarkdownBlocks, splitDiaryInline } from "../web/src/lib/diaryMarkdown.js";

describe("diary markdown block model", () => {
	it("joins wrapped prose lines while splitting diary beat paragraphs", () => {
		assert.deepEqual(diaryMarkdownBlocks("first wrapped\nline\n09:12: kettle on\nstill same beat", "day"), [
			{ kind: "paragraph", inline: [{ kind: "text", text: "first wrapped line" }] },
			{ kind: "paragraph", inline: [{ kind: "text", text: "09:12: kettle on still same beat" }] },
		]);
	});

	it("keeps only the legacy splitInline constructs active", () => {
		assert.deepEqual(splitDiaryInline("`code` **bold** *soft* _literal_ [link](https://x.test) ![alt](x.png)"), [
			{ kind: "code", text: "code" },
			{ kind: "text", text: " " },
			{ kind: "strong", text: "bold" },
			{ kind: "text", text: " " },
			{ kind: "em", text: "soft" },
			{ kind: "text", text: " _literal_ [link](https://x.test) ![alt](x.png)" },
		]);
	});

	it("treats the first title-matching heading as non-renderable diary chrome", () => {
		assert.deepEqual(diaryMarkdownBlocks("# Quiet Day", "quiet day"), []);
		assert.deepEqual(diaryMarkdownBlocks("# Quiet Day\n## Quiet Day", "quiet day"), [
			{ kind: "heading", level: 2, inline: [{ kind: "text", text: "Quiet Day" }] },
		]);
		assert.deepEqual(diaryMarkdownBlocks("# **Quiet** [Day](#day)\n### Later", "quiet day"), [
			{ kind: "heading", level: 3, inline: [{ kind: "text", text: "Later" }] },
		]);
	});

	it("preserves block kinds and list runs", () => {
		assert.deepEqual(diaryMarkdownBlocks("- `code` and **bold**\n- *soft*\n1. next\n> **quoted** line", "day"), [
			{
				kind: "list",
				ordered: false,
				items: [
					[
						{ kind: "code", text: "code" },
						{ kind: "text", text: " and " },
						{ kind: "strong", text: "bold" },
					],
					[{ kind: "em", text: "soft" }],
				],
			},
			{
				kind: "list",
				ordered: true,
				items: [[{ kind: "text", text: "next" }]],
			},
			{
				kind: "blockquote",
				inline: [
					{ kind: "strong", text: "quoted" },
					{ kind: "text", text: " line" },
				],
			},
		]);
	});
});
