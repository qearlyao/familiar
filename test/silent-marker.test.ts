import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	consumeSilentDelta,
	createSilentFilterState,
	finalizeSilentFilter,
	parseAgentReply,
} from "../src/silent-marker.js";

describe("parseAgentReply", () => {
	it("treats the bare marker as silent", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT]]"), { text: "", silent: true });
	});

	it("treats marker plus newline plus reason as silent and surfaces the reason text", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT]]\nshe was thinking"), {
			text: "she was thinking",
			silent: true,
		});
	});

	it("normalizes CRLF before matching", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT]]\r\nthinking"), {
			text: "thinking",
			silent: true,
		});
	});

	it("rejects leading whitespace (strict marker match)", () => {
		assert.deepEqual(parseAgentReply("  [[FAMILIAR_SILENT]]"), {
			text: "  [[FAMILIAR_SILENT]]",
			silent: false,
		});
	});

	it("rejects trailing characters that are not newline (strict marker match)", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT]] "), {
			text: "[[FAMILIAR_SILENT]] ",
			silent: false,
		});
	});

	it("returns non-silent text untouched", () => {
		assert.deepEqual(parseAgentReply("hello there"), { text: "hello there", silent: false });
	});
});

describe("silent streaming filter", () => {
	it("emits text immediately when the first delta cannot be the marker", () => {
		const state = createSilentFilterState();
		const result = consumeSilentDelta(state, "hello");
		assert.deepEqual(result, { kind: "emit", text: "hello" });
		const final = finalizeSilentFilter(state);
		assert.deepEqual(final, { silent: false, flush: "" });
	});

	it("buffers a marker-prefix delta then flushes if the second delta diverges", () => {
		const state = createSilentFilterState();
		assert.deepEqual(consumeSilentDelta(state, "[[FAM"), { kind: "buffer" });
		const next = consumeSilentDelta(state, "EAGER");
		assert.equal(next.kind, "emit");
		assert.equal(next.kind === "emit" ? next.text : "", "[[FAMEAGER");
	});

	it("recognises the full marker arriving in chunks and goes silent", () => {
		const state = createSilentFilterState();
		assert.deepEqual(consumeSilentDelta(state, "[[FAMILIAR"), { kind: "buffer" });
		assert.deepEqual(consumeSilentDelta(state, "_SILENT]]\n"), { kind: "silent" });
		const final = finalizeSilentFilter(state);
		assert.equal(final.silent, true);
	});

	it("treats a stream that ends exactly at the bare marker as silent", () => {
		const state = createSilentFilterState();
		assert.deepEqual(consumeSilentDelta(state, "[[FAMILIAR_SILENT]]"), { kind: "buffer" });
		const final = finalizeSilentFilter(state);
		assert.equal(final.silent, true);
		assert.equal(final.flush, "");
	});

	it("flushes the buffered prefix if the stream ends without matching", () => {
		const state = createSilentFilterState();
		assert.deepEqual(consumeSilentDelta(state, "[["), { kind: "buffer" });
		const final = finalizeSilentFilter(state);
		assert.equal(final.silent, false);
		assert.equal(final.flush, "[[");
	});

	it("recognises CRLF after the marker as silent (CR and LF in one delta)", () => {
		const state = createSilentFilterState();
		assert.deepEqual(consumeSilentDelta(state, "[[FAMILIAR_SILENT]]\r\n"), { kind: "silent" });
		assert.equal(finalizeSilentFilter(state).silent, true);
	});

	it("recognises CRLF after the marker when CR and LF arrive in separate deltas", () => {
		const state = createSilentFilterState();
		assert.deepEqual(consumeSilentDelta(state, "[[FAMILIAR_SILENT]]\r"), { kind: "buffer" });
		assert.deepEqual(consumeSilentDelta(state, "\n"), { kind: "silent" });
		assert.equal(finalizeSilentFilter(state).silent, true);
	});

	it("treats leading whitespace as non-marker text and emits it (strict match)", () => {
		const state = createSilentFilterState();
		const result = consumeSilentDelta(state, " [[FAMILIAR_SILENT]]\n");
		assert.equal(result.kind, "emit");
		assert.equal(
			result.kind === "emit" ? result.text : "",
			" [[FAMILIAR_SILENT]]\n",
		);
		assert.equal(finalizeSilentFilter(state).silent, false);
	});
});

describe("streaming filter and parseAgentReply round-trip", () => {
	const inputs = [
		"hello there",
		"[[FAMILIAR_SILENT]]",
		"[[FAMILIAR_SILENT]]\n",
		"[[FAMILIAR_SILENT]]\nshe paused",
		"[[FAMILIAR_SILENT]]\r\n",
		"[[FAMILIAR_SILENT]]\r\nshe paused",
		"[[FAM",
		"[[FAMILIAR_SILENT]]X",
		"[[FAMILIAR_SILENT]] ",
		" [[FAMILIAR_SILENT]]",
		"  [[FAMILIAR_SILENT]]\n",
		"",
		"a",
		"[[",
		"[[FAMILIAR_SILENT",
	];

	for (const input of inputs) {
		describe(`input ${JSON.stringify(input)}`, () => {
			const expected = parseAgentReply(input);
			for (let split = 0; split <= input.length; split++) {
				const head = input.slice(0, split);
				const tail = input.slice(split);
				it(`agrees with the parser when chunked at offset ${split}`, () => {
					const state = createSilentFilterState();
					let emitted = "";
					for (const chunk of [head, tail]) {
						if (!chunk) continue;
						const result = consumeSilentDelta(state, chunk);
						if (result.kind === "emit") emitted += result.text;
						if (result.kind === "silent") break;
					}
					const final = finalizeSilentFilter(state);
					emitted += final.flush;
					assert.equal(final.silent, expected.silent, `silent flag mismatch for split ${split}`);
				});
			}
		});
	}
});
