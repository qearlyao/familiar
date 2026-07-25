import type Database from "better-sqlite3";

import { flattenLcmRecordParts } from "./normalize.js";
import type { LcmRecordPart } from "./types.js";

const SCHEMA_VERSION = 10;

export function runLcmMigrations(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	const run = () => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS lcm_meta (
				k TEXT PRIMARY KEY,
				v TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS lcm_segments (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'active',
				session_id TEXT,
				channel_key TEXT,
				started_at TEXT NOT NULL,
				closed_at TEXT,
				raw_pruned_at TEXT,
				boundary_source_json TEXT,
				metadata_json TEXT,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);

			CREATE TABLE IF NOT EXISTS lcm_records (
				id INTEGER PRIMARY KEY,
				record_key TEXT NOT NULL UNIQUE,
				segment_id TEXT NOT NULL REFERENCES lcm_segments(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				text_full TEXT NOT NULL,
				parts_json TEXT,
				happened_at TEXT NOT NULL,
				session_id TEXT,
				channel_key TEXT,
				channel_id TEXT,
				job_id TEXT,
				source_type TEXT NOT NULL,
				source_path TEXT,
				source_line INTEGER,
				source_record_id TEXT,
				source_message_id TEXT,
				source_ref TEXT,
				attachments_json TEXT,
				metadata_json TEXT,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);

			CREATE INDEX IF NOT EXISTS idx_lcm_records_segment ON lcm_records(segment_id, happened_at, id);
			CREATE INDEX IF NOT EXISTS idx_lcm_records_source ON lcm_records(source_type, source_path, source_record_id);
			CREATE INDEX IF NOT EXISTS idx_lcm_records_session ON lcm_records(session_id, channel_key, happened_at);

			CREATE TABLE IF NOT EXISTS lcm_summaries (
				id INTEGER PRIMARY KEY,
				summary_key TEXT NOT NULL UNIQUE,
				segment_id TEXT NOT NULL REFERENCES lcm_segments(id) ON DELETE CASCADE,
				depth INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'placeholder',
				text_full TEXT NOT NULL,
				pinned INTEGER NOT NULL DEFAULT 0,
				covers_from_record_id INTEGER REFERENCES lcm_records(id) ON DELETE SET NULL,
				covers_to_record_id INTEGER REFERENCES lcm_records(id) ON DELETE SET NULL,
				snapshot_json TEXT,
				source_type TEXT NOT NULL,
				source_path TEXT,
				source_line INTEGER,
				source_record_id TEXT,
				source_message_id TEXT,
				source_ref TEXT,
				metadata_json TEXT,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);

			CREATE INDEX IF NOT EXISTS idx_lcm_summaries_segment ON lcm_summaries(segment_id, depth, id);
			CREATE INDEX IF NOT EXISTS idx_lcm_summaries_status ON lcm_summaries(status, pinned);

			CREATE TABLE IF NOT EXISTS lcm_summary_sources (
				summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				ord INTEGER NOT NULL,
				record_id INTEGER REFERENCES lcm_records(id) ON DELETE SET NULL,
				source_ref TEXT,
				snapshot_json TEXT,
				PRIMARY KEY(summary_id, ord)
			);

			CREATE TABLE IF NOT EXISTS lcm_summary_parents (
				summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				parent_summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				ord INTEGER NOT NULL,
				PRIMARY KEY(summary_id, parent_summary_id)
			);

			CREATE INDEX IF NOT EXISTS idx_summary_parents_parent ON lcm_summary_parents(parent_summary_id);
			CREATE INDEX IF NOT EXISTS idx_summary_parents_child ON lcm_summary_parents(summary_id);

			CREATE TABLE IF NOT EXISTS lcm_context_items (
				session_key TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
				fingerprint TEXT NOT NULL,
				happened_at TEXT,
				updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
				PRIMARY KEY(session_key, ordinal)
			);

			CREATE TABLE IF NOT EXISTS lcm_session_state (
				session_key TEXT PRIMARY KEY,
				compaction_debt INTEGER NOT NULL DEFAULT 0,
				cache_touched_at INTEGER,
				updated_at INTEGER
			);
		`);

		const previousVersion = Number(readMeta(db, "schema_version") ?? "0");
		migrateRecordPartsColumn(db);
		migrateSummarySnapshotColumn(db);
		migrateContextItemsSummaryOnly(db);
		migrateAdvisorySummaryLineage(db);
		if (previousVersion > 0 && previousVersion < 10) migrateDuplicatedRecordText(db);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_lcm_context_items_session ON lcm_context_items(session_key);
			CREATE INDEX IF NOT EXISTS idx_lcm_context_items_summary ON lcm_context_items(summary_id);
			DROP TABLE IF EXISTS lcm_records_fts;
			DROP TABLE IF EXISTS lcm_summaries_fts;
		`);
		writeMeta(db, "schema_version", String(SCHEMA_VERSION));
	};
	if (db.inTransaction) run();
	else db.transaction(run).immediate();
}

export function readMeta(db: Database.Database, key: string): string | null {
	const row = db.prepare("SELECT v FROM lcm_meta WHERE k = ?").get(key) as { v: string } | undefined;
	return row?.v ?? null;
}

