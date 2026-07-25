import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CHAT_MARKDOWN_MEDIA_SPLIT_CLASS,
	remarkImageParagraphs,
} from "../web/src/lib/chatMarkdownLayout.js";

describe("chat markdown media layout", () => {
	it("renders a bare image URL as a split image paragraph", () => {
		const url = "https://files.catbox.moe/faj921.png";
		const tree = {
			type: "root" as const,
			children: [
				{
					type: "paragraph" as const,
					children: [
						{ type: "text" as const, value: "before" },
						{ type: "link" as const, title: null, url, children: [{ type: "text" as const, value: url }] },
						{ type: "text" as const, value: "after" },
					],
				},
			],
		};

		remarkImageParagraphs()(tree);

		const data = { hProperties: { className: CHAT_MARKDOWN_MEDIA_SPLIT_CLASS } };
		assert.deepEqual(tree.children, [
			{ type: "paragraph", data, children: [{ type: "text", value: "before" }] },
			{ type: "paragraph", data, children: [{ type: "image", url, alt: "" }] },
			{ type: "paragraph", data, children: [{ type: "text", value: "after" }] },
		]);
	});

	it("leaves ordinary links and paragraphs unchanged", () => {
		const tree = {
			type: "root" as const,
			children: [
				{
					type: "paragraph" as const,
					children: [
						{
							type: "link" as const,
							title: null,
							url: "https://example.com/docs",
							children: [{ type: "text" as const, value: "docs" }],
						},
					],
				},
			],
		};
		const before = structuredClone(tree);

		remarkImageParagraphs()(tree);

		assert.deepEqual(tree, before);
	});
});
