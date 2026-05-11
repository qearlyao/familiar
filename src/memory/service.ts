import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { Config } from "../config.js";
import type { ConversationRuntime } from "../runtime.js";
import { __ambientDiaryInjectorTest, AmbientDiaryInjector } from "./diary/ambient-injector.js";
import { indexAllDiaryFiles } from "./diary/indexer.js";
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
}

export interface MemoryServiceOptions {
	summarizer?: LcmSummarizer;
	now?: () => number;
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
			topK: config.memory.ambient.topK,
			minQueryLength: config.memory.ambient.minQueryLength,
			throttleSeconds: config.memory.ambient.throttleSeconds,
			weightSimilarity: config.memory.ambient.weightSimilarity,
			weightValence: config.memory.ambient.weightValence,
			weightRecency: config.memory.ambient.weightRecency,
			weightIntensity: config.memory.ambient.weightIntensity,
		});
	}

	async indexDiaries(): Promise<void> {
		await indexAllDiaryFiles({ config: this.config, indexer: this.indexer });
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
		return this.ambientInjector.inject(compacted, signal, options.sessionKey ?? options.sessionId ?? "default");
	}

	async serviceCompactionDebt(sessionKey: string): Promise<void> {
		await this.contextTransformer.serviceCompactionDebt(sessionKey);
	}

	close(): void {
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
}

function parseIndexSourceId(value: string | null, prefix: "lcm_record" | "lcm_summary"): number | null {
	if (!value?.startsWith(`${prefix}:`)) return null;
	const id = Number(value.slice(prefix.length + 1));
	return Number.isInteger(id) && id > 0 ? id : null;
}

export const __memoryServiceTest = __ambientDiaryInjectorTest;
