// ported from pi's coding-agent/src/extensions/tool-search/tool.ts: the BM25 ranking (as a plain function) and search
// documents verbatim, the tool itself rebuilt over familiar's own loadout, since pi only ships
// it as an AgentSession extension.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** a group of tools from one source, like one mcp server; its description is the server's instructions */
export interface ToolNamespace {
	name: string;
	description?: string;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

/** naive singular form, so `issues` matches `issue` and `searches` matches `search` */
function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words */
function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** schema descriptions and property names, recursively */
function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/** the name, the name with `_` as spaces, the description, schema text, and the namespace */
export function createToolSearchDocument(
	tool: Pick<AgentTool<any>, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): { name: string; text: string } {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

const K1 = 1.2;
const B = 0.75;

/** Okapi BM25 with the usual parameters; ties keep document order */
export function rankBm25(
	query: string,
	documents: readonly { name: string; text: string }[],
	limit: number,
): { name: string; score: number }[] {
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
	const termCounts = documents.map((document) => {
		const counts = new Map<string, number>();
		for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
		return counts;
	});
	const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
	const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
	const idf = new Map(
		queryTerms.map((term) => {
			const frequency = termCounts.filter((counts) => counts.has(term)).length;
			return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
		}),
	);
	const matches: { name: string; score: number }[] = [];
	documents.forEach((document, index) => {
		let score = 0;
		for (const term of queryTerms) {
			const count = termCounts[index].get(term);
			if (!count) continue;
			const norm = K1 * (1 - B + (B * lengths[index]) / averageLength);
			score += (idf.get(term) ?? 0) * ((count * (K1 + 1)) / (count + norm));
		}
		if (score > 0) matches.push({ name: document.name, score });
	});
	return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

const firstLine = (text: string | undefined) => text?.trim().split(/\r?\n/)[0] ?? "";

/** names the sources there is to search: each namespace once, and loose tools by name */
export function createToolSearchDescription(
	searchable: readonly AgentTool<any>[],
	namespaceOf: (name: string) => ToolNamespace | undefined,
): string {
	const namespaces = new Map<string, ToolNamespace>();
	const loose: string[] = [];
	for (const tool of searchable) {
		const namespace = namespaceOf(tool.name);
		if (namespace) namespaces.set(namespace.name, namespace);
		else loose.push(tool.name);
	}
	const sources = [
		...[...namespaces.values()].map((namespace) => {
			const description = firstLine(namespace.description);
			return description ? `- ${namespace.name}: ${description}` : `- ${namespace.name}`;
		}),
		...loose.map((name) => `- ${name}`),
	];
	return `find tools you aren't holding yet and bring the best matches into reach; they become callable from your next turn. searches names, descriptions and arguments, so describe what you want to do. there's more to find from:\n${sources.join("\n")}`;
}

const toolSearchSchema = Type.Object({
	query: Type.String({ description: "what you're looking for, in a few words." }),
	limit: Type.Optional(Type.Number({ description: `most tools to load. defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` })),
});

/** ranks the searchable tools not yet held and hands the matches to onLoad */
export function createToolSearchTool(
	searchable: readonly AgentTool<any>[],
	namespaceOf: (name: string) => ToolNamespace | undefined,
	held: () => ReadonlySet<string>,
	onLoad: (tools: AgentTool<any>[]) => void,
): AgentTool<typeof toolSearchSchema> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: "Tool Search",
		description: createToolSearchDescription(searchable, namespaceOf),
		parameters: toolSearchSchema,
		async execute(_toolCallId, { query, limit }) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const holding = held();
			const candidates = searchable.filter((tool) => !holding.has(tool.name));
			const documents = candidates.map((tool) => createToolSearchDocument(tool, namespaceOf(tool.name)));
			const matches = rankBm25(query, documents, max).map(
				(match) => candidates.find((tool) => tool.name === match.name)!,
			);
			if (matches.length === 0) return { content: [{ type: "text", text: "nothing matched." }], details: undefined };
			onLoad(matches);
			const listed = matches.map((tool) => `- ${tool.name}: ${firstLine(tool.description)}`).join("\n");
			return {
				content: [{ type: "text", text: `loaded ${matches.length}, callable from your next turn:\n${listed}` }],
				details: undefined,
			};
		},
	};
}
