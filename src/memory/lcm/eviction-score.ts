import type { StoredLcmRecord } from "./types.js";

export function tokenBag(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 2);
}

export function scoreEvictable(record: StoredLcmRecord, prompt: string, allRecords: StoredLcmRecord[]): number {
	const promptTerms = tokenBag(prompt);
	if (promptTerms.length === 0) return 0;

	const recordTerms = tokenBag(record.text);
	if (recordTerms.length === 0) return 0;

	const recordFreq = new Map<string, number>();
	for (const term of recordTerms) recordFreq.set(term, (recordFreq.get(term) ?? 0) + 1);

	const promptUniqueTerms = new Set(promptTerms);
	const documentFrequencies = new Map<string, number>();
	for (const candidate of allRecords) {
		const candidateTerms = new Set(tokenBag(candidate.text));
		for (const term of promptUniqueTerms) {
			if (candidateTerms.has(term)) documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
		}
	}

	const candidateCount = Math.max(0, allRecords.length);
	let score = 0;
	for (const term of promptUniqueTerms) {
		const tf = recordFreq.get(term) ?? 0;
		if (tf <= 0) continue;
		const normalizedTf = tf / recordTerms.length;
		const df = documentFrequencies.get(term) ?? 0;
		const idf = Math.log((candidateCount + 1) / (df + 1) + 1);
		score += normalizedTf * idf;
	}
	return score;
}
