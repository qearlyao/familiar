import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { HttpError, MAX_BODY_BYTES, readJsonBody } from "../src/web/http.js";

function body(...parts: (Buffer | string)[]): AsyncIterable<Buffer | string> {
	return Readable.from(parts);
}

describe("readJsonBody", () => {
	it("parses a valid JSON body", async () => {
		assert.deepEqual(await readJsonBody(body('{"a":1}')), { a: 1 });
	});

	it("returns an empty object for an empty body", async () => {
		assert.deepEqual(await readJsonBody(body("")), {});
		assert.deepEqual(await readJsonBody(body("   ")), {});
	});

	it("rejects malformed JSON with a 400", async () => {
		await assert.rejects(readJsonBody(body("{not json")), (error: unknown) => {
			assert.ok(error instanceof HttpError);
			assert.equal(error.status, 400);
			return true;
		});
	});

	it("rejects an oversized body with a 413", async () => {
		const oversized = "a".repeat(MAX_BODY_BYTES + 1);
		await assert.rejects(readJsonBody(body(oversized)), (error: unknown) => {
			assert.ok(error instanceof HttpError);
			assert.equal(error.status, 413);
			return true;
		});
	});
});
