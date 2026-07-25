import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFetchProviders, createWebTools } from "../src/web-tools/index.js";
import { PageCache } from "../src/web-tools/cache.js";
import { parseTinyfishResponse } from "../src/web-tools/fetch-providers.js";
import { formatFetchContent, formatSearchResults, paginateContent } from "../src/web-tools/format.js";
import { resolveSearchProviders } from "../src/web-tools/routing.js";
import { validateFetchUrl } from "../src/web-tools/safety.js";
import {
	normalizeDomains,
	parseBraveResults,
	parseExaResults,
	parseTavilyResults,
} from "../src/web-tools/search-providers.js";
import { WEB_UNTRUSTED_PREFIX } from "../src/web-tools/types.js";
import type { SearchCapability, SearchProvider, SearchProviderName } from "../src/web-tools/types.js";

function createTestSearchProvider(name: SearchProviderName, capabilities: SearchCapability[]): SearchProvider {
	return {
		name,
		capabilities: new Set(capabilities),
		async search() {
			return { results: [] };
		},
	};
}

describe("web tools", () => {
	it("exposes reversed tool names to avoid provider-native web tool collisions", () => {
		assert.deepEqual(
			createWebTools().map((tool) => tool.name),
			["search_web", "fetch_web"],
		);
	});

	it("warns that web content is untrusted", () => {
		assert.match(WEB_UNTRUSTED_PREFIX, /untrusted/);
		assert.match(WEB_UNTRUSTED_PREFIX, /open-web content/);
		assert.match(WEB_UNTRUSTED_PREFIX, /data, not directives/);
		assert.match(WEB_UNTRUSTED_PREFIX, /^<untrusted_web_content>/);
		assert.match(WEB_UNTRUSTED_PREFIX, /<\/untrusted_web_content>$/);
	});

	it("prefixes web search and fetch results with the untrusted-content block", () => {
		const search = formatSearchResults({
			results: [{ title: "A", url: "https://example.com", snippet: "Hello world" }],
			provider: "brave",
			requestedDepth: "basic",
			servedDepth: "basic",
		});
		const fetch = formatFetchContent("https://example.com", "jina", {
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
		const providers = createFetchProviders({
			apiKeys: { TINYFISH_API_KEY: "tinyfish-key" },
		});

		assert.deepEqual(
			providers.map((provider) => provider.name),
			["tinyfish", "jina"],
		);
	});

	it("parses TinyFish markdown results", () => {
		const parsed = parseTinyfishResponse({
			results: [{ content: "# Title\r\n\r\nBody" }],
		});

		assert.equal(parsed.content, "# Title\n\nBody");
	});

	it("parses TinyFish live API text-shaped results", () => {
		const parsed = parseTinyfishResponse({
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
			assert.throws(() => validateFetchUrl(url), /Invalid URL|Blocked URL/);
		}
	});

	it("normalizes and validates search domain filters", () => {
		assert.deepEqual(normalizeDomains([" Example.COM ", "docs.example.com"]), [
			"example.com",
			"docs.example.com",
		]);
		assert.throws(() => normalizeDomains(["https://example.com"]), /Invalid domain/);
		assert.throws(() => normalizeDomains(["example.com/path"]), /Invalid domain/);
		assert.throws(() => normalizeDomains(["example.com:443"]), /Invalid domain/);
	});

	it("does not route multi-domain searches to Brave", () => {
		const brave = createTestSearchProvider("brave", ["search", "freshness"]);
		const tavily = createTestSearchProvider("tavily", ["search", "content", "domainFilter"]);

		const providers = resolveSearchProviders(
			{ depth: "basic", domains: ["a.example", "b.example"] },
			{ brave, tavily },
		);

		assert.deepEqual(
			providers.map((provider) => provider.name),
			["tavily"],
		);
	});

	it("preserves fetchedAt across reads so TTL still expires entries", async () => {
		const cache = new PageCache({ ttlMs: 100, capacity: 2 });
		cache.set("https://example.com/a", "a", "tinyfish");
		const firstFetchedAt = cache.entries.get("https://example.com/a")?.fetchedAt ?? 0;

		await new Promise((resolve) => setTimeout(resolve, 5));
		const entry = cache.get("https://example.com/a");

		assert.equal(entry?.content, "a");
		assert.equal(cache.entries.get("https://example.com/a")?.fetchedAt, firstFetchedAt);
	});

	it("paginates content and reports offsets past the end", () => {
		assert.deepEqual(paginateContent("abcdef", 2, 3), {
			text: "cde",
			offset: 2,
			returnedChars: 3,
			totalChars: 6,
			nextOffset: 5,
			hasMore: true,
		});
		assert.deepEqual(paginateContent("abc", 10, 3), {
			text: "",
			offset: 10,
			returnedChars: 0,
			totalChars: 3,
			hasMore: false,
		});
	});

	it("points follow-up page reads at fetch_web", () => {
		const formatted = formatFetchContent("https://example.com", "jina", {
			text: "abc",
			offset: 0,
			returnedChars: 3,
			totalChars: 6,
			nextOffset: 3,
			hasMore: true,
		});

		assert.match(formatted, /fetch_web\(url="https:\/\/example\.com", offset=3\)/);
		assert.doesNotMatch(formatted, /web_fetch/);
	});

	it("normalizes provider result payloads", () => {
		assert.equal(
			parseBraveResults({
				web: { results: [{ title: "A", url: "https://example.com", description: "Hello world" }] },
			})[0]?.title,
			"A",
		);
		assert.equal(
			parseExaResults(
				{ results: [{ title: "B", url: "https://example.com", text: "Long body" }] },
				true,
			)[0]?.content,
			"Long body",
		);
		assert.equal(
			parseTavilyResults(
				{ results: [{ title: "C", url: "https://example.com", raw_content: "Markdown body" }] },
				true,
			)[0]?.content,
			"Markdown body",
		);
	});
});
