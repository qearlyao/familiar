import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keepsakeBlocks, unreadLines } from "../web/src/components/keepsakeBlocks.js";

const NOTE = [
	"# Memory", // 1
	"", // 2
	"## About Qearl", // 3
	"", // 4
	"- **Drinks:** Juice. Any kind of juice.", // 5
	"- **Food:** Loves char siu,", // 6
	"  and still needs to eat more.", // 7
	"- **Anime:** Jujutsu Kaisen.", // 8
	"", // 9
	"A plain paragraph that wraps", // 10
	"onto a second line.", // 11
	"", // 12
	"```toml", // 13
	"- not a list item", // 14
	"```", // 15
].join("\n");

describe("keepsake blocks", () => {
	it("splits headings, list items, wrapped paragraphs and fences into their own blocks", () => {
		assert.deepEqual(
			keepsakeBlocks(NOTE).map((block) => block.line),
			[1, 3, 5, 6, 8, 10, 13],
		);
	});

	it("fingerprints a block by its text, so a moved block stays read", () => {
		const moved = ["## About Qearl", "", "- **Anime:** Jujutsu Kaisen.", "", "- **Drinks:** Juice. Any kind of juice."].join(
			"\n",
		);
		const before = keepsakeBlocks(NOTE).map((block) => block.fingerprint);

		for (const block of keepsakeBlocks(moved)) {
			assert.ok(before.includes(block.fingerprint), `moved block lost its fingerprint: ${block.line}`);
		}
	});

	it("marks only the lines whose blocks are new to the reader", () => {
		const seen = keepsakeBlocks(NOTE).map((block) => block.fingerprint);
		const edited = NOTE.replace("- **Anime:** Jujutsu Kaisen.", "- **Anime:** Jujutsu Kaisen, still.").concat(
			"\n\n- **Gunpla:** builds kits.",
		);

		// line 8 was edited, line 17 is new, everything else was already read
		assert.deepEqual([...unreadLines(edited, seen)].sort((a, b) => a - b), [8, 17]);
	});

	it("counts a keepsake with no record as fully read", () => {
		assert.equal(unreadLines(NOTE, undefined).size, 0);
	});

	it("treats an unclosed fence as one block rather than running away", () => {
		assert.deepEqual(
			keepsakeBlocks("para\n\n```\nopen forever\nmore").map((block) => block.line),
			[1, 3],
		);
	});
});
