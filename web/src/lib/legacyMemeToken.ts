export interface LegacyMeme {
  name: string;
  url: string;
}

export const IMAGE_URL_RE = /\.(?:jpe?g|png|gif|webp)(?:\?[^\s]*)?$/i;

const URL_RE = /https?:\/\/[^\s)<>"']+/gi;
const MEME_PREFIX_RE = /meme:\s*/gi;
const GFM_LINK_PREFIX_RE = /meme:\s*([^\n]*?)\($/i;

export function legacyMemeToken(meme: LegacyMeme): string {
  return `meme: ${meme.name} (${meme.url})`;
}

export function splitLegacyMemeLinkPrefix(value: string): { before: string; name: string } | undefined {
  const match = GFM_LINK_PREFIX_RE.exec(value);
  if (!match) return undefined;
  return {
    before: value.slice(0, match.index),
    name: (match[1] ?? "").trim(),
  };
}

function findLegacyMemeMatch(
  text: string,
  start: number,
): { whole: string; name: string; url: string } | null {
  const lineEnd = text.indexOf("\n", start);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const line = text.slice(start, end);
  const lineUrlRe = new RegExp(URL_RE.source, "gi");
  const urlMatches = Array.from(line.matchAll(lineUrlRe));

  for (let index = urlMatches.length - 1; index >= 0; index -= 1) {
    const match = urlMatches[index];
    const url = match?.[0];
    const urlStart = match?.index ?? 0;
    if (!url) continue;

    const open = line.lastIndexOf("(", urlStart);
    const close = urlStart + url.length;
    if (open === -1 || line[close] !== ")") continue;

    const name = line.slice(0, open).trim();
    if (!name) continue;
    return { whole: line.slice(0, close + 1), name, url };
  }

  return null;
}

export type LegacyMediaToken =
  | { type: "meme"; index: number; whole: string; name: string; url: string }
  | { type: "image-url"; index: number; whole: string; url: string };

export function legacyMediaTokens(text: string): LegacyMediaToken[] {
  const tokens: LegacyMediaToken[] = [];
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
        ? findLegacyMemeMatch(text, memeStart + (memePrefix?.[0].length ?? 0))
        : null;

    if (memeStart === index && !meme) {
      searchFrom = index + (memePrefix?.[0].length ?? 0);
      continue;
    }

    const whole = meme?.whole ?? urlMatch?.[0];
    if (!whole) break;

    if (meme) {
      tokens.push({
        type: "meme",
        index,
        whole: `${memePrefix?.[0] ?? ""}${meme.whole}`,
        name: meme.name,
        url: meme.url,
      });
      searchFrom = index + (memePrefix?.[0].length ?? 0) + meme.whole.length;
      continue;
    }

    if (IMAGE_URL_RE.test(whole)) {
      tokens.push({ type: "image-url", index, whole, url: whole });
    }
    searchFrom = index + whole.length;
  }

  return tokens;
}
