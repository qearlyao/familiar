import { type FSWatcher, watch } from "node:fs";
import { basename, resolve } from "node:path";

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";

import type { Config } from "../config/index.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { isEnoent } from "../util/fs.js";
import { __ambientDiaryInjectorTest, AmbientDiaryInjector } from "./diary/ambient-injector.js";
import { DIARY_INDEX_FILE_RE, indexAllDiaryFiles, indexDiaryFile, removeDiaryFileIndex } from "./diary/indexer.js";
import { ChunkIndexer } from "./index/chunk-indexer.js";
import { createEmbeddingProvider } from "./index/embedding-provider.js";
import { MemoryIndexStore } from "./index/store.js";
import { LcmContextTransformer } from "./lcm/context-transformer.js";
import { LcmSegmentManager } from "./lcm/segment-manager.js";
import { LcmStore } from "./lcm/store.js";
import { DefaultLcmSummarizer, type LcmSummarizer } from "./lcm/summarizer.js";
import { createMemoryTools } from "./tools.js";

export interface MemoryService {
	memoryTools(): AgentTool<any>[];
	indexDiaries(): Promise<void>;
	watchDiaries(): void;
	subscribeRuntime(runtime: ConversationRuntime, sessionId?: string): () => void;
	transformContext(
		messages: AgentMessage[],
		signal?: AbortSignal,
		options?: MemoryTransformOptions,
	): Promise<AgentMessage[]>;
	serviceCompactionDebt(sessionKey: string): Promise<void>;
	flush(): Promise<void>;
	close(): void;
}

export interface MemoryOperatorService extends MemoryService {
	readonly lcmStore: LcmStore;
	readonly memoryStore: MemoryIndexStore;
	readonly indexer: ChunkIndexer;
	stats(): { projectionFailures: number };
}

export interface MemoryTransformOptions {
	sessionKey?: string;
	sessionId?: string;
	model?: Model<any>;
	skipAmbient?: boolean;
	ambientQuery?: string;
}

export interface MemoryServiceOptions {
	summarizer?: LcmSummarizer;
	now?: () => number;
	diaryWatchDebounceMs?: number;
}

export function createMemoryService(config: Config, options: MemoryServiceOptions = {}): MemoryService {
	return new DefaultMemoryService(config, options);
}

export const MemoryService = {
	createWithoutRuntime(config: Config, options: MemoryServiceOptions = {}): MemoryOperatorService {
		return new DefaultMemoryService(config, options);
	},
};

class DefaultMemoryService implements MemoryOperatorService {
	readonly lcmStore: LcmStore;
	readonly memoryStore: MemoryIndexStore;
	private readonly embeddingProvider;
	readonly indexer: ChunkIndexer;
	private readonly segmentManager: LcmSegmentManager;
	private readonly contextTransformer: LcmContextTransformer;
	private readonly ambientInjector: AmbientDiaryInjector;
	private readonly diaryWatchDebounceMs: number;
	private diaryWatcher?: FSWatcher;
	private diaryWatchTimers = new Map<string, NodeJS.Timeout>();

	constructor(
		private readonly config: Config,
		options: MemoryServiceOptions = {},
	) {
		this.lcmStore = LcmStore.open(config);
		this.memoryStore = MemoryIndexStore.open(config);
		this.reconcileSharedIndex();
		this.embeddingProvider = createEmbeddingProvider(config);
		this.indexer = new ChunkIndexer({ store: this.memoryStore, embeddingProvider: this.embeddingProvider });
		this.segmentManager = new LcmSegmentManager({
			lcmStore: this.lcmStore,
			memoryStore: this.memoryStore,
			indexer: this.indexer,
			newSessionRetainDepth: config.memory.lcm.newSessionRetainDepth,
			onRotate: (sessionKey) => this.contextTransformer.invalidateSession(sessionKey),
		});
		this.contextTransformer = new LcmContextTransformer({
			settings: config.memory.lcm,
			lcmStore: this.lcmStore,
			indexer: this.indexer,
			summarizer: options.summarizer ?? new DefaultLcmSummarizer(config),
			segmentManager: this.segmentManager,
			now: options.now,
		});
		this.ambientInjector = new AmbientDiaryInjector({
			store: this.memoryStore,
			embeddingProvider: this.embeddingProvider,
			settings: config.memory.ambient,
		});
		this.diaryWatchDebounceMs = options.diaryWatchDebounceMs ?? 3000;
	}

	async indexDiaries(): Promise<void> {
		await indexAllDiaryFiles({ config: this.config, indexer: this.indexer, store: this.memoryStore });
	}

