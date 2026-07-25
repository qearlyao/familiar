import { existsSync, statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";
import type { Config as FamiliarConfig } from "../config/index.js";
import { indexAllDiaryFiles } from "./diary/indexer.js";
import { applyDoctorFixes, type DoctorFinding, runDoctor } from "./doctor.js";
import { ChunkIndexer } from "./index/chunk-indexer.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./index/embedding-provider.js";
import { readMeta, writeMeta } from "./index/schema.js";
import type { MemoryIndexStore } from "./index/store.js";
import { type BackfillReport, backfillFromChatLogs } from "./lcm/backfill.js";
import { indexLcmRecords, indexLcmSummaries } from "./lcm/indexer.js";
import { type LcmStore, lcmRecordIndexSourceId, lcmSummaryIndexSourceId } from "./lcm/store.js";
import { type MemoryOperatorService, MemoryService } from "./service.js";
import { runInTransaction } from "./util.js";

const REINDEX_RUN_KEY = "reindex_in_progress";

interface ReindexRun {
	version: 1;
	corpora: string[];
	force: boolean;
	embeddingFormat: string;
	embeddingProvider: string;
	embeddingModel: string;
	embeddingBaseUrl: string;
	embeddingDimensions: number;
	ownerPid: number | null;
}

export async function runMemoryOperator(config: FamiliarConfig, argv: string[]): Promise<void> {
	const [command, ...args] = argv;
	if (!command || command === "--help" || command === "help") {
		console.log(memoryHelp());
		return;
	}

	switch (command) {
		case "status":
			await withOperatorService(config, async (service) => printStatus(config, service, args));
			return;
		case "doctor":
			await withOperatorService(config, async (service) => runDoctorCommand(service, args));
			return;
		case "reindex":
			await withOperatorService(config, async (service) => {
				const { controller, dispose } = installMemoryAbortHandler("aborting reindex — finishing current corpus…");
				try {
					await reindex(config, service, parseReindexArgs(args), undefined, controller.signal);
				} finally {
					dispose();
				}
			});
			return;
		case "backfill":
			await withOperatorService(config, async (service) =>
				backfill(config, service, parseBackfillArgs(config, args)),
			);
			return;
		case "prune":
			await withOperatorService(config, async (service) => prune(service, await parsePruneArgs(args)));
			return;
		case "backup":
			await withOperatorService(config, async (service) => backup(config, service, parseBackupArgs(args)));
			return;
		default:
			throw new Error(`Unknown memory subcommand: ${command}\n${memoryHelp()}`);
	}
}

export function memoryHelp(): string {
	return [
		"Usage:",
		"  familiar memory [workspace] status [--json]",
		"  familiar memory [workspace] doctor [--clean]",
		"  familiar memory [workspace] reindex [--corpus <name>] [--force] [--restart]",
		"  familiar memory [workspace] backfill [--channels <ch1,ch2>] [--data-dir <path>] [--dry-run]",
		"  familiar memory [workspace] prune --new-session-retain-depth <N> [--yes] [--vacuum]",
		"  familiar memory [workspace] backup <out-dir>",
	].join("\n");
}

async function withOperatorService<T>(
	config: FamiliarConfig,
	fn: (service: MemoryOperatorService) => Promise<T> | T,
): Promise<T> {
	const service = MemoryService.createWithoutRuntime(config);
	try {
		return await fn(service);
	} finally {
		service.close();
	}
}

function printStatus(config: FamiliarConfig, service: MemoryOperatorService, args: string[]): void {
	const json = hasOnlyFlags(args, ["--json"]) && args.includes("--json");
	const status = collectStatus(config, service);
	if (json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	printPlainStatus(status);
}

function collectStatus(config: FamiliarConfig, service: MemoryOperatorService): MemoryStatus {
	const lcmPath = resolve(config.memory.lcmDir, "lcm.sqlite");
	const indexPath = resolve(config.memory.indexDir, "memory.sqlite");
	const indexStats = service.memoryStore.stats();
	return {
		paths: {
			lcm: { path: lcmPath, sizeBytes: fileSize(lcmPath) },
			index: { path: indexPath, sizeBytes: fileSize(indexPath) },
		},
		counts: {
			lcmRecords: countRows(service.lcmStore, "lcm_records"),
			lcmSummariesByDepth: countGrouped(
				service.lcmStore,
				"SELECT depth AS key, COUNT(*) AS n FROM lcm_summaries GROUP BY depth",
			),
			lcmSegments: {
				active: countWhere(service.lcmStore, "lcm_segments", "status = 'active'"),
				closed: countWhere(service.lcmStore, "lcm_segments", "status = 'closed'"),
			},
			lcmContextItems: countRows(service.lcmStore, "lcm_context_items"),
			lcmSessionState: countRows(service.lcmStore, "lcm_session_state"),
			memoryChunksByCorpus: countGrouped(
				service.memoryStore,
				"SELECT corpus AS key, COUNT(*) AS n FROM memory_chunks GROUP BY corpus",
			),
			memoryIndexSources: countRows(service.memoryStore, "memory_index_sources"),
			memoryFtsRows: indexStats.ftsRows,
			memoryVectorRows: indexStats.vectorRows,
		},
		embedding: service.memoryStore.embeddingConfig(),
		vector: {
			capability: indexStats.vectorCapability,
			available: indexStats.vectorAvailable,
		},
		projectionFailures: service.stats().projectionFailures,
		requiresReindex: indexStats.requiresReindex,
		schemaVersions: {
			lcm: service.lcmStore.schemaVersion(),
			index: readMemoryMeta(service.memoryStore, "schema_version"),
		},
	};
}

function runDoctorCommand(service: MemoryOperatorService, args: string[]): void {
	const clean = hasOnlyFlags(args, ["--clean"]) && args.includes("--clean");
	const report = runDoctor({ lcm: service.lcmStore, index: service.memoryStore });
	const projectionFailures = service.stats().projectionFailures;
	if (projectionFailures > 0) {
		report.findings.push({
			kind: "projection_failures",
			detail: `${projectionFailures} memory projection failure(s) swallowed in this process`,
			fixable: false,
		});
		report.clean = false;
	}
	if (report.findings.length === 0) {
		console.log("Memory doctor: clean");
	} else {
		console.log(`Memory doctor: ${report.findings.length} finding(s)`);
		for (const finding of report.findings) console.log(`- ${formatFinding(finding)}`);
	}
	if (clean) {
		const result = applyDoctorFixes({ lcm: service.lcmStore, index: service.memoryStore }, report);
		console.log(result.summary);
	}
	if (!report.clean) process.exitCode = 1;
}

async function reindex(
	config: FamiliarConfig,
	service: MemoryOperatorService,
	options: { corpus?: string; force: boolean; restart?: boolean },
	embeddingProvider?: EmbeddingProvider,
	signal?: AbortSignal,
): Promise<void> {
	const corpora = options.corpus ? [options.corpus] : ["lcm_record", "lcm_summary", "diary_chunk"];
	const run = reindexRun(config, corpora, options.force);
	const mode = beginReindex(service.memoryStore, run, options.restart ?? false);
	console.log(`${mode} ${formatReindexRun(run)}`);
	try {
		const indexer = options.force
			? new ChunkIndexer({
					store: service.memoryStore,
					embeddingProvider: embeddingProvider ?? createEmbeddingProvider(config),
				})
			: embeddingProvider
				? new ChunkIndexer({ store: service.memoryStore, embeddingProvider })
				: service.indexer;
		const batchSize = config.memory.embedding.batchSize;
		let chunks = 0;
		if (corpora.includes("lcm_record")) {
			const records = service.lcmStore.listRecords();
			for (let offset = 0; offset < records.length; offset += batchSize) {
				if (signal?.aborted) {
					console.log(`Reindexed ${chunks} chunk(s)`);
					return;
				}
				const result = await indexLcmRecords({
					indexer,
					records: records.slice(offset, offset + batchSize),
					signal,
				});
				chunks += result.ids.length;
				printProgress(chunks);
			}
		}
		if (corpora.includes("lcm_summary")) {
			const summaries = service.lcmStore.listSummaries();
			for (let offset = 0; offset < summaries.length; offset += batchSize) {
				if (signal?.aborted) {
					console.log(`Reindexed ${chunks} chunk(s)`);
					return;
				}
				const result = await indexLcmSummaries({
					indexer,
					summaries: summaries.slice(offset, offset + batchSize),
					signal,
				});
				chunks += result.ids.length;
				printProgress(chunks);
			}
		}
		if (corpora.includes("diary_chunk")) {
			if (signal?.aborted) {
				console.log(`Reindexed ${chunks} chunk(s)`);
				return;
			}
			const result = await indexAllDiaryFiles({ config, indexer, signal });
			for (const file of result.files) {
				if (signal?.aborted) break;
				chunks += file.result.ids.length;
				printProgress(chunks);
			}
		}
		if (signal?.aborted) {
			console.log(`Reindexed ${chunks} chunk(s)`);
			return;
		}
		finishReindex(service.memoryStore, run, options.force && !options.corpus);
		console.log(`Reindexed ${chunks} chunk(s)`);
	} finally {
		releaseReindex(service.memoryStore, run);
	}
}

async function backfill(
	config: FamiliarConfig,
	service: MemoryOperatorService,
	options: { dataDir: string; channels?: string[]; dryRun: boolean },
): Promise<void> {
	const embeddingProvider = createEmbeddingProvider(config);
	const { controller, dispose } = installMemoryAbortHandler("aborting backfill — finishing current batch…");
	try {
		const report = await backfillFromChatLogs(
			{
				lcmStore: service.lcmStore,
				memoryStore: service.memoryStore,
				indexer: service.indexer,
				embeddingProvider,
				config,
			},
			{ ...options, signal: controller.signal },
		);
		printBackfillReport(report);
		if (report.errors.length > 0) process.exitCode = 1;
	} finally {
		dispose();
	}
}

async function prune(
	service: MemoryOperatorService,
	options: { retainDepth: number; yes: boolean; vacuum: boolean },
): Promise<void> {
	if (!options.yes && !(await confirm(`Prune closed LCM raw records with retain depth ${options.retainDepth}?`))) {
		console.log("Prune cancelled");
		return;
	}
	const report = service.lcmStore.applyNewSessionRetention({
		newSessionRetainDepth: options.retainDepth,
		activeSegmentId: null,
		vacuum: options.vacuum,
	});
	for (const ref of report.indexDeletes) service.memoryStore.deleteBySource(ref.corpus, ref.sourceId);
	console.log(
		`Pruned ${report.rawRecordsDeleted} raw record(s), ${report.summariesDeleted} summary row(s), ` +
			`${report.affectedSegments.length} closed segment(s) scanned`,
	);
}

async function backup(config: FamiliarConfig, service: MemoryOperatorService, outDir: string): Promise<void> {
	await mkdir(outDir, { recursive: true });
	const lcmOut = resolve(outDir, "lcm.sqlite");
	const memoryOut = resolve(outDir, "memory.sqlite");
	await Promise.all([service.lcmStore.db.backup(lcmOut), service.memoryStore.db.backup(memoryOut)]);
	const [lcmStat, memoryStat] = await Promise.all([stat(lcmOut), stat(memoryOut)]);
	console.log(`LCM backup: ${lcmOut} (${formatBytes(lcmStat.size)})`);
	console.log(`Index backup: ${memoryOut} (${formatBytes(memoryStat.size)})`);
	void config;
}

function parseReindexArgs(args: string[]): { corpus?: string; force: boolean; restart: boolean } {
	let corpus: string | undefined;
	let force = false;
	let restart = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--restart") {
			restart = true;
			continue;
		}
		if (arg === "--corpus") {
			corpus = args[++index];
			if (!corpus) throw new Error("Missing value for --corpus");
			continue;
		}
		throw new Error(`Unknown reindex argument: ${arg}`);
	}
	return { corpus, force, restart };
}