export function writeMeta(db: Database.Database, key: string, value: string): void {
	db.prepare(
		`INSERT INTO lcm_meta(k, v) VALUES (?, ?)
		 ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
	).run(key, value);
}

function migrateRecordPartsColumn(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(lcm_records)").all() as Array<{ name: string }>;
	if (columns.some((column) => column.name === "parts_json")) return;
	db.prepare("ALTER TABLE lcm_records ADD COLUMN parts_json TEXT").run();
}

function migrateSummarySnapshotColumn(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(lcm_summaries)").all() as Array<{ name: string }>;
	if (columns.some((column) => column.name === "snapshot_json")) return;
	db.prepare("ALTER TABLE lcm_summaries ADD COLUMN snapshot_json TEXT").run();
}

/**
 * source_summary_id was an advisory summary-to-summary edge superseded by
 * lcm_summary_parents. Condensation always wrote both, so the backfill is a
 * safety net for summaries that somehow only carry the advisory edge.
 */
function migrateAdvisorySummaryLineage(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(lcm_summary_sources)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "source_summary_id")) return;
	db.exec(`
		INSERT OR IGNORE INTO lcm_summary_parents (summary_id, parent_summary_id, ord)
		SELECT summary_id, source_summary_id, ord
		FROM lcm_summary_sources
		WHERE source_summary_id IS NOT NULL
			AND summary_id NOT IN (SELECT summary_id FROM lcm_summary_parents);
		ALTER TABLE lcm_summary_sources DROP COLUMN source_summary_id;
	`);
}

/**
 * Records written before appendAssistantFinalText guarded the outbound final
 * text stored it twice: merged into the trailing text part or appended as a
 * duplicate trailing part. One-time cleanup so index/context read canonical
 * rows without runtime collapse heuristics.
 */
function migrateDuplicatedRecordText(db: Database.Database): void {
	const rows = db
		.prepare("SELECT id, text_full, parts_json FROM lcm_records WHERE kind IN ('user', 'assistant')")
		.all() as Array<{ id: number; text_full: string; parts_json: string | null }>;
	const update = db.prepare(
		"UPDATE lcm_records SET text_full = ?, parts_json = ?, updated_at = unixepoch() WHERE id = ?",
	);
	for (const row of rows) {
		const parts = parseRecordParts(row.parts_json);
		if (parts) {
			const cleaned = collapseDuplicatedParts(parts);
			if (!cleaned) continue;
			update.run(flattenLcmRecordParts(cleaned), JSON.stringify(cleaned), row.id);
		} else {
			const collapsed = collapseDuplicatedText(row.text_full);
			if (collapsed !== row.text_full) update.run(collapsed, row.parts_json, row.id);
		}
	}
}

function parseRecordParts(json: string | null): LcmRecordPart[] | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 ? (parsed as LcmRecordPart[]) : null;
	} catch {
		return null;
	}
}

/**
 * Returns cleaned parts, or null when nothing changed. The duplicate was
 * always the full visible text re-appended at the end — either merged into
 * the trailing text part or pushed as a new one — so a single suffix split of
 * the trailing text part covers every shape.
 * ponytail: O(n²) scan per record, fine for a one-time pass over a chat log.
 */
function collapseDuplicatedParts(parts: LcmRecordPart[]): LcmRecordPart[] | null {
	const last = parts.at(-1);
	if (last?.kind !== "text") return null;
	const earlier = parts
		.slice(0, -1)
		.filter((part): part is Extract<LcmRecordPart, { kind: "text" }> => part.kind === "text")
		.map((part) => part.text)
		.join("\n");
	for (let split = 0; split <= last.text.length; split += 1) {
		const prefix = last.text.slice(0, split);
		const suffix = last.text.slice(split);
		const left = normalizeComparableText([earlier, prefix].join("\n"));
		if (left.length < 24 || left !== normalizeComparableText(suffix)) continue;
		const next = parts.slice(0, -1);
		if (prefix.trim()) next.push({ ...last, text: prefix });
		return next;
	}
	return null;
}

function collapseDuplicatedText(text: string): string {
	let normalized = text.trim();
	for (let iteration = 0; iteration < 4; iteration += 1) {
		const collapsed = collapseOnce(normalized);
		if (collapsed === normalized) return normalized;
		normalized = collapsed;
	}
	return normalized;
}

function collapseOnce(text: string): string {
	for (let split = Math.floor(text.length / 2); split >= 24; split -= 1) {
		const left = text.slice(0, split).trim();
		const right = text.slice(split).trim();
		if (left && normalizeComparableText(left) === normalizeComparableText(right)) return left;
	}
	return text;
}

function normalizeComparableText(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function migrateContextItemsSummaryOnly(db: Database.Database): void {
	const columns = db.prepare("PRAGMA table_info(lcm_context_items)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "item_type" || column.name === "record_id")) return;
	db.exec(`
		CREATE TABLE lcm_context_items_next (
			session_key TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			summary_id INTEGER NOT NULL REFERENCES lcm_summaries(id) ON DELETE CASCADE,
			fingerprint TEXT NOT NULL,
			happened_at TEXT,
			updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
			PRIMARY KEY(session_key, ordinal)
		);
		INSERT INTO lcm_context_items_next (
			session_key, ordinal, summary_id, fingerprint, happened_at, updated_at
		)
		SELECT item.session_key, item.ordinal, item.summary_id, item.fingerprint, item.happened_at, item.updated_at
		FROM lcm_context_items item
		JOIN lcm_summaries summary ON summary.id = item.summary_id
		WHERE item.item_type = 'summary';
		DROP TABLE lcm_context_items;
		ALTER TABLE lcm_context_items_next RENAME TO lcm_context_items;
	`);
}
