import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import {
	type LoadSkillsResult,
	loadSkillsFromDir,
	parseFrontmatter,
	type SkillFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { stringify as stringifyYaml } from "yaml";

import type { Config } from "../config/index.js";
import { isEnoent } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";

export interface WebSkillSummary {
	id: string;
	name: string;
	description: string;
	relativePath: string;
	mtimeMs: number;
	sizeBytes: number;
	enabled: boolean;
	diagnostics: string[];
}

export interface WebSkillEntry extends WebSkillSummary {
	content: string;
}

interface SkillDraft {
	name: string;
	description: string;
	enabled: boolean;
	content: string;
}

interface ParsedSkillMarkdown {
	frontmatter: SkillFrontmatter;
	body: string;
}

interface DiscoveredWebSkills {
	paths: string[];
	diagnosticsByPath: Map<string, string[]>;
}

const MAX_WEB_SKILL_BODY_BYTES = 1024 * 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function registerWebSkillRoutes(route: RegisterWebRoute, config: Config): void {
	route("GET", "/api/web/skills", async (_request, response) => {
		sendJson(response, 200, { skills: await listWebSkills(config) });
	});

	route("GET", "/api/web/skill", async (_request, response, url) => {
		const id = url.searchParams.get("id") ?? "";
		sendJson(response, 200, { skill: await readWebSkill(config, id) });
	});

	route("PUT", "/api/web/skill", async (request, response) => {
		const body = await readJsonBody(request, MAX_WEB_SKILL_BODY_BYTES);
		const { id, draft } = skillUpdateFromBody(body);
		sendJson(response, 200, { skill: await writeWebSkill(config, id, draft) });
	});

	route("PUT", "/api/web/skill/enabled", async (request, response) => {
		const body = await readJsonBody(request, MAX_WEB_SKILL_BODY_BYTES);
		const { id, enabled } = skillEnabledUpdateFromBody(body);
		sendJson(response, 200, { skill: await setWebSkillEnabled(config, id, enabled) });
	});
}

export async function listWebSkills(config: Config): Promise<WebSkillSummary[]> {
	const root = skillsRoot(config);
	const discovered = discoverWebSkills(root);
	const summaries = await Promise.all(
		discovered.paths.map((path) => readListedSkillPayload(root, path, discovered.diagnosticsByPath)),
	);
	return summaries
		.filter((summary): summary is WebSkillSummary => summary !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath));
}

export async function readWebSkill(config: Config, id: string): Promise<WebSkillEntry> {
	const root = skillsRoot(config);
	const path = await editableSkillPath(root, id);
	return readSkillPayload(root, path, discoverWebSkills(root).diagnosticsByPath);
}

export async function writeWebSkill(config: Config, id: string, draft: SkillDraft): Promise<WebSkillEntry> {
	validateSkillDraft(draft);
	const root = skillsRoot(config);
	const path = await editableSkillPath(root, id);
	const current = await readSkillFile(path);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, formatSkillMarkdown(draft, current.frontmatter), "utf8");
	return readSkillPayload(root, path, discoverWebSkills(root).diagnosticsByPath);
}

export async function setWebSkillEnabled(config: Config, id: string, enabled: boolean): Promise<WebSkillEntry> {
	const root = skillsRoot(config);
	const path = await editableSkillPath(root, id);
	const current = await readSkillFile(path);
	await writeFile(path, formatSkillFile(formatEnabledFrontmatter(current.frontmatter, enabled), current.body), "utf8");
	return readSkillPayload(root, path, discoverWebSkills(root).diagnosticsByPath);
}

function skillsRoot(config: Config): string {
	return resolve(config.workspacePath, "skills");
}

function discoverWebSkills(root: string): DiscoveredWebSkills {
	const result = loadSkillsFromDir({ dir: root, source: "path" });
	const diagnosticsByPath = skillDiagnostics(result);
	const paths = new Set(result.skills.map((skill) => resolve(skill.filePath)));
	for (const path of diagnosticsByPath.keys()) {
		if (isEditableSkillPath(root, path)) paths.add(path);
	}
	return {
		paths: [...paths],
		diagnosticsByPath,
	};
}

function skillDiagnostics(result: LoadSkillsResult): Map<string, string[]> {
	const byPath = new Map<string, string[]>();
	for (const diagnostic of result.diagnostics) {
		if (!diagnostic.path) continue;
		const path = resolve(diagnostic.path);
		const messages = byPath.get(path) ?? [];
		messages.push(diagnostic.message ?? "unknown skill diagnostic");
		byPath.set(path, messages);
	}
	return byPath;
}

async function readListedSkillPayload(
	root: string,
	path: string,
	diagnosticsByPath: Map<string, string[]>,
): Promise<WebSkillSummary | undefined> {
	try {
		return await readSkillPayload(root, path, diagnosticsByPath);
	} catch (error) {
		if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return undefined;
		throw error;
	}
}

