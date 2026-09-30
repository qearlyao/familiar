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
			"run javascript that calls your tools as `await tools.<name>(args)`, including ones you haven't loaded. only what you text(), console.log, or return comes back, so the results in between never touch your context — use it to chain calls, fan out with Promise.all, or pare a big result down. each tool returns its text output as a string; `ALL_TOOLS` lists them all and `await describeTool(name)` shows a tool's arguments.",
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
