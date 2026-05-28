import { type FetchProviderName, MAX_CACHE_CHARS_PER_PAGE, type PageCacheEntry } from "./types.js";

export class PageCache {
	readonly ttlMs: number;
	readonly capacity: number;
	readonly entries = new Map<string, PageCacheEntry>();

	constructor(options: { ttlMs?: number; capacity?: number } = {}) {
		this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
		this.capacity = options.capacity ?? 20;
	}

	get(url: string): PageCacheEntry | undefined {
		const entry = this.entries.get(url);
		if (!entry) return undefined;
		if (Date.now() - entry.fetchedAt > this.ttlMs) {
			this.entries.delete(url);
			return undefined;
		}
		entry.lastAccessed = Date.now();
		this.entries.delete(url);
		this.entries.set(url, entry);
		return entry;
	}

	set(url: string, content: string, provider: FetchProviderName): void {
		if (content.length > MAX_CACHE_CHARS_PER_PAGE) return;
		if (this.entries.has(url)) this.entries.delete(url);
		const now = Date.now();
		this.entries.set(url, {
			content,
			provider,
			fetchedAt: now,
			lastAccessed: now,
		});
		while (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (!oldest) break;
			this.entries.delete(oldest);
		}
	}
}