function parseBackfillArgs(
	config: FamiliarConfig,
	args: string[],
): { dataDir: string; channels?: string[]; dryRun: boolean } {
	let dataDir = config.workspace.dataDir;
	let channels: string[] | undefined;
	let dryRun = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--data-dir") {
			const raw = args[++index];
			if (!raw) throw new Error("Missing value for --data-dir");
			dataDir = resolve(raw);
			continue;
		}
		if (arg === "--channels") {
			const raw = args[++index];
			if (!raw) throw new Error("Missing value for --channels");
			channels = raw
				.split(",")
				.map((channel) => channel.trim())
				.filter(Boolean);
			continue;
		}
		throw new Error(`Unknown backfill argument: ${arg}`);
	}
	return { dataDir, channels, dryRun };
}

async function parsePruneArgs(args: string[]): Promise<{ retainDepth: number; yes: boolean; vacuum: boolean }> {
	let retainDepth: number | undefined;
	let yes = false;
	let vacuum = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--yes") {
			yes = true;
			continue;
		}
		if (arg === "--vacuum") {
			vacuum = true;
			continue;
		}
		if (arg === "--new-session-retain-depth") {
			const raw = args[++index];
			if (!raw) throw new Error("Missing value for --new-session-retain-depth");
			retainDepth = Number(raw);
			continue;
		}
		throw new Error(`Unknown prune argument: ${arg}`);
	}
	if (retainDepth === undefined || !Number.isInteger(retainDepth) || retainDepth < -1) {
		throw new Error("prune requires --new-session-retain-depth <integer >= -1>");
	}
	return { retainDepth, yes, vacuum };
}

