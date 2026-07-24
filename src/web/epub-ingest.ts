import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, posix, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { strFromU8, unzipSync } from "fflate";

import type { Config } from "../config/index.js";
import { atomicWriteJson, isEnoent } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { type BookChapter, type BookRecord, booksDir } from "./book-library.js";
import { HttpError } from "./http.js";
import type { WebUploadAttachment } from "./multipart.js";

export const MAX_BOOK_BYTES = 80 * 1024 * 1024;

interface ParsedBook {
	title: string;
	author?: string;
	language?: string;
	format: BookRecord["format"];
	chapters: Array<BookChapter & { html: string }>;
	assets: Map<string, Uint8Array>;
	cover?: { file: string; bytes: Uint8Array };
}

interface ManifestItem {
	id: string;
	href: string;
	mediaType: string;
	properties: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: false });
const ALLOWED_TAGS = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"blockquote",
	"em",
	"i",
	"strong",
	"b",
	"ul",
	"ol",
	"li",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"th",
	"td",
	"figure",
	"figcaption",
	"img",
	"hr",
	"br",
	"sup",
	"sub",
	"span",
	"div",
]);
const VOID_TAGS = new Set(["img", "hr", "br"]);

export async function ingestBook(config: Config, attachment: WebUploadAttachment): Promise<BookRecord> {
	if (attachment.buffer.length > MAX_BOOK_BYTES) throw new HttpError(413, "book upload exceeds 80 MB");
	const upload = classifyUpload(attachment);
	const id = await unusedBookId(config);
	const root = booksDir(config);
	const tempDir = resolve(root, `.${id}-${randomBytes(4).toString("hex")}.tmp`);
	const finalDir = resolve(root, id);
	let parsed: ParsedBook;
	try {
		parsed =
			upload.kind === "epub"
				? parseEpub(attachment.buffer, id)
				: parseTextBook(attachment.buffer.toString("utf8"), upload.title);
	} catch (error) {
		if (error instanceof HttpError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new HttpError(422, `invalid epub: ${message}`);
	}
	await mkdir(tempDir, { recursive: true });
	try {
		await writeFile(resolve(tempDir, `source.${upload.extension}`), attachment.buffer);
		await mkdir(resolve(tempDir, "chapters"), { recursive: true });
		await Promise.all(
			parsed.chapters.map((chapter) =>
				writeFile(resolve(tempDir, "chapters", `${chapter.index}.html`), chapter.html, "utf8"),
			),
		);
		if (parsed.assets.size > 0 || parsed.cover) {
			await mkdir(resolve(tempDir, "assets"), { recursive: true });
			await Promise.all(
				[...parsed.assets].map(([path, bytes]) => writeFile(resolve(tempDir, "assets", path), bytes)),
			);
		}
		if (parsed.cover) await writeFile(resolve(tempDir, "assets", parsed.cover.file), parsed.cover.bytes);
		const book: BookRecord = {
			id,
			title: parsed.title,
			...(parsed.author ? { author: parsed.author } : {}),
			...(parsed.language ? { language: parsed.language } : {}),
			format: parsed.format,
			createdAt: Date.now(),
			chapters: parsed.chapters.map(({ index, title, chars }) => ({ index, title, chars })),
			...(parsed.cover ? { cover: { file: parsed.cover.file } } : {}),
		};
		await atomicWriteJson(resolve(tempDir, "book.json"), book);
		await atomicWriteJson(resolve(tempDir, "marginalia.json"), { entries: [] });
		await rename(tempDir, finalDir);
		return book;
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

function classifyUpload(attachment: WebUploadAttachment): {
	kind: "epub" | "text";
	extension: "epub" | "txt" | "md";
	title: string;
} {
	const name = basename(attachment.name ?? "");
	const extension = extname(name).slice(1).toLowerCase();
	if (extension === "epub" || attachment.mimeType?.toLowerCase() === "application/epub+zip") {
		return { kind: "epub", extension: "epub", title: name.replace(/\.[^.]+$/, "") || "book" };
	}
	if (extension === "txt" || extension === "md") {
		return { kind: "text", extension, title: name.slice(0, -(extension.length + 1)) || "book" };
	}
	throw new HttpError(415, "unsupported book format");
}

function parseTextBook(text: string, title: string): ParsedBook {
	const parts = Buffer.byteLength(text) > 200 * 1024 ? splitLargeText(text) : [text];
	return {
		title,
		format: "text",
		assets: new Map(),
		chapters: parts.map((part, index) => {
			const html = textToHtml(part);
			return { index, title: parts.length === 1 ? title : `part ${index + 1}`, html, chars: htmlText(html).length };
		}),
	};
}

function splitLargeText(text: string): string[] {
	const paragraphs = text.split(/\r?\n\s*\r?\n/);
	const parts: string[] = [];
	let current = "";
	for (const paragraph of paragraphs) {
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (current && Buffer.byteLength(candidate) > 100 * 1024) {
			parts.push(current);
			current = paragraph;
		} else {
			current = candidate;
		}
	}
	parts.push(current);
	return parts;
}

function textToHtml(text: string): string {
	return text
		.split(/\r?\n\s*\r?\n/)
		.map((paragraph) => `<p>${escapeHtml(paragraph.trim())}</p>`)
		.join("\n");
}

function parseEpub(buffer: Buffer, id: string): ParsedBook {
	let unzipped: Record<string, Uint8Array>;
	try {
		unzipped = unzipSync(buffer);
	} catch (error) {
		throw new Error(`zip: ${error instanceof Error ? error.message : String(error)}`);
	}
	const files = new Map(Object.entries(unzipped).map(([path, bytes]) => [normalizeZipPath(path), bytes] as const));
	const container = child(parseXml(readZipText(files, "META-INF/container.xml")), "container");
	const rootfiles = child(container, "rootfiles");
	const rootfile = records(rootfiles.rootfile)[0];
	const opfPath = rootfile ? attr(rootfile, "full-path") : undefined;
	if (!opfPath) throw new Error("container.xml has no rootfile");
	const normalizedOpfPath = normalizeZipPath(opfPath);
	const packageNode = child(parseXml(readZipText(files, normalizedOpfPath)), "package");
	const metadata = child(packageNode, "metadata");
	const manifestNode = child(packageNode, "manifest");
	const spineNode = child(packageNode, "spine");
	const manifest = records(manifestNode.item).map(parseManifestItem);
	const manifestById = new Map(manifest.map((item) => [item.id, item]));
	const labels = chapterLabels(files, normalizedOpfPath, manifest, spineNode);
	const assets = new Map<string, Uint8Array>();
	const spine = records(spineNode.itemref);
	const chapters = spine.map((itemref, index) => {
		const idref = attr(itemref, "idref");
		const item = idref ? manifestById.get(idref) : undefined;
		if (!item) throw new Error(`spine item ${index} is missing from manifest`);
		const chapterPath = resolveZipReference(normalizedOpfPath, item.href);
		const html = sanitizeChapter(readZipText(files, chapterPath), chapterPath, id, files, assets);
		return {
			index,
			title: labels.get(chapterPath) ?? firstHeading(html) ?? `chapter ${index + 1}`,
			html,
			chars: htmlText(html).length,
		};
	});
	if (chapters.length === 0) throw new Error("spine has no chapters");
	const coverItem = findCoverItem(metadata, manifest, manifestById);
	const cover = coverItem ? extractCover(files, normalizedOpfPath, coverItem) : undefined;
	return {
		title: childText(metadata, "title")?.trim() || "untitled",
		...(childText(metadata, "creator")?.trim() ? { author: childText(metadata, "creator")!.trim() } : {}),
		...(childText(metadata, "language")?.trim() ? { language: childText(metadata, "language")!.trim() } : {}),
		format: "epub",
		chapters,
		assets,
		...(cover ? { cover } : {}),
	};
}

function chapterLabels(
	files: Map<string, Uint8Array>,
	opfPath: string,
	manifest: ManifestItem[],
	spine: Record<string, unknown>,
): Map<string, string> {
	const labels = new Map<string, string>();
	const navItem = manifest.find((item) => item.properties.split(/\s+/).includes("nav"));
	if (navItem) {
		const navPath = resolveZipReference(opfPath, navItem.href);
		collectNavLinks(parseXml(readZipText(files, navPath)), navPath, labels);
	}
	const ncxId = attr(spine, "toc");
	const ncxItem =
		(ncxId ? manifest.find((item) => item.id === ncxId) : undefined) ??
		manifest.find((item) => item.mediaType === "application/x-dtbncx+xml");
	if (ncxItem) {
		const ncxPath = resolveZipReference(opfPath, ncxItem.href);
		collectNcxPoints(parseXml(readZipText(files, ncxPath)), ncxPath, labels);
	}
	return labels;
}

function collectNavLinks(value: unknown, navPath: string, labels: Map<string, string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectNavLinks(item, navPath, labels);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, childValue] of Object.entries(value)) {
		if (key === "a") {
			for (const link of records(childValue)) {
				const href = attr(link, "href");
				const label = xmlText(link).trim();
				if (href && label) labels.set(resolveZipReference(navPath, href), label);
			}
		}
		collectNavLinks(childValue, navPath, labels);
	}
}

function collectNcxPoints(value: unknown, ncxPath: string, labels: Map<string, string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectNcxPoints(item, ncxPath, labels);
		return;
	}
	if (!isRecord(value)) return;
	if (value.navLabel && value.content) {
		const content = records(value.content)[0];
		const source = content ? attr(content, "src") : undefined;
		const label = xmlText(value.navLabel).trim();
		if (source && label && !labels.has(resolveZipReference(ncxPath, source))) {
			labels.set(resolveZipReference(ncxPath, source), label);
		}
	}
	for (const childValue of Object.values(value)) collectNcxPoints(childValue, ncxPath, labels);
}

