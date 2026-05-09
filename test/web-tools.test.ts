import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __webToolsTest, webContentWarning } from "../src/web-tools.js";

describe("web tools", () => {
	it("warns that web content is untrusted", () => {
		assert.match(webContentWarning(), /untrusted/);
		assert.match(webContentWarning(), /web_search/);
	});

	it("prefers TinyFish for fetch when configured", () => {
		const providers = __webToolsTest.createFetchProviders({
			apiKeys: { TINYFISH_API_KEY: "tinyfish-key" },
			warnings: [],
		});

		assert.deepEqual(
			providers.map((provider) => provider.name),
			["tinyfish", "jina"],
		);
	});

	it("parses TinyFish markdown results", () => {
		const parsed = __webToolsTest.parseTinyfishResponse({
			results: [{ content: "# Title\r\n\r\nBody" }],
		});

		assert.equal(parsed.content, "# Title\n\nBody");
	});
});