function parseBackupArgs(args: string[]): string {
	if (args.length !== 1) throw new Error("backup requires <out-dir>");
	return resolve(args[0] as string);
}

function hasOnlyFlags(args: string[], allowed: readonly string[]): boolean {
	for (const arg of args) {
		if (!allowed.includes(arg)) throw new Error(`Unknown argument: ${arg}`);
	}
	return true;
}

function reindexRun(config: FamiliarConfig, corpora: string[], force: boolean): ReindexRun {
	return {
		version: 1,
		corpora,
		force,
		embeddingFormat: config.memory.embedding.format,
		embeddingProvider: config.memory.embedding.provider,
		embeddingModel: config.memory.embedding.model,
		embeddingBaseUrl: config.memory.embedding.baseUrl,
		embeddingDimensions: config.memory.embedding.dimensions,
		ownerPid: null,
	};
}

function readReindexRun(store: MemoryIndexStore): ReindexRun | null {
	const raw = readMeta(store.db, REINDEX_RUN_KEY);
	if (!raw) return null;
	const parsed = JSON.parse(raw) as Partial<ReindexRun>;
	if (
		parsed.version !== 1 ||
		!Array.isArray(parsed.corpora) ||
		!parsed.corpora.every((corpus) => typeof corpus === "string") ||
		typeof parsed.force !== "boolean" ||
		typeof parsed.embeddingFormat !== "string" ||
		typeof parsed.embeddingProvider !== "string" ||
		typeof parsed.embeddingModel !== "string" ||
		typeof parsed.embeddingBaseUrl !== "string" ||
		typeof parsed.embeddingDimensions !== "number" ||
		(parsed.ownerPid !== null && (!Number.isInteger(parsed.ownerPid) || (parsed.ownerPid ?? 0) < 1))
	) {
		throw new Error(`Invalid ${REINDEX_RUN_KEY} metadata`);
	}
	return parsed as ReindexRun;
}