function sanitizeChapter(
	xhtml: string,
	chapterPath: string,
	id: string,
	files: Map<string, Uint8Array>,
	assets: Map<string, Uint8Array>,
): string {
	let html = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(xhtml)?.[1] ?? xhtml;
	html = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<\/?(?:script|style|link|meta|iframe|object|embed)\b[^>]*>/gi, "");
	const rewrite = (source: string): string => {
		const decodedSource = decodeHtml(source).trim();
		const rewrittenPrefix = `/api/web/books/assets/${id}/`;
		if (decodedSource.startsWith(rewrittenPrefix)) return decodedSource;
		if (/^javascript:/i.test(decodedSource)) return "";
		const zipPath = resolveZipReference(chapterPath, decodedSource);
		const bytes = files.get(zipPath);
		if (!bytes) throw new Error(`missing image ${zipPath}`);
		const extension = safeAssetExtension(zipPath);
		const assetPath = `${createHash("sha256").update(zipPath).digest("hex").slice(0, 16)}${extension}`;
		assets.set(assetPath, bytes);
		return `/api/web/books/assets/${id}/${assetPath}`;
	};
	html = html.replace(
		/<svg\b[^>]*>[\s\S]*?<image\b([^>]*)\/?\s*>[\s\S]*?<\/svg\s*>/gi,
		(_match, attributes: string) => {
			const source = attribute(attributes, "xlink:href") ?? attribute(attributes, "href");
			return source ? `<img src="${escapeAttribute(rewrite(source))}">` : "";
		},
	);
	html = html.replace(/<img\b([^>]*)>/gi, (_match, attributes: string) => {
		const source = attribute(attributes, "src");
		const rewritten = source ? rewrite(source) : "";
		const alt = attribute(attributes, "alt");
		return `<img${rewritten ? ` src="${escapeAttribute(rewritten)}"` : ""}${alt ? ` alt="${escapeAttribute(alt)}"` : ""}>`;
	});
	return html.replace(/<\/?([a-z][\w:-]*)\b([^>]*)>/gi, (match, rawTag: string, rawAttributes: string) => {
		const tag = rawTag.toLowerCase();
		if (!ALLOWED_TAGS.has(tag)) return "";
		if (match.startsWith("</")) return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
		const kept: string[] = [];
		for (const name of ["id", "class"]) {
			const value = attribute(rawAttributes, name);
			if (value) kept.push(`${name}="${escapeAttribute(value)}"`);
		}
		if (tag === "img") {
			for (const name of ["src", "alt", "title", "width", "height"]) {
				const value = attribute(rawAttributes, name);
				if (value && (name !== "src" || value.startsWith(`/api/web/books/assets/${id}/`))) {
					kept.push(`${name}="${escapeAttribute(value)}"`);
				}
			}
		}
		return `<${tag}${kept.length ? ` ${kept.join(" ")}` : ""}>`;
	});
}