async function readSkillPayload(
	root: string,
	path: string,
	diagnosticsByPath: Map<string, string[]>,
): Promise<WebSkillEntry> {
	const linkStat = await lstat(path);
	if (linkStat.isSymbolicLink()) throw new HttpError(403, "skill symlinks cannot be edited from the web");
	const fileStat = await stat(path);
	if (!fileStat.isFile()) throw new HttpError(404, "skill not found");
	const raw = await readFile(path, "utf8");
	let parseDiagnostics: string[] = [];
	let parsed: ParsedSkillMarkdown;
	try {
		parsed = parseSkillMarkdown(raw);
	} catch (error) {
		parsed = { frontmatter: {}, body: normalizeNewlines(raw) };
		parseDiagnostics = [error instanceof Error ? error.message : "failed to parse skill frontmatter"];
	}
	const { frontmatter, body } = parsed;
	const name = readSkillName(frontmatter, root, path);
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	const diagnostics = diagnosticsByPath.get(resolve(path)) ?? [];
	return {
		id: skillId(root, path),
		name,
		description,
		relativePath: skillId(root, path),
		mtimeMs: Math.floor(fileStat.mtimeMs),
		sizeBytes: fileStat.size,
		enabled: frontmatter["disable-model-invocation"] !== true,
		diagnostics: [...diagnostics, ...parseDiagnostics],
		content: body,
	};
}

async function readSkillFile(path: string): Promise<ParsedSkillMarkdown> {
	const raw = await readFile(path, "utf8");
	return parseSkillMarkdown(raw);
}

function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
	const normalized = normalizeNewlines(raw);
	const parsed = parseFrontmatter<SkillFrontmatter>(normalized);
	if (!normalized.startsWith("---")) return { frontmatter: parsed.frontmatter, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter: parsed.frontmatter, body: normalized };
	return {
		frontmatter: parsed.frontmatter,
		body: normalized.slice(endIndex + 4).replace(/^\n/, ""),
	};
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readSkillName(frontmatter: SkillFrontmatter, root: string, path: string): string {
	if (typeof frontmatter.name === "string" && frontmatter.name.trim()) return frontmatter.name;
	if (dirname(path) === root) return basename(path, extname(path));
	return basename(dirname(path));
}

function skillId(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function isEditableSkillPath(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		relativePath.startsWith("/") ||
		relativePath.startsWith("\\")
	) {
		return false;
	}
	return basename(path) === "SKILL.md" || (dirname(path) === root && extname(path).toLowerCase() === ".md");
}

async function editableSkillPath(root: string, id: string): Promise<string> {
	if (!id.trim() || id.includes("\0")) throw new HttpError(400, "skill id is required");
	const path = resolve(root, id);
	if (!isEditableSkillPath(root, path)) {
		throw new HttpError(400, `unknown skill: ${id}`);
	}
	try {
		const linkStat = await lstat(path);
		if (linkStat.isSymbolicLink()) throw new HttpError(403, "skill symlinks cannot be edited from the web");
		if (!linkStat.isFile()) throw new HttpError(404, "skill not found");
	} catch (error) {
		if (isEnoent(error)) throw new HttpError(404, "skill not found");
		throw error;
	}
	return path;
}

function skillUpdateFromBody(body: unknown): { id: string; draft: SkillDraft } {
	if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "skill id is required");
	if (typeof body.name !== "string") throw new HttpError(400, "skill name is required");
	if (typeof body.description !== "string") throw new HttpError(400, "skill description is required");
	if (typeof body.enabled !== "boolean") throw new HttpError(400, "skill enabled flag is required");
	if (typeof body.content !== "string") throw new HttpError(400, "skill content is required");
	return {
		id: body.id,
		draft: {
			name: body.name,
			description: body.description,
			enabled: body.enabled,
			content: body.content,
		},
	};
}

function skillEnabledUpdateFromBody(body: unknown): { id: string; enabled: boolean } {
	if (!isRecord(body) || typeof body.id !== "string") throw new HttpError(400, "skill id is required");
	if (typeof body.enabled !== "boolean") throw new HttpError(400, "skill enabled flag is required");
	return { id: body.id, enabled: body.enabled };
}

function validateSkillDraft(draft: SkillDraft): void {
	const name = draft.name.trim();
	if (!name) throw new HttpError(400, "skill name is required");
	if (name.length > 64) throw new HttpError(400, "skill name must be 64 characters or fewer");
	if (!SKILL_NAME_RE.test(name)) {
		throw new HttpError(400, "skill name must use lowercase letters, numbers, and single hyphens");
	}
	if (!draft.description.trim()) throw new HttpError(400, "skill description is required");
	if (draft.description.length > 1024) throw new HttpError(400, "skill description must be 1024 characters or fewer");
}

function formatSkillMarkdown(draft: SkillDraft, previousFrontmatter: SkillFrontmatter): string {
	const frontmatter: SkillFrontmatter = {
		...previousFrontmatter,
		name: draft.name.trim(),
		description: draft.description.trim(),
	};
	return formatSkillFile(formatEnabledFrontmatter(frontmatter, draft.enabled), draft.content);
}

function formatEnabledFrontmatter(frontmatter: SkillFrontmatter, enabled: boolean): SkillFrontmatter {
	const next = { ...frontmatter };
	if (enabled) {
		delete next["disable-model-invocation"];
	} else {
		next["disable-model-invocation"] = true;
	}
	return next;
}

function formatSkillFile(frontmatter: SkillFrontmatter, body: string): string {
	const content = normalizeNewlines(body);
	return `---\n${formatSkillFrontmatter(frontmatter)}\n---\n${content}${content.endsWith("\n") ? "" : "\n"}`;
}

function formatSkillFrontmatter(frontmatter: SkillFrontmatter): string {
	return stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
}
