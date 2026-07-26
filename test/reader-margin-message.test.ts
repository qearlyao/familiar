import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatMarginMessage, pageQuoteCitation, type PendingPage, type PendingQuote } from "../web/src/components/reader/marginMessage.js";
import { pageSegments, trimEnd, trimStart } from "../web/src/components/reader/pageBounds.js";

const TITLE = "The Waves";

function page(segments: { start: number; end: number; text: string }[], chapterIndex = 2): PendingPage {
	return {
		segments,
		start: segments[0]!.start,
		end: segments[segments.length - 1]!.end,
		chapterTitle: "The Window",
		chapterIndex,
	};
}

function quote(text: string, start: number, end: number, chapterIndex = 2): PendingQuote {
	return { quote: text, start, end, chapterIndex, chapterTitle: "The Window" };
}

describe("margin message payload", () => {
	it("sends the bare text when nothing is attached", () => {
		assert.equal(formatMarginMessage(TITLE, "are you awake?"), "are you awake?");
	});

	it("quotes a passage with its citation", () => {
		const out = formatMarginMessage(TITLE, "why this?", quote("the sea was indistinguishable", 10, 39));
		assert.equal(out, "> the sea was indistinguishable\n— *The Waves*, The Window\n\nwhy this?");
	});

	it("cites a page with offsets so it can be found again", () => {
		const out = formatMarginMessage(TITLE, "thoughts?", undefined, page([{ start: 100, end: 118, text: "she arranged them" }]));
		assert.match(out, /— \*The Waves\*, The Window · 100–118$/m);
	});

	it("joins page paragraphs with blank lines, each quoted", () => {
		const out = formatMarginMessage(
			TITLE,
			"ok",
			undefined,
			page([
				{ start: 0, end: 5, text: "first" },
				{ start: 20, end: 26, text: "second" },
			]),
		);
		assert.match(out, /> first\n> \n> second/);
	});

	it("marks the selection in place instead of repeating it", () => {
		const body = "she had spent the morning arranging the flowers";
		const out = formatMarginMessage(
			TITLE,
			"why does this land?",
			quote("arranging", 26, 35),
			page([{ start: 0, end: body.length, text: body }]),
		);
		assert.match(out, /⟦arranging⟧/);
		// The passage appears exactly once — inside the page, not as its own block.
		assert.equal(out.match(/arranging/g)?.length, 1);
		assert.match(out, /^⟦…⟧ marks the passage i've selected\./);
	});

	it("keeps both blocks when the quote is not on the page", () => {
		const out = formatMarginMessage(
			TITLE,
			"still thinking about this",
			quote("an earlier line", 10, 25, 1),
			page([{ start: 400, end: 411, text: "later text" }], 2),
		);
		assert.match(out, /an earlier line/);
		assert.match(out, /and the page i'm on now:/);
		assert.doesNotMatch(out, /⟦/);
	});

	it("marks a selection spanning two paragraphs", () => {
		const out = formatMarginMessage(
			TITLE,
			"?",
			quote("end start", 6, 15),
			page([
				{ start: 0, end: 9, text: "first end" },
				{ start: 10, end: 21, text: "start second" },
			]),
		);
		assert.match(out, /first ⟦end/);
		assert.match(out, /start⟧ second/);
	});

	it("falls back to a chapter number when the chapter is untitled", () => {
		const untitled = { ...page([{ start: 0, end: 4, text: "text" }]), chapterTitle: undefined };
		assert.match(formatMarginMessage(TITLE, "hm", undefined, untitled), /— \*The Waves\*, ch 3 · 0–4/);
	});
});

describe("page quote citation detection", () => {
	// What react-markdown hands the blockquote renderer: quote markers and
	// emphasis asterisks parsed away, soft line breaks kept.
	function renderedText(message: string): string {
		return message
			.split("\n")
			.filter((line) => line.startsWith(">") || line.startsWith("—"))
			.map((line) => line.replace(/^>\s?/, "").replaceAll("*", ""))
			.join("\n");
	}

	it("recovers the citation from a formatted page block", () => {
		const message = formatMarginMessage(TITLE, "hm", undefined, page([{ start: 100, end: 118, text: "she arranged them" }]));
		assert.equal(pageQuoteCitation(renderedText(message)), "The Waves, The Window · 100–118");
	});

	it("leaves plain quotes alone", () => {
		const message = formatMarginMessage(TITLE, "why?", quote("the sea was indistinguishable", 10, 39));
		assert.equal(pageQuoteCitation(renderedText(message)), undefined);
	});

	it("ignores ordinary blockquote text", () => {
		assert.equal(pageQuoteCitation("just a quoted line\nwith another"), undefined);
		assert.equal(pageQuoteCitation(""), undefined);
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

	it("drops paragraphs that trim away to nothing", () => {
		const result = pageSegments(
			"one\n\ntwo",
			[
				{ start: 0, end: 3 },
				{ start: 5, end: 8 },
			],
			{ start: 0, end: 8 },
		);
		assert.deepEqual(
			result?.segments.map((s: { text: string }) => s.text),
			["one", "two"],
		);
		assert.equal(result?.start, 0);
		assert.equal(result?.end, 8);
	});

	it("returns undefined when nothing is visible", () => {
		assert.equal(pageSegments("text", [], { start: 0, end: 0 }), undefined);
	});

	it("keeps a long paragraph when its beginning is visible", () => {
		const text = `${"a".repeat(120)}. ${"b".repeat(120)}. ${"c".repeat(120)}.`;
		const result = pageSegments(text, [{ start: 0, end: text.length }], { start: 0, end: text.length });
		assert.equal(result?.start, 0);
		assert.equal(result?.segments[0]?.text, text);
	});
});
