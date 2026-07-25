import type { MemoryIndexStore } from "./index/store.js";
import type { LcmStore } from "./lcm/store.js";
import { runInTransaction } from "./util.js";

export interface DoctorFinding {
	kind: string;
	detail: string;
	fixable: boolean;
}

export interface DoctorReport {
	findings: DoctorFinding[];
	clean: boolean;
}

export type MemoryStore = MemoryIndexStore;

export interface DoctorStores {
	lcm: LcmStore;
	index: MemoryStore;
}

interface StaleActiveSegment {
	id: string;
	channelKey: string | null;
	closedAt: string;
	records: number;
	reason: "backfill" | "superseded";
}

export function runDoctor(stores: DoctorStores, opts: Record<string, never> = {}): DoctorReport {
	void opts;
	const findings: DoctorFinding[] = [];
	findDanglingIndexSources(stores, findings);
	findStaleActiveSegments(stores, findings);
	findOrphanEmptySegments(stores, findings);
	findStaleLcmIndexRows(stores, findings);
	findBrokenContextOrdering(stores, findings);
	findSummaryFkViolations(stores, findings);
	findMissingPrunedSnapshots(stores, findings);
	findRequiresReindex(stores, findings);
	findEmbeddingMismatches(stores, findings);
	return { findings, clean: findings.length === 0 };
}

export function applyDoctorFixes(stores: DoctorStores, report: DoctorReport): { fixed: number; summary: string } {
	let fixed = 0;
	const warnings: string[] = [];

	const runIndexFixes = () => {
		fixed += stores.index.db
			.prepare(
				`DELETE FROM memory_index_sources
				 WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)`,
			)
			.run().changes;

		const staleSources = stores.index.db
			.prepare(
				`SELECT corpus, source_id
				 FROM memory_index_sources
				 WHERE corpus IN ('lcm_record', 'lcm_summary')`,
			)
			.all() as Array<{ corpus: string; source_id: string }>;
		for (const source of staleSources) {
			if (lcmSourceExists(stores, source.corpus, source.source_id)) continue;
			const before = countIndexSourceRows(stores.index, source.corpus, source.source_id);
			stores.index.deleteBySourceUnsafe(source.corpus, source.source_id);
			fixed += before;
		}
	};
	runInTransaction(stores.index.db, runIndexFixes);

	const runLcmFixes = () => {
		for (const segment of staleActiveSegments(stores.lcm)) {
			stores.lcm.closeSegment(segment.id, segment.closedAt);
			fixed += 1;
		}
		fixed += stores.lcm.db
			.prepare(
				`DELETE FROM lcm_segments
				 WHERE status != 'active'
				   AND id NOT IN (SELECT DISTINCT segment_id FROM lcm_records)
				   AND id NOT IN (SELECT DISTINCT segment_id FROM lcm_summaries)`,
			)
			.run().changes;

		const sessions = stores.lcm.db
			.prepare("SELECT DISTINCT session_key FROM lcm_context_items ORDER BY session_key")
			.all() as { session_key: string }[];
		for (const session of sessions) {
			const rows = stores.lcm.db
				.prepare(
					`SELECT rowid AS rowid, ordinal
					 FROM lcm_context_items
					 WHERE session_key = ?
					 ORDER BY ordinal, rowid`,
				)
				.all(session.session_key) as Array<{ rowid: number; ordinal: number }>;
			for (const [index, row] of rows.entries()) {
				if (row.ordinal === index) continue;
				stores.lcm.db
					.prepare("UPDATE lcm_context_items SET ordinal = ?, updated_at = unixepoch() WHERE rowid = ?")
					.run(index, row.rowid);
				fixed += 1;
			}
		}
	};
	runInTransaction(stores.lcm.db, runLcmFixes);

	if (report.findings.some((finding) => finding.kind === "summary_fk_violation")) {
		warnings.push("summary FK violations were not modified; inspect LCM summary lineage manually");
	}
	if (report.findings.some((finding) => finding.kind === "missing_pruned_summary_snapshot")) {
		warnings.push("missing pruned summary snapshots were not modified; inspect retained summaries manually");
	}
	if (report.findings.some((finding) => finding.kind === "embedding_mismatch")) {
		warnings.push("embedding mismatches were not rebuilt; run 'familiar memory reindex'");
	}
	if (report.findings.some((finding) => finding.kind === "requires_reindex")) {
		warnings.push("reindex requirement was not cleared; run 'familiar memory reindex --force'");
	}
	if (report.findings.some((finding) => finding.kind === "stale_active_segment")) {
		warnings.push(
			"stale active segments were closed; run 'familiar memory prune --new-session-retain-depth 0 --yes' to delete their raw records",
		);
	}

	const summary = [`fixed ${fixed} item(s)`, ...warnings].join("; ");
	return { fixed, summary };
}

