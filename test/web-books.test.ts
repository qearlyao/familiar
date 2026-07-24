import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { strToU8, zipSync } from "fflate";
import sharp from "sharp";

import {
	assertBookId,
	bookDir,
	createBookMarginalia,
	deleteBookMarginalia,
	deleteWebBook,
	listWebBooks,
	readBookMarginalia,
	readWebBook,
	readWebBookChapter,
	updateBookMarginalia,
	writeBookPosition,
} from "../src/web/book-library.js";
import { registerWebBookRoutes } from "../src/web/book-routes.js";
import { ingestBook, MAX_BOOK_BYTES } from "../src/web/epub-ingest.js";
import { HttpError } from "../src/web/http.js";
import type { RegisterWebRoute } from "../src/web/routes.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

function tinyEpub(extraChapterHtml = "", extraFiles: Record<string, Uint8Array> = {}): Buffer {
	const files: Record<string, Uint8Array> = {
		"META-INF/container.xml": strToU8(`<?xml version="1.0"?>
			<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
				<rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
			</container>`),
		"OPS/package.opf": strToU8(`<?xml version="1.0"?>
			<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
				<metadata>
					<dc:title>Fixture Book</dc:title><dc:creator>A. Reader</dc:creator><dc:language>en</dc:language>
				</metadata>
				<manifest>
					<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
					<item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
					<item id="two" href="two.xhtml" media-type="application/xhtml+xml"/>
					<item id="style" href="stylesheet.css" media-type="text/css"/>
					<item id="cover" href="images/pixel.png" media-type="image/png" properties="cover-image"/>
				</manifest>
				<spine><itemref idref="two"/><itemref idref="one"/></spine>
			</package>`),
		"OPS/nav.xhtml": strToU8(`<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body>
			<nav><ol><li><a href="one.xhtml">Opening</a></li><li><a href="two.xhtml">Second First</a></li></ol></nav>
		</body></html>`),
		"OPS/one.xhtml": strToU8(`<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head>
			<link rel="stylesheet" href="stylesheet.css"/><script>alert(1)</script></head><body>
			<h1 id="opening" style="color:red" onclick="bad()">Fallback Heading</h1>
			<p class="lead" onmouseover="bad()">Hello <strong>reader</strong>.</p>
			<img src="images/pixel.png" class="decor" onerror="bad()" style="width:100px" alt="pixel"/>
			<svg><image href="images/pixel.png"/></svg>
			<a href="two.xhtml#next">Next chapter</a><script>bad()</script>
			${extraChapterHtml}
			</body></html>`),
		"OPS/stylesheet.css": strToU8(`.lead { color: red; background-color: red; } @import url(https://example.com/remote.css); @font-face { src: url(https://example.com/font.woff2); }`),
		"OPS/two.xhtml": strToU8(`<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body>
			<h2>Ignored fallback</h2><p>Spine order comes first.</p>
		</body></html>`),
		"OPS/images/pixel.png": PIXEL_PNG,
		...extraFiles,
	};
	return Buffer.from(zipSync(files));
}

async function expectHttpStatus(run: () => Promise<unknown>, status: number): Promise<void> {
	await assert.rejects(run, (error) => {
		assert.equal(error instanceof HttpError, true);
		assert.equal((error as HttpError).status, status);
		return true;
	});
}

