import type { MemoryIndexStore } from "./index/store.js";
import type { LcmStore } from "./lcm/store.js";

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

export function runDoctor(stores: DoctorStores, opts: Record<string, never> = {}): DoctorReport {
	void opts;
	const findings: DoctorFinding[] = [];
	findDanglingIndexSources(stores, findings);
	findOrphanEmptySegments(stores, findings);
	findStaleLcmIndexRows(stores, findings);
	findBrokenContextOrdering(stores, findings);
	findSummaryFkViolations(stores, findings);
	findMissingPrunedSnapshots(stores, findings);
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
	if (stores.index.db.inTransaction) runIndexFixes();
	else stores.index.db.transaction(runIndexFixes).immediate();

	const runLcmFixes = () => {
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
	if (stores.lcm.db.inTransaction) runLcmFixes();
	else stores.lcm.db.transaction(runLcmFixes).immediate();

	if (report.findings.some((finding) => finding.kind === "summary_fk_violation")) {
		warnings.push("summary FK violations were not modified; inspect LCM summary lineage manually");
	}
	if (report.findings.some((finding) => finding.kind === "missing_pruned_summary_snapshot")) {
		warnings.push("missing pruned summary snapshots were not modified; inspect retained summaries manually");
	}
	if (report.findings.some((finding) => finding.kind === "embedding_mismatch")) {
		warnings.push("embedding mismatches were not rebuilt; run 'familiar memory reindex'");
	}

	const summary = [`fixed ${fixed} item(s)`, ...warnings].join("; ");
	return { fixed, summary };
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
