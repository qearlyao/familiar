import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAgentReply } from "../src/runtime/silent-marker.js";

describe("parseAgentReply", () => {
	it("treats the bare marker as silent", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT]]"), { text: "", silent: true });
	});

	it("treats a leading marker as silent and surfaces the reflection text", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT]]\nshe was thinking"), {
			text: "she was thinking",
			silent: true,
		});
	});

	it("treats a trailing marker as silent and surfaces the reflection text", () => {
		assert.deepEqual(parseAgentReply("wrapped up the task, nothing worth saying\n\n[[FAMILIAR_SILENT]]"), {
			text: "wrapped up the task, nothing worth saying",
			silent: true,
		});
	});

	it("strips every marker occurrence and trims the remainder", () => {
		assert.deepEqual(parseAgentReply("  [[FAMILIAR_SILENT]] quiet [[FAMILIAR_SILENT]] "), {
			text: "quiet",
			silent: true,
		});
	});

	it("tolerates surrounding whitespace and CRLF", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT]]\r\nthinking"), {
			text: "thinking",
			silent: true,
		});
		assert.deepEqual(parseAgentReply("  [[FAMILIAR_SILENT]]"), { text: "", silent: true });
	});

	it("does not treat a partial marker as silent", () => {
		assert.deepEqual(parseAgentReply("[[FAMILIAR_SILENT"), { text: "[[FAMILIAR_SILENT", silent: false });
	});

	it("returns non-silent text untouched", () => {
		assert.deepEqual(parseAgentReply("hello there"), { text: "hello there", silent: false });
	});
});
