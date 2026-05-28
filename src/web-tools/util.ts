export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hostnameFromUrl(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

export function normalizeIsoDate(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const parsed = new Date(input);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function truncateSnippet(text: string, maxLen: number): string {
	const normalized = text.replaceAll(/\s+/g, " ").trim();
	if (normalized.length <= maxLen) return normalized;
	const slice = normalized.slice(0, maxLen + 1);
	const lastSpace = slice.lastIndexOf(" ");
	const cutoff = lastSpace >= Math.floor(maxLen * 0.6) ? lastSpace : maxLen;
	return `${normalized.slice(0, cutoff).trimEnd()}...`;
}
