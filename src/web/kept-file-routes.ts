import { lstat } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import type { Config } from "../config/index.js";
import { findKeptFile, KEPT_FILE_URL_PREFIX, listKeptFiles, removeKeptFile } from "../media/kept-files.js";
import { isEnoent } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";
import { servePrivateFile } from "./static.js";

export function registerWebKeptFileRoutes(route: RegisterWebRoute, config: Config): void {
	route("GET", "/api/web/library/kept", async (_request, response) => {
		sendJson(response, 200, { files: await listKeptFiles(config) });
	});

	route("DELETE", "/api/web/library/kept", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "kept file id is required");
		if (!(await removeKeptFile(config, body.id))) throw new HttpError(404, "kept file not found");
		sendJson(response, 200, { ok: true });
	});
}

export async function serveKeptFile(
	config: Config,
	response: ServerResponse,
	requestPath: string,
	rangeHeader?: string,
): Promise<boolean> {
	let requested: string;
	try {
		requested = decodeURIComponent(requestPath.slice(KEPT_FILE_URL_PREFIX.length));
	} catch {
		throw new HttpError(400, "invalid kept file path");
	}
	const slash = requested.indexOf("/");
	if (slash < 1) throw new HttpError(400, "invalid kept file path");
	const kept = await findKeptFile(config, requested.slice(0, slash));
	// only the recorded name is servable, so a request path can never walk out of the entry
	if (!kept || kept.record.name !== requested.slice(slash + 1)) throw new HttpError(404, "kept file not found");
	const fileStat = await lstat(kept.path).catch((error) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!fileStat?.isFile()) throw new HttpError(404, "kept file not found");
	servePrivateFile(response, kept.path, fileStat.size, rangeHeader);
	return true;
}
