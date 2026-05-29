import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Config } from "../src/config.js";
import { chunkDiscord } from "../src/discord/chunking.js";

const LIMIT = 2000;

function configWithMode(chunkMode: "simple" | "newline" | "paragraph"): Config {
	return { discord: { chunkMode } } as Config;
}

// 👍 (U+1F44D) is one astral code point stored as a surrogate pair (2 UTF-16 units).
const THUMBS_UP = "👍";

describe("chunkDiscord", () => {
	for (const mode of ["simple", "newline", "paragraph"] as const) {
		it(`never splits a surrogate pair across chunks (${mode} mode)`, () => {
			// Build an unbroken, spaceless run whose forced hard cut lands mid-emoji:
			// padding sized so position LIMIT falls between the two units of a 👍.
			const text = `${"a".repeat(LIMIT - 1)}${THUMBS_UP.repeat(20)}`;
			const chunks = chunkDiscord(configWithMode(mode), text);
			for (const chunk of chunks) {
				// A lone high surrogate at the tail or low surrogate at the head means a split pair.
				const firstCode = chunk.charCodeAt(0);
				const lastCode = chunk.charCodeAt(chunk.length - 1);
				assert.ok(!(lastCode >= 0xd800 && lastCode <= 0xdbff), `chunk ends with a lone high surrogate (${mode})`);
				assert.ok(!(firstCode >= 0xdc00 && firstCode <= 0xdfff), `chunk starts with a lone low surrogate (${mode})`);
			}
			// Reassembling the chunks must preserve every code point.
			assert.equal([...chunks.join("")].length, [...text].length);
		});
	}

	it("keeps each chunk within the 2000-char limit", () => {
		const text = `${"word ".repeat(900)}${THUMBS_UP.repeat(50)}`;
		for (const chunk of chunkDiscord(configWithMode("newline"), text)) {
			assert.ok(chunk.length <= LIMIT, `chunk length ${chunk.length} exceeds ${LIMIT}`);
		}
	});

	it("returns the empty-response sentinel for blank text in simple/paragraph modes", () => {
		assert.deepEqual(chunkDiscord(configWithMode("simple"), ""), ["(empty response)"]);
		assert.deepEqual(chunkDiscord(configWithMode("paragraph"), ""), ["(empty response)"]);
	});
});
