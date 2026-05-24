import type { StoredLcmRecord } from "./types.js";

export interface EvictionScoreContext {
	promptUniqueTerms: Set<string>;
	documentFrequencies: Map<string, number>;
	recordTerms: Map<StoredLcmRecord, string[]>;
	candidateCount: number;
}

export function tokenBag(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 2);
}

export function buildEvictionScoreContext(
	prompt: string,
	allRecords: readonly StoredLcmRecord[],
): EvictionScoreContext | null {
	const promptTerms = tokenBag(prompt);
	if (promptTerms.length === 0) return null;

	const promptUniqueTerms = new Set(promptTerms);
	const documentFrequencies = new Map<string, number>();
	const recordTerms = new Map<StoredLcmRecord, string[]>();
	for (const candidate of allRecords) {
		const terms = tokenBag(candidate.text);
		recordTerms.set(candidate, terms);
		const candidateTerms = new Set(terms);
		for (const term of promptUniqueTerms) {
			if (candidateTerms.has(term)) documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
		}
	}

	return {
		promptUniqueTerms,
		documentFrequencies,
		recordTerms,
		candidateCount: Math.max(0, allRecords.length),
	};
}

export function scoreEvictable(
	record: StoredLcmRecord,
	prompt: string,
	allRecords: StoredLcmRecord[],
	context = buildEvictionScoreContext(prompt, allRecords),
): number {
	if (!context) return 0;

	const recordTerms = context.recordTerms.get(record) ?? tokenBag(record.text);
	if (recordTerms.length === 0) return 0;

	const recordFreq = new Map<string, number>();
	for (const term of recordTerms) recordFreq.set(term, (recordFreq.get(term) ?? 0) + 1);

	let score = 0;
	for (const term of context.promptUniqueTerms) {
		const tf = recordFreq.get(term) ?? 0;
		if (tf <= 0) continue;
		const normalizedTf = tf / recordTerms.length;
		const df = context.documentFrequencies.get(term) ?? 0;
		const idf = Math.log((context.candidateCount + 1) / (df + 1) + 1);
		score += normalizedTf * idf;
	}
	return score;
}