function sameReindexRun(left: ReindexRun, right: ReindexRun): boolean {
	return isDeepStrictEqual({ ...left, ownerPid: null }, { ...right, ownerPid: null });
}

function beginReindex(
	store: MemoryIndexStore,
	run: ReindexRun,
	restart: boolean,
): "Starting" | "Restarting" | "Resuming" {
	return runInTransaction(store.db, () => {
		const active = readReindexRun(store);
		if (active?.ownerPid && processIsRunning(active.ownerPid)) {
			throw new Error(`Reindex is already running in process ${active.ownerPid}`);
		}
		if (
			active &&
			!sameReindexRun(active, run) &&
			(!restart || active.corpora.join("\0") !== run.corpora.join("\0"))
		) {
			throw new Error(
				`A different reindex is already in progress (${formatReindexRun(active)}); ` +
					"resume it with the same arguments or restart the same corpus scope",
			);
		}
		if (!active || restart) {
			for (const corpus of run.corpora) deleteCorpus(store, corpus);
			writeMeta(store.db, REINDEX_RUN_KEY, JSON.stringify({ ...run, ownerPid: process.pid }));
			return active ? "Restarting" : "Starting";
		}
		writeMeta(store.db, REINDEX_RUN_KEY, JSON.stringify({ ...active, ownerPid: process.pid }));
		return "Resuming";
	});
}

