import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { marginQuoteCitation } from "../web/src/components/reader/marginCitation.js";
import { pageSegments, trimEnd, trimStart } from "../web/src/components/reader/pageBounds.js";

describe("margin quote citation detection", () => {
	it("recovers the citation a margin prompt ends its blockquote with", () => {
		// What react-markdown hands the blockquote renderer: markers and emphasis parsed away.
		assert.equal(marginQuoteCitation("minutes are what a flood is made of\n— Slow Water, The weir · p. 148"), "Slow Water, The weir · p. 148");
	});

	it("ignores ordinary blockquote text", () => {
		assert.equal(marginQuoteCitation("just a quoted line\n— a person"), undefined);
		assert.equal(marginQuoteCitation(""), undefined);
	});
});

describe("page boundary trimming", () => {
	it("keeps a modest overshoot so the paragraph stays whole", () => {
		const text = `${"a".repeat(80)}. ${"b".repeat(80)}`;
		assert.equal(trimStart(text, 162, 0), 0);
		assert.equal(trimEnd(text, 0, 162), 162);
	});

	it("cuts back to the last sentence break when snapping overshoots the start", () => {
		const head = `${"x".repeat(400)}. `;
		const text = `${head}${"y".repeat(50)}`;
		// Visible text begins at head.length; snapping to the paragraph would pull in 400 chars.
		assert.equal(trimStart(text, head.length + 50, 0), head.length);
	});

	it("cuts forward to a sentence break when snapping overshoots the end", () => {
		const text = `${"y".repeat(320)}. ${"z".repeat(400)}`;
		assert.equal(trimEnd(text, 0, text.length), 322);
	});

	it("hard-caps the start when the overshoot has no sentence break", () => {
		const text = "q".repeat(900);
		assert.equal(trimStart(text, 900, 0), 600);
	});

	it("spans the visible paragraphs", () => {
		const result = pageSegments(
			"one\n\ntwo",
			[
				{ start: 0, end: 3 },
				{ start: 5, end: 8 },
			],
			{ start: 0, end: 8 },
		);
		assert.deepEqual(result, { start: 0, end: 8 });
	});

	it("returns undefined when nothing is visible", () => {
		assert.equal(pageSegments("text", [], { start: 0, end: 0 }), undefined);
		assert.equal(pageSegments("  \n ", [{ start: 0, end: 4 }], { start: 0, end: 4 }), undefined);
	});

	it("keeps a long paragraph when its beginning is visible", () => {
		const text = `${"a".repeat(120)}. ${"b".repeat(120)}. ${"c".repeat(120)}.`;
		const result = pageSegments(text, [{ start: 0, end: text.length }], { start: 0, end: text.length });
		assert.deepEqual(result, { start: 0, end: text.length });
	});
});
