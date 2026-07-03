import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasSilentMarker, stripStreamingTail, withoutSilentMarker } from "../web/src/lib/silentMarker.js";

describe("web silent marker display helpers", () => {
	it("detects the marker anywhere in step text", () => {
		assert.equal(hasSilentMarker("done for today\n\n[[FAMILIAR_SILENT]]"), true);
		assert.equal(hasSilentMarker("[[FAMILIAR_SILENT"), false);
	});

	it("strips all marker occurrences and trims", () => {
		assert.equal(withoutSilentMarker("thoughts\n\n[[FAMILIAR_SILENT]]"), "thoughts");
		assert.equal(withoutSilentMarker("[[FAMILIAR_SILENT]]\nnote"), "note");
		assert.equal(withoutSilentMarker("[[FAMILIAR_SILENT]]"), "");
	});

	it("hides a partially streamed marker tail", () => {
		assert.equal(stripStreamingTail("almost done [[FAMILIAR_SIL"), "almost done ");
		assert.equal(stripStreamingTail("almost done [["), "almost done ");
		assert.equal(stripStreamingTail("plain text"), "plain text");
	});
});
