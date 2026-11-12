import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { basename, extname, relative, resolve } from "node:path";

import type { Config } from "../config/index.js";
import { attachmentsDir, generatedAttachmentsDir } from "../media/generated-media.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { atomicWriteJson, isEnoent, readFileOrNull } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { webMessagesFromRecords } from "./messages.js";
import { getChannelKeyFromRequest } from "./route-helpers.js";
import type { RegisterWebRoute } from "./routes.js";
import { servePrivateFile } from "./static.js";
import type { WebMessage } from "./types.js";

/**
 * A stretch of the conversation kept on the library shelf, as the messages themselves:
 * the room draws it with the chat's own components, so it looks the way the moment did.
 * Media is copied in when it is kept, since chat copies expire with generated media.
 */
export interface Clipping {
	id: string;
	createdAt: number;
	/** what you call it; until it has one, the shelf goes by your line or the first thing said */
	title?: string;
	/** a line of your own under it */
	note?: string;
	/** set when they kept it themselves; yours carry no mark */
	keptBy?: "them";
	messages: WebMessage[];
}

/** the most they can keep in one go */
export const MAX_KEPT_BY_THEM = 40;

const CLIPPING_ID_RE = /^[a-f0-9]{12}$/;
const ATTACHMENT_URL_PREFIX = "/api/web/attachments/";
const MAX_TITLE_CHARS = 120;
const MAX_NOTE_CHARS = 280;
export const CLIPPING_URL_PREFIX = "/api/web/library/clippings/";

function clippingsDir(config: Config, id = ""): string {
	return resolve(config.workspace.dataDir, "library", "clippings", id);
}

/** Everything between two messages, either order: words and thoughts stay, tool calls don't. */
export function clippingSpan(messages: readonly WebMessage[], from: string, to: string): WebMessage[] | undefined {
	const a = messages.findIndex((message) => message.id === from);
	const b = messages.findIndex((message) => message.id === to);
	if (a < 0 || b < 0) return undefined;
	return messages.slice(Math.min(a, b), Math.max(a, b) + 1).map(({ tools: _tools, usage: _usage, ...message }) => ({
		...message,
		steps: message.steps?.filter((step) => step.kind !== "tool"),
		attachments: message.attachments?.map((attachment) => ({ ...attachment })),
	}));
}

/** how words are compared when a moment is named by quoting it: only the letters and digits count */
function plain(text: string): string {
	return text
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.toLowerCase();
}

/**
 * The span a few quoted words name: it ends at the latest message holding `to` (or the latest of all),
 * and starts at the latest message holding `from` at or before that. Throws with what couldn't be found.
 */
export function clippingSpanByWords(messages: readonly WebMessage[], from: string, to?: string): WebMessage[] {
	const spoken = (message: WebMessage) => message.role !== "system";
	const said = messages.map((message) => (spoken(message) ? plain(message.text) : ""));
	const latest = (words: string, before: number): number => {
		const needle = plain(words);
		if (!needle) return -1;
		for (let index = before; index >= 0; index -= 1) if (said[index]?.includes(needle)) return index;
		return -1;
	};
	const ending = to?.trim();
	const end = ending ? latest(ending, messages.length - 1) : messages.findLastIndex(spoken);
	if (end < 0) throw new Error(ending ? `no message here contains "${ending}"` : "nothing has been said here yet");
	const start = latest(from, end);
	if (start < 0) throw new Error(`no message ${ending ? "before that end " : ""}contains "${from.trim()}"`);
	return clippingSpan(messages, messages[start]!.id, messages[end]!.id)!;
}

/** where a chat attachment url lives on disk; the url comes from our own records, never from a request */
async function attachmentFile(config: Config, url: string): Promise<string | undefined> {
	const relativePath = decodeURIComponent(url.slice(ATTACHMENT_URL_PREFIX.length).split("?")[0] ?? "");
	for (const root of [generatedAttachmentsDir(config), attachmentsDir(config)]) {
		const path = resolve(root, relativePath);
		const rel = relative(root, path);
		if (!rel || rel.startsWith("..")) continue;
		if ((await stat(path).catch(() => undefined))?.isFile()) return path;
	}
	return undefined;
}