function finishReindex(store: MemoryIndexStore, run: ReindexRun, clearRequired: boolean): void {
	runInTransaction(store.db, () => {
		const active = readReindexRun(store);
		if (!active || active.ownerPid !== process.pid || !sameReindexRun(active, run)) {
			throw new Error("Reindex ownership was lost before completion");
		}
		store.db.prepare("DELETE FROM memory_meta WHERE k = ?").run(REINDEX_RUN_KEY);
		if (clearRequired) store.db.prepare("DELETE FROM memory_meta WHERE k = 'requires_reindex'").run();
	});
}

function releaseReindex(store: MemoryIndexStore, run: ReindexRun): void {
	runInTransaction(store.db, () => {
		const active = readReindexRun(store);
		if (!active || active.ownerPid !== process.pid || !sameReindexRun(active, run)) return;
		writeMeta(store.db, REINDEX_RUN_KEY, JSON.stringify({ ...active, ownerPid: null }));
	});
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function formatReindexRun(run: ReindexRun): string {
	return `reindex (${run.corpora.join(", ")}; ${run.embeddingProvider}/${run.embeddingModel}; dim=${run.embeddingDimensions}${
		run.force ? "; force" : ""
	})`;
}

function deleteCorpus(store: MemoryIndexStore, corpus: string): void {
	const rows = store.db.prepare("SELECT source_id FROM memory_index_sources WHERE corpus = ?").all(corpus) as {
		source_id: string;
	}[];
	const sourceIds = new Set(rows.map((row) => row.source_id));
	for (const sourceId of sourceIds) store.deleteBySourceUnsafe(corpus, sourceId);
	const orphanRows = store.db.prepare("SELECT id FROM memory_chunks WHERE corpus = ?").all(corpus) as { id: number }[];
	for (const row of orphanRows) {
		store.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.id);
		store.db.prepare("DELETE FROM memory_chunks WHERE id = ?").run(row.id);
	}
}

function installMemoryAbortHandler(message: string): { controller: AbortController; dispose: () => void } {
	const controller = new AbortController();
	const onSigint = () => {
		if (!controller.signal.aborted) console.log(message);
		controller.abort();
	};
	process.once("SIGINT", onSigint);
	return {
		controller,
		dispose: () => process.off("SIGINT", onSigint),
	};
}

function countRows(store: { db: LcmStore["db"] }, table: string): number {
	const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
	return row.n;
}

function countWhere(store: { db: LcmStore["db"] }, table: string, where: string): number {
	const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number };
	return row.n;
}

function countGrouped(store: { db: LcmStore["db"] }, sql: string): Record<string, number> {
	const rows = store.db.prepare(sql).all() as Array<{ key: string | number; n: number }>;
	return Object.fromEntries(rows.map((row) => [String(row.key), row.n]));
}

function readMemoryMeta(store: MemoryIndexStore, key: string): number | null {
	const row = store.db.prepare("SELECT v FROM memory_meta WHERE k = ?").get(key) as { v: string } | undefined;
	return row ? Number(row.v) : null;
}

