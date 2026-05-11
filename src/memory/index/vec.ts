import { createRequire } from "node:module";

import type Database from "better-sqlite3";

export type VectorCapability = "sqlite-vec" | "blob-js";

export interface SqliteVecAvailable {
	available: true;
	registerOnDb(db: Database.Database): void;
}

export interface SqliteVecUnavailable {
	available: false;
}

export type SqliteVecState = SqliteVecAvailable | SqliteVecUnavailable;

type SqliteVecModule = {
	load?: (db: Database.Database) => void;
	default?: { load?: (db: Database.Database) => void };
	loadablePathFor?: () => string;
};

const requireOptional = createRequire(import.meta.url);
let loggedUnavailable = false;
let loadModule = (): unknown => requireOptional("sqlite-vec");
let loadedDbs = new WeakSet<Database.Database>();

export function loadSqliteVec(db: Database.Database): SqliteVecState {
	if (loadedDbs.has(db)) return availableState;
	try {
		const mod = loadModule() as SqliteVecModule;
		registerModuleOnDb(mod, db);
		const row = db.prepare("SELECT vec_version() AS version").get() as { version?: string } | undefined;
		if (!row?.version) throw new Error("sqlite-vec loaded but vec_version() is unavailable");
		loadedDbs.add(db);
		return availableState;
	} catch {
		logUnavailableOnce();
		return { available: false };
	}
}

export function isSqliteVecLoadedForDb(db: Database.Database): boolean {
	return loadedDbs.has(db);
}

function registerModuleOnDb(mod: SqliteVecModule, db: Database.Database): void {
	if (typeof mod.load === "function") {
		mod.load(db);
		return;
	}
	if (typeof mod.default?.load === "function") {
		mod.default.load(db);
		return;
	}
	if (typeof mod.loadablePathFor === "function") {
		const loadExtension = (db as Database.Database & { loadExtension?: (path: string) => void }).loadExtension;
		if (typeof loadExtension !== "function") throw new Error("better-sqlite3 does not support loadExtension");
		loadExtension.call(db, mod.loadablePathFor());
		return;
	}
	throw new Error("sqlite-vec module does not expose load(db) or loadablePathFor()");
}

function logUnavailableOnce(): void {
	if (loggedUnavailable) return;
	loggedUnavailable = true;
	console.info("sqlite-vec unavailable; using linear scan");
}

const availableState: SqliteVecAvailable = {
	available: true,
	registerOnDb(db: Database.Database): void {
		const state = loadSqliteVec(db);
		if (!state.available) throw new Error("sqlite-vec unavailable");
	},
};

export const __memoryVecTest = {
	setLoader(loader: (() => unknown) | null): void {
		loadModule = loader ?? (() => requireOptional("sqlite-vec"));
		loadedDbs = new WeakSet<Database.Database>();
		loggedUnavailable = false;
	},
	probePackage(): unknown | null {
		try {
			return requireOptional("sqlite-vec");
		} catch {
			return null;
		}
	},
};
