import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";

import { MarkdownView } from "../web/src/components/diaries/MarkdownView.js";

describe("diary markdown React rendering", () => {
	it("renders the quiet empty state without the prose wrapper", () => {
		const html = renderToStaticMarkup(createElement(MarkdownView, { content: "# Quiet Day", title: "quiet day" }));

		assert.match(html, /this day is quiet\./);
		assert.match(html, /font-serif text-sm italic text-muted-foreground/);
		assert.doesNotMatch(html, /warm-prose diary-prose/);
	});

	it("renders the diary markdown dialect through the page surface", () => {
		const html = renderToStaticMarkup(
			createElement(MarkdownView, {
				content:
					"# **Quiet** [Day](#day)\n\n## Quiet Day\n\nfirst wrapped\nline\n09:12: kettle on\nstill same beat\n\n- `code` and **bold**\n\n> _quoted_ [line](#line)",
				title: "Quiet Day",
			}),
		);

		assert.match(html, /class="warm-prose diary-prose"/);
		assert.doesNotMatch(html, /<strong>Quiet<\/strong>/);
		assert.match(html, /<h2>Quiet Day<\/h2>/);
		assert.match(html, /<p>first wrapped\nline<\/p>\n<p>09:12: kettle on\nstill same beat<\/p>/);
		assert.match(html, /<li><code>code<\/code> and <strong>bold<\/strong><\/li>/);
		assert.match(html, /<blockquote>\n<p><em>quoted<\/em> <a href="#line">line<\/a><\/p>\n<\/blockquote>/);
	});

	it("maps deeper headings to h3", () => {
		const html = renderToStaticMarkup(
			createElement(MarkdownView, { content: "### Deep\n\n###### Deeper", title: "other" }),
		);

		assert.match(html, /<h3>Deep<\/h3>/);
		assert.match(html, /<h3>Deeper<\/h3>/);
		assert.doesNotMatch(html, /<h6>/);
	});
});
