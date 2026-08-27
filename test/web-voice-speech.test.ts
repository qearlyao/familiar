import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSpeechFeed } from "../web/src/lib/voiceSpeech.js";

describe("voice speech streaming", () => {
	it("buffers streaming text until a punctuation boundary", () => {
		const feed = createSpeechFeed();
		assert.deepEqual(feed.push("Hey"), []);
		assert.deepEqual(feed.push("Hey, I'm here"), []);
		assert.deepEqual(feed.push("Hey, I'm here, still. Fine"), ["Hey, I'm here, still."]);
		assert.deepEqual(feed.end(), [" Fine"]);
	});

	it("never voices a silent turn", () => {
		const feed = createSpeechFeed();
		assert.deepEqual(feed.push("[[FAMILIAR_SILENT]] just watching."), []);
		assert.deepEqual(feed.end(), []);
	});

	it("strips markdown from streamed text", () => {
		const feed = createSpeechFeed();
		assert.deepEqual(feed.push("## Hi\n**bold** [a](http://x) done."), ["Hi\n", "bold a done."]);
	});
});
