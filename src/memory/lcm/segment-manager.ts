import type { ChatLogRecord } from "../../conversation/chat-log.js";
import type { ConversationRuntime } from "../../runtime/conversation-runtime.js";
import type { ChunkIndexer } from "../index/chunk-indexer.js";
import type { MemoryIndexStore } from "../index/store.js";
import { indexLcmRecords } from "./indexer.js";
import { chatBoundaryRecord } from "./normalize.js";
import type { LcmStore } from "./store.js";

export interface LcmSegmentManagerOptions {
	lcmStore: LcmStore;
	memoryStore: MemoryIndexStore;
	indexer: ChunkIndexer;
	newSessionRetainDepth: () => number;
	onRotate?: (sessionKey: string) => void;
}

export class LcmSegmentManager {
	private readonly lcmStore: LcmStore;
	private readonly memoryStore: MemoryIndexStore;
	private readonly indexer: ChunkIndexer;
	private readonly newSessionRetainDepth: () => number;
	private readonly onRotate?: (sessionKey: string) => void;
	private readonly activeSegments = new Map<string, string>();
	private readonly segmentCounters = new Map<string, number>();
	private projectionQueue = Promise.resolve();
	private projectionFailures = 0;

	constructor(options: LcmSegmentManagerOptions) {
		this.lcmStore = options.lcmStore;
		this.memoryStore = options.memoryStore;
		this.indexer = options.indexer;
		this.newSessionRetainDepth = options.newSessionRetainDepth;
		this.onRotate = options.onRotate;
	}

	subscribeRuntime(runtime: ConversationRuntime, sessionId?: string): () => void {
		const unsubscribe = runtime.subscribe((record) => {
			const projection = this.projectionQueue.then(() => this.projectRuntimeRecord(runtime, record, sessionId));
			// Keep the queue usable after an error, but return the rejecting reset
			// projection so the runtime cannot acknowledge failed retention.
			this.projectionQueue = projection.catch((error) => {
				this.projectionFailures += 1;
				console.error(`memory projection failed for ${runtime.channelKey} record ${record.recordId}`, error);
			});
			if (record.type === "runtime" && record.event === "reset") return projection;
		});
		return unsubscribe;
	}

	/** Queue projection work so a later reset waits for it before applying retention. */
	enqueue(channelKey: string, task: () => Promise<unknown>): void {
		this.projectionQueue = this.projectionQueue.then(task).then(
			() => undefined,
			(error) => {
				this.projectionFailures += 1;
				console.error(`memory projection failed for ${channelKey}`, error);
			},
		);
	}

	async flush(): Promise<void> {
		await this.projectionQueue.catch(() => undefined);
	}

	stats(): { projectionFailures: number } {
		return { projectionFailures: this.projectionFailures };
	}

	activeSegmentId(channelKey: string): string {
		const existing = this.activeSegments.get(channelKey);
		if (existing) return existing;
		const persisted = this.findPersistedActiveSegmentId(channelKey);
		if (persisted) {
			this.activeSegments.set(channelKey, persisted);
			this.seedSegmentCounter(channelKey);
			return persisted;
		}
		this.seedSegmentCounter(channelKey);
		const next = this.nextSegmentId(channelKey);
		this.activeSegments.set(channelKey, next);
		return next;
	}

	private async projectRuntimeRecord(
		runtime: ConversationRuntime,
		record: ChatLogRecord,
		sessionId: string | undefined,
	): Promise<void> {
		if (record.type === "runtime" && record.event === "reset") {
			this.rotateRuntimeSegment(runtime, record);
			return;
		}
		// conversation turns reach LCM through the context transformer, whose record ids summaries cover
		const boundary = chatBoundaryRecord(record, {
			segmentId: this.activeSegmentId(runtime.channelKey),
			sessionId: sessionId ?? null,
			channelKey: runtime.channelKey,
		});
		if (!boundary) return;
		const stored = this.lcmStore.insertRecordReturningStored(boundary).record;
		await indexLcmRecords({ indexer: this.indexer, records: [stored] });
	}

	private rotateRuntimeSegment(
		runtime: ConversationRuntime,
		record: Extract<ChatLogRecord, { type: "runtime" }>,
	): void {
		const previousSegmentId = this.activeSegmentId(runtime.channelKey);
		const nextSegmentId = this.nextSegmentId(runtime.channelKey);
		let indexDeletes: Array<{ corpus: "lcm_record" | "lcm_summary"; sourceId: string }> = [];
		// LCM rotation commits as one source-of-truth transaction. Shared-index deletes are
		// applied after commit; startup reconciliation repairs crashes between the two DBs.
		this.lcmStore.db
			.transaction(() => {
				const boundary = chatBoundaryRecord(record, {
					segmentId: previousSegmentId,
					channelKey: runtime.channelKey,
				});
				if (boundary) this.lcmStore.insertRecord(boundary);
				this.lcmStore.closeSegment(previousSegmentId, record.ts);
				this.lcmStore.ensureSegment({
					id: nextSegmentId,
					channelKey: runtime.channelKey,
					startedAt: record.ts,
					boundarySource: {
						sourceType: "chat",
						sourceRecordId: record.recordId,
						sourceRef: `chat:${record.recordId}`,
					},
				});
				this.lcmStore.clearContextItems(runtime.channelKey);
				this.lcmStore.clearSessionState(runtime.channelKey);
				const retention = this.lcmStore.applyNewSessionRetention({
					newSessionRetainDepth: this.newSessionRetainDepth(),
					activeSegmentId: nextSegmentId,
				});
				indexDeletes = retention.indexDeletes;
			})
			.immediate();
		this.activeSegments.set(runtime.channelKey, nextSegmentId);
		this.onRotate?.(runtime.channelKey);
		this.memoryStore.db
			.transaction((deletes: typeof indexDeletes) => {
				for (const deleted of deletes) this.memoryStore.deleteBySourceUnsafe(deleted.corpus, deleted.sourceId);
			})
			.immediate(indexDeletes);
		console.info("memory reset completed", {
			channelKey: runtime.channelKey,
			previousSegmentId,
			nextSegmentId,
			deleted: indexDeletes.length,
		});
	}

	private nextSegmentId(channelKey: string): string {
		const next = (this.segmentCounters.get(channelKey) ?? 0) + 1;
		this.segmentCounters.set(channelKey, next);
		return `${channelKey}:seg-${next}`;
	}

	private findPersistedActiveSegmentId(channelKey: string): string | null {
		const segments = this.lcmStore
			.listSegments()
			.filter((segment) => segment.channelKey === channelKey && segment.status === "active")
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
		return segments[0]?.id ?? null;
	}

	private seedSegmentCounter(channelKey: string): void {
		const existing = this.segmentCounters.get(channelKey) ?? 0;
		let max = existing;
		for (const segment of this.lcmStore.listSegments()) {
			if (segment.channelKey !== channelKey) continue;
			const match = segment.id.match(/:seg-(\d+)$/);
			if (!match) continue;
			max = Math.max(max, Number(match[1]));
		}
		this.segmentCounters.set(channelKey, max);
	}
}
