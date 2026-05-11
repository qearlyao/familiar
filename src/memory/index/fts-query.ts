export function normalizeFtsMatchQuery(query: string): string | null {
	const tokens = query
		.normalize("NFKC")
		.match(/[\p{L}\p{N}_]+/gu)
		?.map((token) => `"${token.replaceAll('"', '""')}"`);
	return tokens && tokens.length > 0 ? tokens.join(" ") : null;
}
