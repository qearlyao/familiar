import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Config } from "../config/index.js";
import { isEnoent } from "../util/fs.js";
import { chunkDiaryMarkdown } from "./diary/chunks.js";
import type { ChunkIndexer } from "./index/chunk-indexer.js";
import type { MemoryIndexStore } from "./index/store.js";

export const NOTE_CORPUS = "note";

export interface IndexNoteFilesOptions {
	config: Config;
	indexer: ChunkIndexer;
	store: MemoryIndexStore;
	signal?: AbortSignal;
}

/** Reindexes every note and drops notes whose file is gone; unchanged chunks reuse their stored embeddings. */
export async function indexNoteFiles(options: IndexNoteFilesOptions): Promise<{ chunks: number }> {
	const names = await listNoteFiles(options.config.memory.notesDir);
	let chunks = 0;
	for (const name of names) {
		if (options.signal?.aborted) return { chunks };
		const path = join(options.config.memory.notesDir, name);
		const markdown = await readFile(path, "utf8");
		const topic = basename(name, ".md");
		// Bullets are chunked one by one, so carry the topic and heading into the text the index embeds.
		const inputs = chunkDiaryMarkdown(markdown, { sourceId: name, sourceRef: path }).map((chunk) => ({
			sourceRef: chunk.sourceRef,
			chunkIndex: chunk.chunkIndex,
			text: `${[topic, chunk.metadata.heading].filter(Boolean).join(" / ")}\n${chunk.text}`,
			snippet: chunk.snippet,
			metadata: { heading: chunk.metadata.heading },
		}));
		const result = await options.indexer.replaceSource(NOTE_CORPUS, name, inputs, options.signal);
		chunks += result.ids.length;
	}
	const present = new Set(names);
	for (const sourceId of options.store.sourceIds(NOTE_CORPUS)) {
		if (!present.has(sourceId)) options.store.deleteBySource(NOTE_CORPUS, sourceId);
	}
	return { chunks };
}

async function listNoteFiles(dir: string): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name)
		.sort();
}