describe("web books", () => {
	it("ingests EPUB metadata, spine, navigation, sanitized chapters, assets, and cover", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const record = await ingestBook(config, {
			name: "fixture.epub",
			mimeType: "application/epub+zip",
			buffer: tinyEpub(),
		});

		assert.equal(record.title, "Fixture Book");
		assert.equal(record.author, "A. Reader");
		assert.equal(record.language, "en");
		assert.equal(record.format, "epub");
		assert.deepEqual(
			record.chapters.map((chapter) => chapter.title),
			["Second First", "Opening"],
		);
		assert.ok(record.chapters.every((chapter) => chapter.chars > 0));

		const first = await readWebBookChapter(config, record.id, 1);
		assert.doesNotMatch(first.html, /<(?:html|head|body|script|style)\b/i);
		assert.doesNotMatch(first.html, /\s(?:on\w+|style)\s*=/i);
		assert.doesNotMatch(first.html, /javascript:|<a\b|href=/i);
		assert.match(first.html, /<h1 id="opening">Fallback Heading<\/h1>/);
		assert.match(first.html, /<p class="lead">Hello <strong>reader<\/strong>\.<\/p>/);
		assert.match(first.css ?? "", /\.reader-content \.lead\s*\{\s*color: red/);
		assert.doesNotMatch(first.css ?? "", /@import|@font-face|https:\/\//i);
		assert.match(first.html, /<img[^>]+class="decor"/);
		assert.match(first.html, /Next chapter/);
		const assetName = /\/api\/web\/books\/assets\/[a-f0-9]{10}\/([a-f0-9]+\.png)/.exec(first.html)?.[1];
		assert.ok(assetName);
		assert.deepEqual(await readFile(resolve(bookDir(config, record.id), "assets", assetName)), PIXEL_PNG);
		assert.deepEqual(await readFile(resolve(bookDir(config, record.id), "assets", "cover.png")), PIXEL_PNG);
		assert.equal(first.chars, "Fallback Heading Hello reader. Next chapter".length);

		const detail = await readWebBook(config, record.id);
		assert.equal(detail.coverUrl, `/api/web/books/assets/${record.id}/cover.png`);
		assert.equal(detail.chapterCount, 2);
		assert.equal((await listWebBooks(config))[0]?.id, record.id);
	});

	it("rebuilds malicious XHTML without exposing nested tags or double-decoded entities", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const record = await ingestBook(config, {
			name: "hostile.epub",
			buffer: tinyEpub(
				"<scr<script>ipt></scr<script>ipt><p>&amp;lt;script&amp;gt;literal&amp;lt;/script&amp;gt;</p>",
			),
		});
		const chapter = await readWebBookChapter(config, record.id, 1);

		assert.doesNotMatch(chapter.html, /<script\b/i);
		assert.match(chapter.html, /&amp;lt;script&amp;gt;literal&amp;lt;\/script&amp;gt;/);
	});

	it("re-encodes white-ground ornament images as ink on transparency", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		// 16x4 white strip with a black 8px run: grayscale, white ground, real ink.
		const raw = Buffer.alloc(16 * 4 * 3, 255);
		raw.fill(0, 24 * 3, 32 * 3);
		const ornament = await sharp(raw, { raw: { width: 16, height: 4, channels: 3 } })
			.png()
			.toBuffer();
		const record = await ingestBook(config, {
			name: "ornament.epub",
			buffer: tinyEpub('<img src="images/ornament.png" alt="scene break"/>', {
				"OPS/images/ornament.png": ornament,
			}),
		});
		const chapter = await readWebBookChapter(config, record.id, 1);

		const inkName = /\/api\/web\/books\/assets\/[a-f0-9]{10}\/([a-f0-9]{16}-ornament\.png)/.exec(chapter.html)?.[1];
		assert.ok(inkName, "ornament img src should point at the converted asset");
		const stored = await readFile(resolve(bookDir(config, record.id), "assets", inkName));
		const metadata = await sharp(stored).metadata();
		assert.equal(metadata.hasAlpha, true);
		// The photographic pixel asset keeps its original bytes and name.
		assert.deepEqual(
			await readFile(resolve(bookDir(config, record.id), "assets", "cover.png")),
			PIXEL_PNG,
		);
	});

	it("ingests TXT and Markdown as escaped paragraph HTML", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const record = await ingestBook(config, {
			name: "notes.md",
			mimeType: "text/markdown",
			buffer: Buffer.from('Hello <world>\n\nSecond & "quoted"'),
		});
		const chapter = await readWebBookChapter(config, record.id, 0);

		assert.equal(record.title, "notes");
		assert.equal(record.format, "text");
		assert.equal(chapter.html, "<p>Hello &lt;world&gt;</p>\n<p>Second &amp; &quot;quoted&quot;</p>");
		assert.equal(chapter.chars, 'Hello <world> Second & "quoted"'.length);
		assert.equal(await readFile(resolve(bookDir(config, record.id), "source.md"), "utf8"), 'Hello <world>\n\nSecond & "quoted"');
	});

	it("reads books and chapters, stores progress, manages marginalia, and deletes the book", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const record = await ingestBook(config, { name: "fixture.epub", buffer: tinyEpub() });
		const detail = await readWebBook(config, record.id);
		const { position, percent } = await writeBookPosition(config, record.id, 1, 0.5);
		const expected = ((detail.chapters[0]!.chars + detail.chapters[1]!.chars * 0.5) / detail.chapters.reduce((sum, chapter) => sum + chapter.chars, 0)) * 100;

		assert.equal(percent, expected);
		assert.deepEqual((await listWebBooks(config))[0]?.position, position);
		assert.equal((await listWebBooks(config))[0]?.percent, expected);
		await expectHttpStatus(() => readWebBookChapter(config, record.id, 2), 404);

		const created = await createBookMarginalia(config, record.id, {
			chapter: 1,
			quote: "Hello reader.",
			prefix: "Fallback Heading ",
			suffix: " Next chapter",
			note: "remember",
		});
		assert.deepEqual(await readBookMarginalia(config, record.id), [created]);
		const updated = await updateBookMarginalia(config, record.id, created.id, "updated");
		assert.equal(updated.note, "updated");
		await deleteBookMarginalia(config, record.id, created.id);
		assert.deepEqual(await readBookMarginalia(config, record.id), []);

		await deleteWebBook(config, record.id);
		await expectHttpStatus(() => readWebBook(config, record.id), 404);
	});

	it("rejects traversal ids, oversized uploads, and unsupported formats", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		for (const id of ["../book", "/tmp/book", "abc def", "book%2Fid", "abcdefghij"]) {
			assert.throws(() => assertBookId(id), (error) => error instanceof HttpError && error.status === 400);
			await expectHttpStatus(() => readWebBook(config, id), 400);
		}
		await expectHttpStatus(
			() => ingestBook(config, { name: "huge.txt", buffer: Buffer.alloc(MAX_BOOK_BYTES + 1) }),
			413,
		);
		await expectHttpStatus(() => ingestBook(config, { name: "manual.pdf", buffer: Buffer.from("pdf") }), 415);
	});

	it("registers the complete exact-match API", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const routes = new Set<string>();
		const route: RegisterWebRoute = (method, pathname) => routes.add(`${method} ${pathname}`);
		registerWebBookRoutes(route, config);
		assert.deepEqual(routes, new Set([
			"POST /api/web/books",
			"GET /api/web/books",
			"GET /api/web/book",
			"GET /api/web/book/chapter",
			"PUT /api/web/book/position",
			"GET /api/web/book/marginalia",
			"POST /api/web/book/marginalia",
			"PUT /api/web/book/marginalia",
			"DELETE /api/web/book/marginalia",
			"DELETE /api/web/book",
		]));
	});
});
