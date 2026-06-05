import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { remarkImageParagraphs } from "../web/src/lib/chatMarkdownLayout.js";
import { remarkLegacyChatMedia, splitLegacyChatMedia } from "../web/src/lib/chatMarkdownMedia.js";

function gfmAutolinkedMemeTree({ layout = false } = {}) {
	const url = "https://files.catbox.moe/faj921.png";
	const transform = remarkLegacyChatMedia();
	const layoutTransform = remarkImageParagraphs();
	const tree: Parameters<typeof transform>[0] = {
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [
					{ type: "text", value: "ur my hero\nmeme: falling in love (" },
					{
						type: "link",
						title: null,
						url,
						children: [{ type: "text", value: url }],
					},
					{ type: "text", value: ")\nlove u" },
				],
			},
		],
	};
	transform(tree);
	if (layout) layoutTransform(tree);
	return tree;
}

describe("chat markdown media parser", () => {
	it("parses meme labels that contain parentheses", () => {
		const text =
			"meme: i'll burn two holes in your ass (vulgar joke) (https://files.catbox.moe/e3knpt.jpg)";

		assert.deepEqual(splitLegacyChatMedia(text), [
			{
				type: "image",
				url: "https://files.catbox.moe/e3knpt.jpg",
				alt: "i'll burn two holes in your ass (vulgar joke)",
			},
		]);
	});

	it("keeps non-image URLs as text", () => {
		const text = "read https://example.com/docs and then meme: okay (https://files.catbox.moe/faj921.png)";

		assert.deepEqual(splitLegacyChatMedia(text), [
			{ type: "text", value: "read https://example.com/docs and then" },
			{ type: "image", url: "https://files.catbox.moe/faj921.png", alt: "okay" },
		]);
	});

	it("recombines legacy meme text after gfm autolinks the url", () => {
		assert.deepEqual(gfmAutolinkedMemeTree().children, [
			{
				type: "paragraph",
				children: [
					{ type: "text", value: "ur my hero\n" },
					{ type: "image", url: "https://files.catbox.moe/faj921.png", alt: "falling in love" },
					{ type: "text", value: "love u" },
				],
			},
		]);
	});

	it("splits mixed image paragraphs only in the explicit layout pass", () => {
		assert.deepEqual(gfmAutolinkedMemeTree({ layout: true }).children, [
			{
				type: "paragraph",
				children: [{ type: "text", value: "ur my hero\n" }],
			},
			{
				type: "paragraph",
				children: [{ type: "image", url: "https://files.catbox.moe/faj921.png", alt: "falling in love" }],
			},
			{
				type: "paragraph",
				children: [{ type: "text", value: "love u" }],
			},
		]);
	});
});
