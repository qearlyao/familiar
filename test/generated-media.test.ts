import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import {
	createGeneratedMediaSink,
	generatedAttachmentsDir,
	publicAttachmentPath,
} from "../src/generated-media.js";
import { configWithDataDir } from "./helpers.js";

describe("generated media", () => {
	it("drains generated attachments without leaking between prompts", () => {
		const sink = createGeneratedMediaSink();
		sink.add({ id: "one", name: "one.mp3" });

		assert.deepEqual(sink.drain(), [{ id: "one", name: "one.mp3" }]);
		assert.deepEqual(sink.drain(), []);
	});

	it("creates public URLs for generated attachment paths", () => {
		const config = configWithDataDir("/workspace/data");
		const localPath = resolve(generatedAttachmentsDir(config), "nested", "voice one.mp3");

		assert.equal(publicAttachmentPath(config, localPath), "/api/web/attachments/nested/voice%20one.mp3");
	});

	it("throws for paths outside the generated attachment directory", () => {
		const config = configWithDataDir("/workspace/data");

		assert.throws(() => publicAttachmentPath(config, "/tmp/outside.mp3"), /outside generated attachments dir/);
	});
});