function findCoverItem(
	metadata: Record<string, unknown>,
	manifest: ManifestItem[],
	manifestById: Map<string, ManifestItem>,
): ManifestItem | undefined {
	const declared = manifest.find((item) => item.properties.split(/\s+/).includes("cover-image"));
	if (declared) return declared;
	const coverMeta = records(metadata.meta).find((meta) => attr(meta, "name") === "cover");
	const coverId = coverMeta ? attr(coverMeta, "content") : undefined;
	return coverId ? manifestById.get(coverId) : undefined;
}

function extractCover(
	files: Map<string, Uint8Array>,
	opfPath: string,
	item: ManifestItem,
): NonNullable<ParsedBook["cover"]> {
	const path = resolveZipReference(opfPath, item.href);
	const bytes = files.get(path);
	if (!bytes) throw new Error(`missing cover ${path}`);
	const extension = safeAssetExtension(path, item.mediaType);
	return { file: `cover${extension}`, bytes };
}

function parseManifestItem(value: Record<string, unknown>): ManifestItem {
	const id = attr(value, "id");
	const href = attr(value, "href");
	if (!id || !href) throw new Error("manifest item is missing id or href");
	return {
		id,
		href,
		mediaType: attr(value, "media-type") ?? "application/octet-stream",
		properties: attr(value, "properties") ?? "",
	};
}

