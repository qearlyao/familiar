type TextSegment = { type: "text"; value: string };
type ImageSegment = { type: "image"; url: string; alt: string };

export type InlineSegment = TextSegment | ImageSegment;

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)(?:\?[^\s]*)?$/i;
const URL_RE = /https?:\/\/[^\s)<>"']+/gi;
const MEME_PREFIX_RE = /meme:\s*/gi;

function findMemeMatch(
	text: string,
	start: number,
): { whole: string; name: string; url: string } | null {
	const lineEnd = text.indexOf("\n", start);
	const end = lineEnd === -1 ? text.length : lineEnd;
	const line = text.slice(start, end);
	const lineUrlRe = new RegExp(URL_RE.source, "gi");
	const urlMatches = Array.from(line.matchAll(lineUrlRe));
	for (let i = urlMatches.length - 1; i >= 0; i--) {
		const match = urlMatches[i];
		const url = match[0];
		const urlStart = match.index ?? 0;
		const open = line.lastIndexOf("(", urlStart);
		const close = urlStart + url.length;
		if (open === -1 || line[close] !== ")") continue;
		const name = line.slice(0, open).trim();
		if (!name) continue;
		return { whole: line.slice(0, close + 1), name, url };
	}
	return null;
}

export function parseInlineSegments(text: string): InlineSegment[] {
	const segments: InlineSegment[] = [];
	let cursor = 0;
	let searchFrom = 0;
	while (searchFrom < text.length) {
		MEME_PREFIX_RE.lastIndex = searchFrom;
		URL_RE.lastIndex = searchFrom;
		const memePrefix = MEME_PREFIX_RE.exec(text);
		const urlMatch = URL_RE.exec(text);
		const memeStart =
			memePrefix && (!urlMatch || memePrefix.index <= urlMatch.index)
				? memePrefix.index
				: -1;
		const index = memeStart === -1 ? urlMatch?.index : memeStart;
		if (index === undefined) break;

		const meme =
			memeStart === index
				? findMemeMatch(text, memeStart + memePrefix![0].length)
				: null;
		if (memeStart === index && !meme) {
			searchFrom = index + memePrefix![0].length;
			continue;
		}
		const whole = meme?.whole ?? urlMatch![0];
		const url = meme?.url ?? whole;
		const isImage = Boolean(meme) || IMAGE_EXT_RE.test(url);
		if (!isImage) {
			searchFrom = index + whole.length;
			continue;
		}
		if (index > cursor) {
			segments.push({ type: "text", value: text.slice(cursor, index) });
		}
		segments.push({ type: "image", url, alt: meme?.name ?? "" });
		cursor = index + (meme ? memePrefix![0].length : 0) + whole.length;
		searchFrom = cursor;
	}
	if (cursor < text.length) {
		segments.push({ type: "text", value: text.slice(cursor) });
	}
	return segments;
}

export function collapseInlineSegments(segments: InlineSegment[]): InlineSegment[] {
	const out: InlineSegment[] = [];
	let buffer = "";
	for (const seg of segments) {
		if (seg.type === "text") {
			buffer += seg.value;
			continue;
		}
		const trimmed = buffer.replace(/[ \t]+$/, "").replace(/\n{2,}$/, "\n");
		if (trimmed.trim()) out.push({ type: "text", value: trimmed });
		buffer = "";
		out.push(seg);
	}
	const tail = buffer.replace(/^\n+/, "");
	if (tail.trim()) out.push({ type: "text", value: tail });
	return out;
}
