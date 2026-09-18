import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadConfig } from "../src/config/index.js";
import { connectMcpClient, createLoadToolsTool, loadedToolNames, pruneCondensedTools } from "../src/tools/mcp.js";
import { createWorkspace, minimalConfigToml, withDiscordToken } from "./helpers.js";

async function inMemoryTools() {
	const server = new McpServer({ name: "demo", version: "0" });
	server.registerTool(
		"add",
		{ description: "add two numbers", inputSchema: { a: z.number(), b: z.number() } },
		async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
	);
	server.registerTool("boom", { description: "always fails" }, async () => ({
		content: [{ type: "text", text: "nope" }],
		isError: true,
	}));
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	return connectMcpClient("demo", clientTransport);
}

describe("mcp", () => {
	it("bridges server tools and surfaces isError as a thrown error", async (t) => {
		const { client, tools } = await inMemoryTools();
		t.after(() => client.close());
		assert.deepEqual(tools.map((tool) => tool.name).sort(), ["demo__add", "demo__boom"]);
		const add = tools.find((tool) => tool.name === "demo__add")!;
		assert.equal((add.parameters as any).properties.a.type, "number");
		const result = await add.execute("1", { a: 2, b: 3 });
		assert.deepEqual(result.content, [{ type: "text", text: "5" }]);
		await assert.rejects(tools.find((tool) => tool.name === "demo__boom")!.execute("2", {}), /nope/);
	});

	it("load_tools reports addedToolNames and the transcript replays them", async (t) => {
		const { client, tools } = await inMemoryTools();
		t.after(() => client.close());
		const loaded: string[] = [];
		const loadTools = createLoadToolsTool(tools, (added) => loaded.push(...added.map((tool) => tool.name)));
		const byQuery = await loadTools.execute("1", { query: "numbers" });
		assert.deepEqual(byQuery.addedToolNames, ["demo__add"]);
		assert.deepEqual(loaded, ["demo__add"]);
		const byName = await loadTools.execute("2", { names: ["demo__boom"] });
		assert.deepEqual(byName.addedToolNames, ["demo__boom"]);
		const none = await loadTools.execute("3", { query: "teapot" });
		assert.equal(none.addedToolNames, undefined);
		assert.deepEqual(
			[
				...loadedToolNames([
					{ role: "toolResult", toolCallId: "1", toolName: "load_tools", content: [], isError: false, timestamp: 0, addedToolNames: ["demo__add"] },
					{ role: "user", content: "hi", timestamp: 0 },
				] as any),
			],
			["demo__add"],
		);
	});

	it("drops a loaded deferred tool once its marker and calls are condensed away", async (t) => {
		const { client, tools } = await inMemoryTools();
		t.after(() => client.close());
		const base = { name: "bash", description: "", parameters: {} as any };
		const add = tools.find((tool) => tool.name === "demo__add")!;
		const marker = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "load_tools",
			content: [],
			isError: false,
			timestamp: 0,
			addedToolNames: ["demo__add"],
		};
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "2", name: "demo__add", arguments: {} }],
			stopReason: "toolUse",
			timestamp: 0,
		};
		const names = (messages: unknown[]) =>
			pruneCondensedTools({ messages: messages as any, tools: [base, add] }, tools).map((tool) => tool.name);
		assert.deepEqual(names([marker]), ["bash", "demo__add"]);
		assert.deepEqual(names([call]), ["bash", "demo__add"]);
		assert.deepEqual(names([{ role: "user", content: "summary", timestamp: 0 }]), ["bash"]);
	});

	it("parses [mcp.servers] and rejects ambiguous transports", async (t) => {
		await withDiscordToken(async () => {
			const workspace = await createWorkspace(
				t,
				minimalConfigToml(`
[mcp.servers.fs]
command = "npx"
args = ["-y", "server"]
[mcp.servers.remote]
url = "https://example.com/mcp"
deferred = false
`),
			);
			const config = await loadConfig(workspace);
			assert.equal(config.mcp.servers.fs.deferred, true);
			assert.deepEqual(config.mcp.servers.fs.args, ["-y", "server"]);
			assert.equal(config.mcp.servers.remote.deferred, false);
			const bad = await createWorkspace(t, minimalConfigToml(`[mcp.servers.x]\ncommand = "a"\nurl = "http://b"\n`));
			await assert.rejects(loadConfig(bad), /exactly one of command or url/);
		});
	});
});
