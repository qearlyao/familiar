// follows pi's coding-agent/src/extensions/codemode (tool.ts + execute.ts): same catalog, budget,
// discovery globals and output shape. pi only ships it as an AgentSession extension, so this
// rebuilds it over plain AgentTools; store()/load() and models.* need pi's session and are left out.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeJsonSchema,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	MCP_TYPESCRIPT_PREAMBLE,
	mcpStructuredContentSchema,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT, rankBm25, type ToolNamespace } from "./tool-search.js";

export const CODEMODE_TOOL_NAME = "codemode";
/** estimated tokens the tool declarations in the description may spend */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** the worker shares the process; without a cap a runaway script can grow to wasm32's 4 GiB */
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

const DESCRIPTION_INTRO = `run javascript that calls your tools as \`await tools.<name>(args)\`, including ones you haven't loaded. only what you text(), console.log, image() or return comes back, so the results in between never touch your context — use it to chain calls, fan out with Promise.all, or pare a big result down.
- mcp tools resolve to their whole CallToolResult (read \`result.content\`, check \`result.isError\`); other tools resolve to their text output.
- \`ALL_TOOLS\` lists them all, \`await searchTools(query)\` finds the ones not listed below, and \`await describeTool(name)\` shows a tool's arguments.
- \`image(result.content[0])\` passes an image along; \`exit()\` ends the script early.
- an optional first line \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\` sets the output budget (10000 tokens by default) and a hard deadline (none by default).`;

const DEFERRED_TOOLS_GUIDANCE =
	"not every tool is listed below. the rest are still on `tools` and in `ALL_TOOLS`; find one with `await searchTools(query)`.";

/** what a script sees of a tool; tools without an output schema resolve to their text */
function toDeclaration(tool: AgentTool<any>): Omit<CodemodeTool, "execute"> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

interface CatalogEntry {
	name: string;
	section: string;
	cost: number;
	deferred: boolean;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

/**
 * pick the sections that fit the budget: each round every group (loose tools first, then
 * namespaces by name) places its cheapest remaining tool, and a group whose next tool doesn't fit
 * drops out. every namespace shows something before any one is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number): Set<string> {
	const queues = groups.map((group) =>
		group.entries.filter((entry) => !entry.deferred).sort((a, b) => a.cost - b.cost),
	);
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

export interface CodemodeDescriptionOptions {
	namespaceOf?: (name: string) => ToolNamespace | undefined;
	/** callable but never listed with a declaration; still counted under their namespace */
	deferred?: ReadonlySet<string>;
	inlineBudget?: number;
}

/** the intro, the shared mcp types when needed, and the listed tools grouped by namespace within the budget */
export function createCodemodeDescription(
	listed: readonly AgentTool<any>[],
	options: CodemodeDescriptionOptions = {},
): string {
	const declarations = listed.map(toDeclaration);
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const declaration of declarations) {
		const namespace = options.namespaceOf?.(declaration.name);
		const key = namespace?.name ?? "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(declaration);
		group.entries.push({
			name: declaration.name,
			section,
			cost: Math.ceil(section.length / CHARS_PER_TOKEN),
			deferred: options.deferred?.has(declaration.name) === true,
		});
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget ?? DEFAULT_CODEMODE_INLINE_BUDGET);
	const complete = shown.size === declarations.length;

	const sections = [DESCRIPTION_INTRO];
	if (!complete) sections.push(DEFERRED_TOOLS_GUIDANCE);
	if (declarations.some((declaration) => mcpStructuredContentSchema(declaration.outputSchema) !== undefined)) {
		sections.push(`shared mcp types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	if (declarations.length === 0) return sections.join("\n\n");

	const toolSections = [
		complete
			? `tools you can call: all ${declarations.length} listed.`
			: `tools you can call: ${shown.size} of ${declarations.length} listed.`,
	];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			const count = `${entries.length} tool${entries.length === 1 ? "" : "s"}`;
			const suffix =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? ", none shown"
						: `, ${visible.length} shown`;
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name} (${count}${suffix})${description ? `\n${description}` : ""}`);
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function formatError(result: Extract<CodemodeResult, { ok: false }>): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	const calls =
		result.calls.length === 0
			? "No tool calls were made."
			: `Tool calls made before the failure (they are not undone): ${result.calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
	return `${head}\n\n${calls}`;
}

/** past the budget, the text keeps its start and end and the whole of it goes to a temp file */
async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
): Promise<(TextContent | ImageContent)[]> {
	const combined = items
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (combined.length <= budget) return items;
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${combined.slice(0, headChars)}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	const path = join(tmpdir(), `codemode-${randomBytes(8).toString("hex")}.txt`);
	try {
		await writeFile(path, combined, { mode: 0o600 });
		text += `\n\n[Full output: ${path} (read with offset/limit)]`;
	} catch (error) {
		text += `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	return [{ type: "text", text }, ...items.filter((item) => item.type === "image")];
}

