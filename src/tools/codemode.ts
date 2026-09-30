import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type CodemodeJsonSchema,
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { Type } from "typebox";

const codemodeSchema = Type.Object({
	code: Type.String({ description: "javascript, run as the body of an async function." }),
});

/**
 * scripts reach every tool that isn't off, deferred ones included, without loading them;
 * only what the script prints or returns lands in context. nested calls skip the agent's
 * tool events, so they don't show up as their own calls.
 */
export function createCodemodeTool(tools: readonly AgentTool<any>[]): AgentTool<typeof codemodeSchema> {
	const nested: CodemodeTool[] = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: { type: "string" },
		async execute(args, { signal }) {
			const result = await tool.execute("codemode", args as never, signal);
			return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		},
	}));
	const describeTool: CodemodeTool = {
		name: "describeTool",
		signature: "(name: string): Promise<string | undefined>",
		execute: (name) => {
			const tool = nested.find((candidate) => candidate.name === name);
			return tool && renderDeclarations({ tools: [tool] });
		},
	};
	return {
		name: "codemode",
		label: "Codemode",
		description:
			"run javascript that calls your tools as `await tools.<name>(args)` — same names and arguments as calling them yourself, and that includes tools still waiting behind load_tools. every tool returns its text output as a string. only what you print with text() or console.log, or return, comes back to you; the results in between stay out of your context. good for chaining calls, running independent ones together with Promise.all, or trimming a big result down to the part you need. `ALL_TOOLS` lists every name with its description; `await describeTool(name)` shows a tool's arguments. top-level await and return work. there's no fetch, timers, or modules in here — tools are the only way out.",
		parameters: codemodeSchema,
		async execute(_toolCallId, { code }, signal) {
			const sandbox = new CodemodeSandbox({ tools: nested, globals: [describeTool] });
			try {
				const result = await sandbox.execute(code, { signal });
				const content = [...result.output];
				if (!result.ok) {
					const output = content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
					throw new Error(
						`${result.error.kind}: ${result.error.stack ?? result.error.message}${output ? `\n\n${output}` : ""}`,
					);
				}
				const { value } = result;
				if (value !== undefined)
					content.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
				return { content, details: undefined };
			} finally {
				await sandbox.close();
			}
		},
	};
}
