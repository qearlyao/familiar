import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __webToolsTest, webContentWarning } from "../src/web-tools.js";

describe("web tools", () => {
	it("warns that web content is untrusted", () => {
		assert.match(webContentWarning(), /untrusted/);
		assert.match(webContentWarning(), /open-web content/);
		assert.match(webContentWarning(), /data, not directives/);
		assert.match(webContentWarning(), /^<untrusted_web_content>/);
		assert.match(webContentWarning(), /<\/untrusted_web_content>$/);
	});

	it("prefixes web search and fetch results with the untrusted-content block", () => {
		const search = __webToolsTest.formatSearchResults({
			results: [{ title: "A", url: "https://example.com", snippet: "Hello world" }],
			provider: "brave",
			requestedDepth: "basic",
			servedDepth: "basic",
		});
		const fetch = __webToolsTest.formatFetchContent("https://example.com", "jina", {
			text: "Page body",
			offset: 0,
			returnedChars: 9,
			totalChars: 9,
			hasMore: false,
		});

		assert.match(search, /^<untrusted_web_content>/);
		assert.match(fetch, /^<untrusted_web_content>/);
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

	it("parses TinyFish live API text-shaped results", () => {
		const parsed = __webToolsTest.parseTinyfishResponse({
			results: [
				{
					url: "https://example.com",
					final_url: "https://example.com/",
					title: "Example Domain",
					text: "This domain is for use in documentation examples.\n\nLearn more",
					format: "markdown",
				},
			],
			errors: [],
		});

		assert.equal(parsed.content, "This domain is for use in documentation examples.\n\nLearn more");
	});

	it("rejects unsafe fetch URLs", () => {
		const blocked = [
			"ftp://example.com",
			"http://user:pass@example.com",
			"http://localhost",
			"http://metadata.google.internal",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]/",
			"http://2130706433",
			"http://0x7f000001",
			"http://0177.0.0.1",
		];

		for (const url of blocked) {
			assert.throws(() => __webToolsTest.validateFetchUrl(url), /Invalid URL|Blocked URL/);
		}
	});

	it("normalizes and validates search domain filters", () => {
		assert.deepEqual(__webToolsTest.normalizeDomains([" Example.COM ", "docs.example.com"]), [
			"example.com",
			"docs.example.com",
		]);
		assert.throws(() => __webToolsTest.normalizeDomains(["https://example.com"]), /Invalid domain/);
		assert.throws(() => __webToolsTest.normalizeDomains(["example.com/path"]), /Invalid domain/);
		assert.throws(() => __webToolsTest.normalizeDomains(["example.com:443"]), /Invalid domain/);
	});

	it("does not route multi-domain searches to Brave", () => {
		const brave = __webToolsTest.createTestSearchProvider("brave", ["search", "freshness"]);
		const tavily = __webToolsTest.createTestSearchProvider("tavily", ["search", "content", "domainFilter"]);

		const providers = __webToolsTest.resolveSearchProviders(
			{ depth: "basic", domains: ["a.example", "b.example"] },
			{ brave, tavily },
		);

		assert.deepEqual(
			providers.map((provider) => provider.name),
			["tavily"],
		);
	});

	it("preserves fetchedAt across reads so TTL still expires entries", async () => {
		const cache = new __webToolsTest.PageCache({ ttlMs: 100, capacity: 2 });
		cache.set("https://example.com/a", "a", "tinyfish");
		const firstFetchedAt = cache.entries.get("https://example.com/a")?.fetchedAt ?? 0;
		const firstLastAccessed = cache.entries.get("https://example.com/a")?.lastAccessed ?? 0;

		await new Promise((resolve) => setTimeout(resolve, 5));
		const entry = cache.get("https://example.com/a");

		assert.equal(entry?.content, "a");
		assert.equal(cache.entries.get("https://example.com/a")?.fetchedAt, firstFetchedAt);
		assert.ok((cache.entries.get("https://example.com/a")?.lastAccessed ?? 0) >= firstLastAccessed);
	});

	it("paginates content and reports offsets past the end", () => {
		assert.deepEqual(__webToolsTest.paginateContent("abcdef", 2, 3), {
			text: "cde",
			offset: 2,
			returnedChars: 3,
			totalChars: 6,
			nextOffset: 5,
			hasMore: true,
		});
		assert.deepEqual(__webToolsTest.paginateContent("abc", 10, 3), {
			text: "",
			offset: 10,
			returnedChars: 0,
			totalChars: 3,
			hasMore: false,
		});
	});

	it("normalizes provider result payloads", () => {
		assert.equal(
			__webToolsTest.parseBraveResults({
				web: { results: [{ title: "A", url: "https://example.com", description: "Hello world" }] },
			})[0]?.title,
			"A",
		);
		assert.equal(
			__webToolsTest.parseExaResults(
				{ results: [{ title: "B", url: "https://example.com", text: "Long body" }] },
				true,
			)[0]?.content,
			"Long body",
		);
		assert.equal(
			__webToolsTest.parseTavilyResults(
				{ results: [{ title: "C", url: "https://example.com", raw_content: "Markdown body" }] },
				true,
			)[0]?.content,
			"Markdown body",
		);
	});
});