function findStaleActiveSegments(stores: DoctorStores, findings: DoctorFinding[]): void {
	for (const segment of staleActiveSegments(stores.lcm)) {
		findings.push({
			kind: "stale_active_segment",
			detail:
				segment.reason === "backfill"
					? `historical backfill segment ${segment.id} is still active (${segment.records} raw record(s))`
					: `segment ${segment.id} was superseded by a newer active segment for ${segment.channelKey} (${segment.records} raw record(s))`,
			fixable: true,
		});
	}
}

function staleActiveSegments(store: LcmStore): StaleActiveSegment[] {
	return store.db
		.prepare(
			`SELECT s.id,
			        s.channel_key AS channelKey,
			        COALESCE(MAX(r.happened_at), s.started_at) AS closedAt,
			        COUNT(r.id) AS records,
			        CASE WHEN s.id LIKE 'backfill-%' THEN 'backfill' ELSE 'superseded' END AS reason
			 FROM lcm_segments s
			 LEFT JOIN lcm_records r ON r.segment_id = s.id
			 WHERE s.status = 'active'
			   AND (
			     s.id LIKE 'backfill-%'
			     OR (
			       s.channel_key IS NOT NULL
			       AND EXISTS (
			         SELECT 1
			         FROM lcm_segments newer
			         WHERE newer.status = 'active'
			           AND newer.id NOT LIKE 'backfill-%'
			           AND newer.channel_key = s.channel_key
			           AND (
			             newer.started_at > s.started_at
			             OR (newer.started_at = s.started_at AND newer.id > s.id)
			           )
			       )
			     )
			   )
			 GROUP BY s.id
			 ORDER BY s.started_at, s.id`,
		)
		.all() as StaleActiveSegment[];
}

function findDanglingIndexSources(stores: DoctorStores, findings: DoctorFinding[]): void {
	const rows = stores.index.db
		.prepare(
			`SELECT chunk_id, corpus, source_id, chunk_index
			 FROM memory_index_sources
			 WHERE chunk_id NOT IN (SELECT id FROM memory_chunks)
			 ORDER BY corpus, source_id, chunk_index`,
		)
		.all() as Array<{ chunk_id: number; corpus: string; source_id: string; chunk_index: number }>;
	for (const row of rows) {
		findings.push({
			kind: "dangling_index_source",
			detail: `${row.corpus}:${row.source_id}#${row.chunk_index} references missing chunk ${row.chunk_id}`,
			fixable: true,
		});
	}
}

function findOrphanEmptySegments(stores: DoctorStores, findings: DoctorFinding[]): void {
	const rows = stores.lcm.db
		.prepare(
			`SELECT id
			 FROM lcm_segments
			 WHERE status != 'active'
			   AND id NOT IN (SELECT DISTINCT segment_id FROM lcm_records)
			   AND id NOT IN (SELECT DISTINCT segment_id FROM lcm_summaries)
			 ORDER BY started_at, id`,
		)
		.all() as { id: string }[];
	for (const row of rows) {
		findings.push({
			kind: "orphan_empty_segment",
			detail: `closed segment ${row.id} has no records`,
			fixable: true,
		});
	}
}

function findStaleLcmIndexRows(stores: DoctorStores, findings: DoctorFinding[]): void {
	const rows = stores.index.db
		.prepare(
			`SELECT corpus, source_id, chunk_index
			 FROM memory_index_sources
			 WHERE corpus IN ('lcm_record', 'lcm_summary')
			 ORDER BY corpus, source_id, chunk_index`,
		)
		.all() as Array<{ corpus: string; source_id: string; chunk_index: number }>;
	for (const row of rows) {
		if (lcmSourceExists(stores, row.corpus, row.source_id)) continue;
		findings.push({
			kind: "stale_lcm_index_source",
			detail: `${row.corpus}:${row.source_id}#${row.chunk_index} points at missing LCM source`,
			fixable: true,
		});
	}
}

function findBrokenContextOrdering(stores: DoctorStores, findings: DoctorFinding[]): void {
	const sessions = stores.lcm.db
		.prepare("SELECT DISTINCT session_key FROM lcm_context_items ORDER BY session_key")
		.all() as { session_key: string }[];
	for (const session of sessions) {
		const rows = stores.lcm.db
			.prepare(
				`SELECT ordinal
				 FROM lcm_context_items
				 WHERE session_key = ?
				 ORDER BY ordinal`,
			)
			.all(session.session_key) as { ordinal: number }[];
		const ordinals = rows.map((row) => row.ordinal);
		if (ordinals.every((ordinal, index) => ordinal === index) && new Set(ordinals).size === ordinals.length) continue;
		findings.push({
			kind: "broken_context_ordering",
			detail: `session ${session.session_key} ordinals are ${ordinals.join(",")}`,
			fixable: true,
		});
	}
}

