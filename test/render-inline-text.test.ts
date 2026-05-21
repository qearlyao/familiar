import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collapseInlineSegments, parseInlineSegments } from "../web/src/lib/inlineSegments.js";

describe("renderInlineText parser", () => {
	it("parses meme labels that contain parentheses", () => {
		const text =
			"meme: i'll burn two holes in your ass (vulgar joke) (https://files.catbox.moe/e3knpt.jpg)";

		assert.deepEqual(collapseInlineSegments(parseInlineSegments(text)), [
			{
				type: "image",
				url: "https://files.catbox.moe/e3knpt.jpg",
				alt: "i'll burn two holes in your ass (vulgar joke)",
			},
		]);
	});

	it("keeps non-image URLs as text", () => {
		const text = "read https://example.com/docs and then meme: okay (https://files.catbox.moe/faj921.png)";

		assert.deepEqual(collapseInlineSegments(parseInlineSegments(text)), [
			{ type: "text", value: "read https://example.com/docs and then" },
			{ type: "image", url: "https://files.catbox.moe/faj921.png", alt: "okay" },
		]);
	});
});