function parseXml(xml: string): Record<string, unknown> {
	const value: unknown = xmlParser.parse(xml);
	if (!isRecord(value)) throw new Error("XML root is invalid");
	return value;
}

function child(value: Record<string, unknown>, key: string): Record<string, unknown> {
	const result = records(value[key])[0];
	if (!result) throw new Error(`XML element ${key} is missing`);
	return result;
}

function childText(value: Record<string, unknown>, key: string): string | undefined {
	const childValue = value[key];
	return childValue === undefined ? undefined : xmlText(childValue);
}

function records(value: unknown): Record<string, unknown>[] {
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return values.filter(isRecord);
}

function attr(value: Record<string, unknown>, name: string): string | undefined {
	const result = value[`@_${name}`];
	return typeof result === "string" || typeof result === "number" ? String(result) : undefined;
}

function xmlText(value: unknown): string {
	if (typeof value === "string" || typeof value === "number") return String(value);
	if (Array.isArray(value)) return value.map(xmlText).join(" ");
	if (!isRecord(value)) return "";
	if (typeof value["#text"] === "string" || typeof value["#text"] === "number") return String(value["#text"]);
	return Object.entries(value)
		.filter(([key]) => !key.startsWith("@_"))
		.map(([, childValue]) => xmlText(childValue))
		.join(" ");
}

function readZipText(files: Map<string, Uint8Array>, path: string): string {
	const bytes = files.get(normalizeZipPath(path));
	if (!bytes) throw new Error(`missing EPUB file ${path}`);
	return strFromU8(bytes);
}

function normalizeZipPath(path: string): string {
	const decoded = decodeURIComponent(path.replaceAll("\\", "/")).replace(/^\/+/, "");
	const normalized = posix.normalize(decoded);
	if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("\0")) {
		throw new Error(`invalid EPUB path ${path}`);
	}
	return normalized;
}

function resolveZipReference(basePath: string, reference: string): string {
	const path = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? "");
	return normalizeZipPath(posix.join(posix.dirname(basePath), path));
}

function safeAssetExtension(path: string, mimeType = ""): string {
	const extension = extname(path).toLowerCase();
	if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
	if (mimeType === "image/jpeg") return ".jpg";
	if (mimeType === "image/png") return ".png";
	if (mimeType === "image/gif") return ".gif";
	if (mimeType === "image/webp") return ".webp";
	if (mimeType === "image/svg+xml") return ".svg";
	return ".bin";
}

function attribute(attributes: string, name: string): string | undefined {
	const escaped = name.replace(":", "\\:");
	const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i").exec(attributes);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function firstHeading(html: string): string | undefined {
	const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html)?.[1];
	return heading ? htmlText(heading) : undefined;
}

function htmlText(html: string): string {
	return decodeHtml(html.replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, "\u00a0")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'");
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replaceAll("'", "&#39;");
}

async function unusedBookId(config: Config): Promise<string> {
	await mkdir(booksDir(config), { recursive: true });
	for (;;) {
		const id = randomBytes(5).toString("hex");
		try {
			await lstat(resolve(booksDir(config), id));
		} catch (error) {
			if (isEnoent(error)) return id;
			throw error;
		}
	}
}
