import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scoreEvictable, tokenBag } from "../src/memory/lcm/eviction-score.js";
import { lcmRecord as record } from "./memory-fakes.js";

describe("LCM eviction scoring", () => {
	it("scores a record with distinctive prompt overlap higher than an unrelated record", () => {
		const relevant = record(1, "user", "The rebar lattice detail uses diagonal steel ties.");
		const unrelated = record(2, "user", "Weather forecast says clouds and light rain.");
		const allRecords = [relevant, unrelated];

		assert.ok(
			scoreEvictable(relevant, "rebar lattice details", allRecords) >
				scoreEvictable(unrelated, "rebar lattice details", allRecords),
		);
	});

	it("weights distinctive terms above common words", () => {
		const distinctive = record(1, "user", "the a is rebar lattice rebar lattice");
		const commonOnly = record(2, "user", "the a is and the a is");
		const allRecords = [
			distinctive,
			commonOnly,
			record(3, "user", "the a is weather forecast"),
			record(4, "user", "the a is kanban schedule"),
		];

		assert.ok(scoreEvictable(distinctive, "the a is rebar lattice", allRecords) > scoreEvictable(commonOnly, "the a is", allRecords));
	});

	it("returns zero for empty or unsearchable prompts", () => {
		const records = [record(1, "user", "rebar lattice"), record(2, "user", "weather")];

		assert.deepEqual(records.map((item) => scoreEvictable(item, "", records)), [0, 0]);
		assert.deepEqual(records.map((item) => scoreEvictable(item, "! ? .", records)), [0, 0]);
		assert.deepEqual(tokenBag("Rebar, lattice! x a").slice(0, 2), ["rebar", "lattice"]);
	});
});