function fileSize(path: string): number {
	return existsSync(path) ? statSync(path).size : 0;
}

function formatFinding(finding: DoctorFinding): string {
	return `${finding.kind} ${finding.fixable ? "[fixable]" : "[manual]"}: ${finding.detail}`;
}

function printPlainStatus(status: MemoryStatus): void {
	console.log("Memory status");
	console.log(`LCM DB: ${status.paths.lcm.path} (${formatBytes(status.paths.lcm.sizeBytes)})`);
	console.log(`Index DB: ${status.paths.index.path} (${formatBytes(status.paths.index.sizeBytes)})`);
	console.log(`LCM records: ${status.counts.lcmRecords}`);
	console.log(`LCM summaries by depth: ${JSON.stringify(status.counts.lcmSummariesByDepth)}`);
	console.log(`LCM segments: active=${status.counts.lcmSegments.active} closed=${status.counts.lcmSegments.closed}`);
	console.log(`LCM context items: ${status.counts.lcmContextItems}`);
	console.log(`LCM session state: ${status.counts.lcmSessionState}`);
	console.log(`Memory chunks by corpus: ${JSON.stringify(status.counts.memoryChunksByCorpus)}`);
	console.log(`Memory index sources: ${status.counts.memoryIndexSources}`);
	console.log(`Memory FTS rows: ${status.counts.memoryFtsRows}`);
	console.log(
		`Memory vector rows: ${status.counts.memoryVectorRows} (${status.vector.available ? status.vector.capability : "blob-js fallback"})`,
	);
	console.log(`Embedding: ${status.embedding.provider}/${status.embedding.model} dim=${status.embedding.dimensions}`);
	console.log(`Projection failures: ${status.projectionFailures}`);
	if (status.requiresReindex) console.log("Reindex required: run familiar memory reindex --force");
	console.log(
		`Schema versions: lcm=${status.schemaVersions.lcm ?? "unknown"} index=${status.schemaVersions.index ?? "unknown"}`,
	);
}

function printProgress(chunks: number): void {
	if (chunks > 0 && chunks % 100 === 0) console.log(`Reindexed ${chunks} chunk(s)`);
}

function printBackfillReport(report: BackfillReport): void {
	const rows = [
		["chatFilesProcessed", report.chatFilesProcessed],
		["transcriptFilesProcessed", report.transcriptFilesProcessed],
		["recordsInserted", report.recordsInserted],
		["recordsSkippedDuplicate", report.recordsSkippedDuplicate],
		["segmentsCreated", report.segmentsCreated],
		["summariesInserted", report.summariesInserted],
		["indexedChunks", report.indexedChunks],
		["errors", report.errors.length],
	] as const;
	const width = Math.max(...rows.map(([field]) => field.length));
	console.log("Memory backfill summary");
	for (const [field, value] of rows) console.log(`${field.padEnd(width)}  ${value}`);
	for (const error of report.errors) console.log(`error  ${error}`);
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(`${question} Type yes to continue: `);
		return answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

interface MemoryStatus {
	paths: {
		lcm: { path: string; sizeBytes: number };
		index: { path: string; sizeBytes: number };
	};
	counts: {
		lcmRecords: number;
		lcmSummariesByDepth: Record<string, number>;
		lcmSegments: { active: number; closed: number };
		lcmContextItems: number;
		lcmSessionState: number;
		memoryChunksByCorpus: Record<string, number>;
		memoryIndexSources: number;
		memoryFtsRows: number;
		memoryVectorRows: number;
	};
	embedding: { provider: string; model: string; dimensions: number };
	vector: { capability: string; available: boolean };
	projectionFailures: number;
	requiresReindex: boolean;
	schemaVersions: { lcm: number | null; index: number | null };
}

export const __memoryOperatorTest = {
	collectStatus,
	reindex,
	prune,
	backup,
	backfill,
	lcmRecordIndexSourceId,
	lcmSummaryIndexSourceId,
};
