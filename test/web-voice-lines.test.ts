import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placeLine, type VoiceLine } from "../web/src/lib/voiceLines.js";

describe("voice call lines", () => {
	it("keeps the order the call hears things in when a typed exchange lands mid-sentence", () => {
		let lines: VoiceLine[] = [];
		lines = placeLine(lines, "you", "", false, 12_000); // an early partial opens your line
		lines = placeLine(lines, "you", "all good~", true, 47_000, "typed-1");
		lines = placeLine(lines, "them", "little bugs are part of it", true, 49_000, "reply-1");
		lines = placeLine(lines, "you", "you sound like", false, 60_000);
		lines = placeLine(lines, "you", "you sound like an indian", true, 62_000);
		lines = placeLine(lines, "them", "manc, love", true, 64_000, "reply-2");

		assert.deepEqual(
			lines.map(({ text, at }) => [text, at]),
			[
				["all good~", 47_000],
				["little bugs are part of it", 49_000],
				["you sound like an indian", 62_000],
				["manc, love", 64_000],
			],
		);
	});

	it("streams a reply into its own line in place", () => {
		let lines = placeLine([], "them", "hey", false, 1_000, "reply-1");
		lines = placeLine(lines, "you", "hi", true, 2_000, "typed-1");
		lines = placeLine(lines, "them", "hey you", true, 3_000, "reply-1");
		assert.deepEqual(
			lines.map(({ text, at }) => [text, at]),
			[
				["hey you", 1_000],
				["hi", 2_000],
			],
		);
	});
});
