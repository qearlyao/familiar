import type Database from "better-sqlite3";

export function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function runInTransaction<T>(db: Database.Database, fn: () => T): T {
	return db.inTransaction ? fn() : db.transaction(fn).immediate();
}
