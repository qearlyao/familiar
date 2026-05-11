export function normalizeFtsMatchQuery(query: string): string | null {
	const tokens: string[] = [];
	for (const rawToken of query.normalize("NFKC").split(/\s+/u)) {
		if (!rawToken) continue;
		const hasPrefix = rawToken.endsWith("*");
		const body = hasPrefix ? rawToken.slice(0, -1) : rawToken;
		const parts = body.match(/[\p{L}\p{N}_]+/gu) ?? [];
		if (parts.length === 0) continue;
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index] as string;
			const suffix = hasPrefix && index === parts.length - 1 ? "*" : "";
			tokens.push(`"${part.replaceAll('"', '""')}"${suffix}`);
		}
	}
	return tokens.length > 0 ? tokens.join(" ") : null;
}