	watchDiaries(): void {
		if (this.diaryWatcher) return;
		try {
			this.diaryWatcher = watch(this.config.memory.diariesDir, { persistent: true }, (_eventType, filename) => {
				if (!filename) return;
				this.scheduleDiaryIndex(String(filename));
			});
			this.scheduleDiaryCatchUpIndex();
		} catch (error) {
			if (isEnoent(error)) {
				console.info(`diary watcher found no diary directory at ${this.config.memory.diariesDir}; disabled`);
				return;
			}
			throw error;
		}
		this.diaryWatcher.on("error", (error) => {
			console.error("diary watcher failed", error);
			this.diaryWatcher?.close();
			this.diaryWatcher = undefined;
		});
	}

	memoryTools(): AgentTool<any>[] {
		return createMemoryTools({ store: this.memoryStore, embeddingProvider: this.embeddingProvider });
	}

	subscribeRuntime(runtime: ConversationRuntime, sessionId?: string): () => void {
		return this.segmentManager.subscribeRuntime(runtime, sessionId);
	}

	async transformContext(
		messages: AgentMessage[],
		signal?: AbortSignal,
		options: MemoryTransformOptions = {},
	): Promise<AgentMessage[]> {
		const compacted = await this.contextTransformer.transformLcmContext(messages, signal, options);
		if (options.skipAmbient) return compacted;
		return this.ambientInjector.inject(
			compacted,
			signal,
			options.sessionKey ?? options.sessionId ?? "default",
			options.ambientQuery,
		);
	}

	async serviceCompactionDebt(sessionKey: string): Promise<void> {
		await this.contextTransformer.serviceCompactionDebt(sessionKey);
	}

	close(): void {
		this.diaryWatcher?.close();
		this.diaryWatcher = undefined;
		for (const timer of this.diaryWatchTimers.values()) clearTimeout(timer);
		this.diaryWatchTimers.clear();
		this.memoryStore.close();
		this.lcmStore.close();
	}

	async flush(): Promise<void> {
		await this.segmentManager.flush();
	}

	stats(): { projectionFailures: number } {
		return { projectionFailures: this.segmentManager.stats().projectionFailures };
	}

	private reconcileSharedIndex(): void {
		this.memoryStore.reconcileSources((source) => {
			if (source.corpus === "lcm_record") {
				const id = parseIndexSourceId(source.sourceId, "lcm_record");
				return id !== null && this.lcmStore.getRecord(id) !== null;
			}
			if (source.corpus === "lcm_summary") {
				const id = parseIndexSourceId(source.sourceId, "lcm_summary");
				return id !== null && this.lcmStore.getSummary(id) !== null;
			}
			return true;
		});
	}

	private scheduleDiaryIndex(filename: string): void {
		const sourceId = basename(filename);
		if (!DIARY_INDEX_FILE_RE.test(sourceId)) return;
		const existing = this.diaryWatchTimers.get(sourceId);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.diaryWatchTimers.delete(sourceId);
			void this.indexDiarySource(sourceId);
		}, this.diaryWatchDebounceMs);
		this.diaryWatchTimers.set(sourceId, timer);
	}

	private scheduleDiaryCatchUpIndex(): void {
		const timerKey = "__all__";
		const existing = this.diaryWatchTimers.get(timerKey);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.diaryWatchTimers.delete(timerKey);
			void this.indexDiaries().catch((error) => console.error("diary watcher catch-up indexing failed", error));
		}, this.diaryWatchDebounceMs);
		this.diaryWatchTimers.set(timerKey, timer);
	}

	private async indexDiarySource(sourceId: string): Promise<void> {
		const path = resolve(this.config.memory.diariesDir, sourceId);
		try {
			const result = await indexDiaryFile({
				config: this.config,
				indexer: this.indexer,
				store: this.memoryStore,
				path,
			});
			if ("skipped" in result) return;
			if (process.env.DEBUG === "memory-index") {
				console.error(
					JSON.stringify({
						event: "diary_index_file",
						sourceId,
						chunks: result.result.ids.length,
						embedded: result.result.embedded,
						reused: result.result.reused,
					}),
				);
			}
		} catch (error) {
			if (isEnoent(error)) {
				await removeDiaryFileIndex({ config: this.config, indexer: this.indexer, path });
				return;
			}
			console.error(`diary index failed: ${path}`, error);
		}
	}
}

function parseIndexSourceId(value: string | null, prefix: "lcm_record" | "lcm_summary"): number | null {
	if (!value?.startsWith(`${prefix}:`)) return null;
	const id = Number(value.slice(prefix.length + 1));
	return Number.isInteger(id) && id > 0 ? id : null;
}

export const __memoryServiceTest = __ambientDiaryInjectorTest;
