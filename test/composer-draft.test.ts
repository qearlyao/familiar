import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	composerSendDisabled,
	insertMemeDraftBlock,
	serializeDraftBlocks,
	type DraftBlock,
} from "../web/src/lib/composerDraft.js";
import { splitLegacyChatMedia } from "../web/src/lib/chatMarkdownMedia.js";

const hug = { name: "hug", url: "https://files.catbox.moe/hug.png" };
const love = { name: "falling in love", url: "https://files.catbox.moe/love.png" };

function text(value: string): DraftBlock {
	return { type: "text", value };
}

function meme(name: string, url: string): DraftBlock {
	return { type: "meme", name, url };
}

describe("composer draft meme blocks", () => {
	it("serializes text meme text in order", () => {
		assert.equal(
			serializeDraftBlocks([text("ur my hero"), meme(love.name, love.url), text("love u")]),
			"ur my hero\nmeme: falling in love (https://files.catbox.moe/love.png)\nlove u",
		);
	});

	it("round-trips serialized meme blocks through legacy markdown media parsing", () => {
		const serialized = serializeDraftBlocks([text("ur my hero"), meme(love.name, love.url), text("love u")]);

		assert.deepEqual(splitLegacyChatMedia(serialized), [
			{ type: "text", value: "ur my hero\n" },
			{ type: "image", url: love.url, alt: love.name },
			{ type: "text", value: "love u" },
		]);
	});

	it("inserts a meme at the text cursor", () => {
		const inserted = insertMemeDraftBlock([text("ur my hero\nlove u")], { blockIndex: 0, start: 10, end: 10 }, love);

		assert.deepEqual(inserted.blocks, [
			text("ur my hero"),
			meme(love.name, love.url),
			text("\nlove u"),
		]);
		assert.equal(serializeDraftBlocks(inserted.blocks), "ur my hero\nmeme: falling in love (https://files.catbox.moe/love.png)\nlove u");
	});

	it("replaces selected text with a meme", () => {
		const inserted = insertMemeDraftBlock([text("before replace after")], { blockIndex: 0, start: 7, end: 14 }, hug);

		assert.equal(serializeDraftBlocks(inserted.blocks), "before\nmeme: hug (https://files.catbox.moe/hug.png)\nafter");
	});

	it("serializes meme-only drafts", () => {
		assert.equal(
			serializeDraftBlocks([text(""), meme(hug.name, hug.url), text("")]),
			"meme: hug (https://files.catbox.moe/hug.png)",
		);
	});

	it("preserves multiple meme order", () => {
		assert.equal(
			serializeDraftBlocks([meme(hug.name, hug.url), meme(love.name, love.url)]),
			"meme: hug (https://files.catbox.moe/hug.png)\nmeme: falling in love (https://files.catbox.moe/love.png)",
		);
	});

	it("disables send while voice recording is busy", () => {
		assert.equal(
			composerSendDisabled({
				showAbort: false,
				sending: false,
				voiceBusy: true,
				hasText: true,
				hasAttachments: false,
			}),
			true,
		);
	});
});
