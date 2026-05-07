import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFrames, encodeFrame } from "../src/web-events.js";

function maskedTextFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
	const header = Buffer.from([0x81, 0x80 | payload.length]);
	const maskedPayload = Buffer.from(payload);
	for (let index = 0; index < maskedPayload.length; index++) maskedPayload[index] ^= mask[index % 4];
	return Buffer.concat([header, mask, maskedPayload]);
}

describe("websocket frames", () => {
	for (const length of [100, 200, 70_000]) {
		it(`round-trips ${length} byte text frames`, () => {
			const message = "x".repeat(length);

			const decoded = decodeFrames(encodeFrame(message));

			assert.deepEqual(decoded.messages, [message]);
			assert.equal(decoded.remaining.length, 0);
			assert.equal(decoded.close, false);
		});
	}

	it("decodes masked client frames", () => {
		const decoded = decodeFrames(maskedTextFrame("hello"));

		assert.deepEqual(decoded.messages, ["hello"]);
		assert.equal(decoded.remaining.length, 0);
		assert.equal(decoded.close, false);
	});

	it("keeps partial frames in the remaining buffer", () => {
		const frame = encodeFrame("partial");
		const decoded = decodeFrames(frame.subarray(0, frame.length - 2));

		assert.deepEqual(decoded.messages, []);
		assert.equal(decoded.remaining.length, frame.length - 2);
	});
});