export async function keepClipping(
	config: Config,
	messages: WebMessage[],
	about: Pick<Clipping, "title" | "note" | "keptBy"> = {},
): Promise<Clipping> {
	const id = randomBytes(6).toString("hex");
	const dir = clippingsDir(config, id);
	await mkdir(resolve(dir, "files"), { recursive: true });
	try {
		let copied = 0;
		for (const attachment of messages.flatMap((message) => message.attachments ?? [])) {
			// a remote url (a discord upload never stored here) stays as it is
			if (!attachment.url?.startsWith(ATTACHMENT_URL_PREFIX)) continue;
			const source = await attachmentFile(config, attachment.url);
			if (!source) {
				attachment.url = undefined;
				continue;
			}
			const name = `${copied++}${extname(source)}`;
			await copyFile(source, resolve(dir, "files", name), constants.COPYFILE_FICLONE);
			attachment.url = `${CLIPPING_URL_PREFIX}${id}/${name}`;
		}
		const clipping: Clipping = {
			id,
			createdAt: Date.now(),
			title: about.title?.trim().slice(0, MAX_TITLE_CHARS) || undefined,
			note: about.note?.trim().slice(0, MAX_NOTE_CHARS) || undefined,
			keptBy: about.keptBy,
			messages,
		};
		await atomicWriteJson(resolve(dir, "clipping.json"), clipping);
		return clipping;
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

export async function listClippings(config: Config): Promise<Clipping[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(clippingsDir(config), { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const clippings = await Promise.all(
		entries.filter((entry) => entry.isDirectory()).map((entry) => readClipping(config, entry.name)),
	);
	return clippings
		.filter((clipping): clipping is Clipping => clipping !== undefined)
		.sort((a, b) => b.createdAt - a.createdAt);
}

/** Renames it or rewrites your line; an empty value clears that one. The messages never change. */
export async function editClipping(
	config: Config,
	id: string,
	edit: { title?: string; note?: string },
): Promise<Clipping | undefined> {
	const clipping = await readClipping(config, id);
	if (!clipping) return undefined;
	if (edit.title !== undefined) clipping.title = edit.title.trim().slice(0, MAX_TITLE_CHARS) || undefined;
	if (edit.note !== undefined) clipping.note = edit.note.trim().slice(0, MAX_NOTE_CHARS) || undefined;
	await atomicWriteJson(resolve(clippingsDir(config, id), "clipping.json"), clipping);
	return clipping;
}

export async function removeClipping(config: Config, id: string): Promise<boolean> {
	if (!(await readClipping(config, id))) return false;
	await rm(clippingsDir(config, id), { recursive: true });
	return true;
}

async function readClipping(config: Config, id: string): Promise<Clipping | undefined> {
	if (!CLIPPING_ID_RE.test(id)) return undefined;
	const raw = await readFileOrNull(resolve(clippingsDir(config, id), "clipping.json"), "utf8");
	if (!raw) return undefined;
	const parsed = JSON.parse(raw) as Clipping;
	return parsed.id === id ? parsed : undefined;
}

export function registerWebClippingRoutes(
	route: RegisterWebRoute,
	config: Config,
	deps: { getRuntime(channelKey?: string): Promise<ConversationRuntime>; personaName: string },
): void {
	const path = CLIPPING_URL_PREFIX.slice(0, -1);

	route("GET", path, async (_request, response) => {
		sendJson(response, 200, { clippings: await listClippings(config) });
	});

	route("POST", path, async (request, response, url) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.from !== "string" || typeof body.to !== "string") {
			throw new HttpError(400, "from and to message ids are required");
		}
		const runtime = await deps.getRuntime(getChannelKeyFromRequest(url, body));
		const span = clippingSpan(
			webMessagesFromRecords(config, runtime.getRecords(), deps.personaName),
			body.from,
			body.to,
		);
		if (!span) throw new HttpError(404, "those messages are no longer in this conversation");
		const note = typeof body.note === "string" ? body.note : undefined;
		sendJson(response, 200, { clipping: await keepClipping(config, span, { note }) });
	});

	route("PUT", path, async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "clipping id is required");
		const clipping = await editClipping(config, body.id, {
			title: typeof body.title === "string" ? body.title : undefined,
			note: typeof body.note === "string" ? body.note : undefined,
		});
		if (!clipping) throw new HttpError(404, "clipping not found");
		sendJson(response, 200, { clipping });
	});

	route("DELETE", path, async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "clipping id is required");
		if (!(await removeClipping(config, body.id))) throw new HttpError(404, "clipping not found");
		sendJson(response, 200, { ok: true });
	});
}

export async function serveClippingFile(
	config: Config,
	response: ServerResponse,
	requestPath: string,
	rangeHeader?: string,
): Promise<void> {
	let requested: string;
	try {
		requested = decodeURIComponent(requestPath.slice(CLIPPING_URL_PREFIX.length));
	} catch {
		throw new HttpError(400, "invalid clipping path");
	}
	const [id = "", name = ""] = requested.split("/", 2);
	// a bare file name under a well-formed id can never walk out of the clipping's files
	if (!CLIPPING_ID_RE.test(id) || !name || basename(name) !== name || requested !== `${id}/${name}`) {
		throw new HttpError(404, "clipping file not found");
	}
	const path = resolve(clippingsDir(config, id), "files", name);
	const fileStat = await stat(path).catch(() => undefined);
	if (!fileStat?.isFile()) throw new HttpError(404, "clipping file not found");
	servePrivateFile(response, path, fileStat.size, rangeHeader);
}