function findSummaryFkViolations(stores: DoctorStores, findings: DoctorFinding[]): void {
	const sourceRows = stores.lcm.db
		.prepare(
			`SELECT summary_id, ord, record_id
			 FROM lcm_summary_sources
			 WHERE record_id IS NOT NULL
			   AND record_id NOT IN (SELECT id FROM lcm_records)
			 ORDER BY summary_id, ord`,
		)
		.all() as Array<{ summary_id: number; ord: number; record_id: number }>;
	for (const row of sourceRows) {
		findings.push({
			kind: "summary_fk_violation",
			detail: `summary ${row.summary_id} source ${row.ord} references missing record ${row.record_id}`,
			fixable: false,
		});
	}

	const parentRows = stores.lcm.db
		.prepare(
			`SELECT summary_id, parent_summary_id
			 FROM lcm_summary_parents
			 WHERE parent_summary_id NOT IN (SELECT id FROM lcm_summaries)
			 ORDER BY summary_id, parent_summary_id`,
		)
		.all() as Array<{ summary_id: number; parent_summary_id: number }>;
	for (const row of parentRows) {
		findings.push({
			kind: "summary_fk_violation",
			detail: `summary ${row.summary_id} references missing parent summary ${row.parent_summary_id}`,
			fixable: false,
		});
	}
}

function findMissingPrunedSnapshots(stores: DoctorStores, findings: DoctorFinding[]): void {
	const rows = stores.lcm.db
		.prepare(
			`SELECT id
			 FROM lcm_summaries
			 WHERE covers_from_record_id IS NULL
			   AND snapshot_json IS NULL
			 ORDER BY id`,
		)
		.all() as { id: number }[];
	for (const row of rows) {
		findings.push({
			kind: "missing_pruned_summary_snapshot",
			detail: `summary ${row.id} has pruned raw coverage without snapshot_json`,
			fixable: false,
		});
	}
}

function findRequiresReindex(stores: DoctorStores, findings: DoctorFinding[]): void {
	const row = stores.index.db.prepare("SELECT v FROM memory_meta WHERE k = 'requires_reindex'").get() as
		| { v: string }
		| undefined;
	if (row?.v !== "1") return;
	findings.push({
		kind: "requires_reindex",
		detail: "memory index was cleared after embedding config changed; run 'familiar memory reindex --force'",
		fixable: false,
	});
}

function findEmbeddingMismatches(stores: DoctorStores, findings: DoctorFinding[]): void {
	const current = stores.index.embeddingConfig();
	const rows = stores.index.db
		.prepare(
			`SELECT id, corpus, embedding_model, embedding_dimensions
			 FROM memory_chunks
			 WHERE embedding_model != ? OR embedding_dimensions != ?
			 ORDER BY id`,
		)
		.all(current.model, current.dimensions) as Array<{
		id: number;
		corpus: string;
		embedding_model: string;
		embedding_dimensions: number;
	}>;
	for (const row of rows) {
		findings.push({
			kind: "embedding_mismatch",
			detail:
				`chunk ${row.id} (${row.corpus}) has ${row.embedding_model}/${row.embedding_dimensions}; ` +
				`current is ${current.model}/${current.dimensions}`,
			fixable: false,
		});
	}
}

function lcmSourceExists(stores: DoctorStores, corpus: string, sourceId: string): boolean {
	if (corpus === "lcm_record") {
		const id = parseIndexSourceId(sourceId, "lcm_record");
		return id !== null && stores.lcm.getRecord(id) !== null;
	}
	if (corpus === "lcm_summary") {
		const id = parseIndexSourceId(sourceId, "lcm_summary");
		return id !== null && stores.lcm.getSummary(id) !== null;
	}
	return true;
}

function countIndexSourceRows(store: MemoryStore, corpus: string, sourceId: string): number {
	const row = store.db
		.prepare("SELECT COUNT(*) AS n FROM memory_index_sources WHERE corpus = ? AND source_id = ?")
		.get(corpus, sourceId) as { n: number };
	return row.n;
}

function parseIndexSourceId(value: string | null, prefix: "lcm_record" | "lcm_summary"): number | null {
	const expectedPrefix = `${prefix}:`;
	if (!value?.startsWith(expectedPrefix)) return null;
	const id = Number(value.slice(expectedPrefix.length));
	return Number.isInteger(id) && id > 0 ? id : null;
}
