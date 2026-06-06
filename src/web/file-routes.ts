import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Config } from "../config/index.js";
import { applyContactNoteContent, setContactNotePath } from "../conversation/contact-note.js";
import { isEnoent } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";

interface WebFileDefinitionSpec {
	id: string;
	name: string;
	title: string;
	description: string;
	path(config: Config): string;
	afterWrite?(path: string, content: string): void;
}

const WEB_FILE_DEFINITIONS = [
	{
		id: "soul",
		name: "SOUL.md",
		title: "soul",
		description: "who your companion is trying to be",
		path: (config) => config.persona.soul,
	},
	{
		id: "user",
		name: "USER.md",
		title: "you",
		description: "what they should remember about you",
		path: (config) => config.persona.user,
	},
	{
		id: "memory",
		name: "MEMORY.md",
		title: "memory",
		description: "the long thread that should stay close",
		path: (config) => config.persona.memory,
	},
	{
		id: "heartbeat",
		name: "HEARTBEAT.md",
		title: "heartbeat",
		description: "what they do when the room gets quiet",
		path: (config) => resolve(config.workspacePath, "HEARTBEAT.md"),
	},
	{
		id: "contact",
		name: "CONTACT.md",
		title: "contact",
		description: "the name you keep for yourself here",
		path: (config) => config.persona.contact,
		afterWrite: (path, content) => {
			setContactNotePath(path);
			applyContactNoteContent(content);
		},
	},
] as const satisfies readonly WebFileDefinitionSpec[];

export type WebFileId = (typeof WEB_FILE_DEFINITIONS)[number]["id"];

type WebFileDefinition = WebFileDefinitionSpec & { id: WebFileId };

const WEB_FILES: readonly WebFileDefinition[] = WEB_FILE_DEFINITIONS;

export interface WebFileSummary {
	id: WebFileId;
	name: string;
	title: string;
	description: string;
	mtimeMs: number | null;
	sizeBytes: number;
	exists: boolean;
}

export interface WebFileEntry extends WebFileSummary {
	content: string;
}

const MAX_WEB_FILE_BODY_BYTES = 1024 * 1024;

export function registerWebFileRoutes(route: RegisterWebRoute, config: Config): void {
	route("GET", "/api/web/files", async (_request, response) => {
		sendJson(response, 200, { files: await listWebFiles(config) });
	});

	route("GET", "/api/web/file", async (_request, response, url) => {
		const id = url.searchParams.get("id") ?? "";
		sendJson(response, 200, { file: await readWebFile(config, id) });
	});

	route("PUT", "/api/web/file", async (request, response) => {
		const body = await readJsonBody(request, MAX_WEB_FILE_BODY_BYTES);
		const { id, content } = fileUpdateFromBody(body);
		sendJson(response, 200, { file: await writeWebFile(config, id, content) });
	});
}

export async function listWebFiles(config: Config): Promise<WebFileSummary[]> {
	return Promise.all(WEB_FILES.map((definition) => readFileSummary(config, definition)));
}

export async function readWebFile(config: Config, rawId: string): Promise<WebFileEntry> {
	const definition = webFileDefinition(rawId);
	const path = webFilePath(config, definition);
	const summary = await readFileSummary(config, definition);
	let content = "";
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return { ...summary, content };
}

export async function writeWebFile(config: Config, rawId: string, content: string): Promise<WebFileEntry> {
	const definition = webFileDefinition(rawId);
	const path = webFilePath(config, definition);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
	definition.afterWrite?.(path, content);
	return readWebFile(config, definition.id);
}

async function readFileSummary(config: Config, definition: WebFileDefinition): Promise<WebFileSummary> {
	const path = webFilePath(config, definition);
	try {
		const fileStat = await stat(path);
		if (!fileStat.isFile()) throw new HttpError(404, `${definition.name} is not a file`);
		return {
			id: definition.id,
			name: definition.name,
			title: definition.title,
			description: definition.description,
			mtimeMs: Math.floor(fileStat.mtimeMs),
			sizeBytes: fileStat.size,
			exists: true,
		};
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return {
			id: definition.id,
			name: definition.name,
			title: definition.title,
			description: definition.description,
			mtimeMs: null,
			sizeBytes: 0,
			exists: false,
		};
	}
}

function fileUpdateFromBody(body: unknown): { id: string; content: string } {
	if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "file id is required");
	if (typeof body.content !== "string") throw new HttpError(400, "content is required");
	return { id: body.id, content: body.content };
}

function webFileDefinition(rawId: string): WebFileDefinition {
	const definition = WEB_FILES.find((candidate) => candidate.id === rawId);
	if (!definition) throw new HttpError(400, `unknown file: ${rawId}`);
	return definition;
}

function webFilePath(config: Config, definition: WebFileDefinition): string {
	return resolve(definition.path(config));
}