/** searchTools() and describeTool(): ranked search and lookup over the script's tools */
function discoveryGlobals(
	tools: readonly AgentTool<any>[],
	samples: ReadonlyMap<string, string>,
	namespaceOf: CodemodeDescriptionOptions["namespaceOf"],
): CodemodeTool[] {
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("searchTools() limit must be a positive integer");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				const documents = tools.flatMap((tool) => {
					const toolNamespace = namespaceOf?.(tool.name);
					if (namespace && toolNamespace?.name !== namespace) return [];
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				return rankBm25(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find(
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
	];
}

const codemodeSchema = Type.Object({
	code: Type.String({
		description:
			'raw javascript source; top-level await and return work. may start with a `// @options: {"max_output_tokens": 1000}` line.',
	}),
});

export interface CodemodeToolOptions extends CodemodeDescriptionOptions {
	/** declared to the model already, so callable from scripts but not listed again */
	direct?: ReadonlySet<string>;
}

/**
 * scripts reach every tool given; only what the script prints or returns lands in context.
 * nested calls skip the agent's tool events, so they don't show up as their own calls.
 */
export function createCodemodeTool(
	callable: readonly AgentTool<any>[],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	const tools = callable.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
	const listed = tools.filter((tool) => !options.direct?.has(tool.name));
	return {
		name: CODEMODE_TOOL_NAME,
		label: "Codemode",
		description: createCodemodeDescription(listed, options),
		parameters: codemodeSchema,
		async execute(toolCallId, input, signal) {
			const startedAt = performance.now();
			const { code, options: sourceOptions } = parseCodemodeSource(input.code);
			const samples = new Map(tools.map((tool) => [tool.name, renderToolSample(toDeclaration(tool))]));
			let callCount = 0;
			const sandboxTools: CodemodeTool[] = tools.map((tool) => ({
				name: tool.name,
				description: samples.get(tool.name),
				async execute(args, { signal: callSignal }) {
					const result = await tool.execute(`${toolCallId}/${++callCount}`, args as never, callSignal);
					// a declared output schema resolves to structuredContent, error results included
					if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
					const text = textOf(result);
					if (result.isError) throw new Error(text || `Tool "${tool.name}" failed`);
					return text;
				},
			}));
			const sandbox = new CodemodeSandbox({
				tools: sandboxTools,
				globals: discoveryGlobals(tools, samples, options.namespaceOf),
				timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
				memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
			});
			let result: CodemodeResult;
			try {
				result = await sandbox.execute(code, { signal });
			} finally {
				await sandbox.close();
			}

			const items: (TextContent | ImageContent)[] = result.output.map((item) =>
				item.type === "text" ? { type: "text", text: item.text } : item,
			);
			if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result)}` });
			else if (result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
			const output = await truncateOutput(items, sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
			const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
			const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
			return {
				content: [{ type: "text", text: header }, ...output],
				details: undefined,
				...(result.ok ? {} : { isError: true }),
			};
		},
	};
}
