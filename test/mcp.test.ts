import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

import { loadConfig } from "../src/config/index.js";
import { createCodemodeDescription, createCodemodeTool } from "../src/tools/codemode.js";
import {
	connectMcpClient,
	createMcpHub,
	createMcpToolName,
	dropOrphanToolRemovals,
	loadedToolNames,
	pruneCondensedTools,
} from "../src/tools/mcp.js";
import { mcpServerSpecs, saveWebMcpServers, setMcpServersPath } from "../src/tools/mcp-servers.js";
import { createToolSearchTool } from "../src/tools/tool-search.js";
import { configWithDataDir, createTempDataDir, createWorkspace, minimalConfigToml, withDiscordToken, withEnv } from "./helpers.js";

const demoTools = [
	{
		name: "add",
		description: "add two numbers",
		inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
	},
	{ name: "boom", description: "always fails", inputSchema: { type: "object" } },
];

// just enough of a server for the client: initialize, tools/list, tools/call
async function inMemoryTools() {
	const { client: clientTransport, server } = createInMemoryTransportPair();
	server.onMessage((message: any) => {
		if (message.id === undefined) return;
		const { a, b } = message.params?.arguments ?? {};
		const result =
			message.method === "initialize"
				? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "demo", version: "0" } }
				: message.method === "tools/list"
					? { tools: demoTools }
					: message.params.name === "add"
						? { content: [{ type: "text", text: String(a + b) }] }
						: { content: [{ type: "text", text: "nope" }], isError: true };
		void server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await server.start();
	return connectMcpClient("demo", clientTransport);
}

describe("mcp", () => {
	it("bridges server tools under pi's names and hands back the whole CallToolResult", async (t) => {
		const { client, tools } = await inMemoryTools();
		t.after(() => client.close());
		assert.deepEqual(tools.map((tool) => tool.name).sort(), ["mcp__demo__add", "mcp__demo__boom"]);
		const add = tools.find((tool) => tool.name === "mcp__demo__add")!;
		assert.equal((add.parameters as any).properties.a.type, "number");
		const result = await add.execute("1", { a: 2, b: 3 });
		assert.deepEqual(result.content, [{ type: "text", text: "5" }]);
		const boom = await tools.find((tool) => tool.name === "mcp__demo__boom")!.execute("2", {});
		assert.equal(boom.isError, true);
		assert.deepEqual(boom.structuredContent, { content: [{ type: "text", text: "nope" }], isError: true });
		const long = createMcpToolName("server", "x".repeat(80));
		assert.equal(long.length, 64);
		assert.notEqual(createMcpToolName("a", "b.c", (name) => name === "mcp__a__b_c"), "mcp__a__b_c");
	});

	it("codemode scripts call tools and only their output comes back", async (t) => {
		const { client, tools } = await inMemoryTools();
		t.after(() => client.close());
		const codemode = createCodemodeTool(tools);
		const result = await codemode.execute("1", {
			code: `const sums = await Promise.all([tools.mcp__demo__add({ a: 1, b: 2 }), tools.mcp__demo__add({ a: 3, b: 4 })]);
text("sums " + sums.map((sum) => sum.content[0].text).join(","));
const boom = await tools.mcp__demo__boom({});
text("boom " + boom.isError);
text((await searchTools("numbers"))[0].name);
return (await describeTool("mcp__demo__add")).includes("a?: number");`,
		});
		assert.equal(result.isError, undefined);
		assert.deepEqual(
			result.content.slice(1),
			["sums 3,7", "boom true", "mcp__demo__add", "true"].map((text) => ({ type: "text", text })),
		);
		const failed = await codemode.execute("2", { code: `text("before"); throw new Error("nope");` });
		assert.equal(failed.isError, true);
		const text = failed.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		assert.match(text, /Script failed[\s\S]*before[\s\S]*Script error:[\s\S]*nope/);
	});

	it("codemode lists tools within its budget, cheapest first per namespace", () => {
		const fake = (name: string, words: number) => ({
			name,
			label: name,
			description: "word ".repeat(words),
			parameters: { type: "object", properties: {} } as any,
			execute: async () => ({ content: [], details: undefined }),
		});
		const tools = [fake("mcp__big__a", 400), fake("mcp__big__b", 5), fake("mcp__small__c", 5), fake("mcp__small__d", 5)];
		const namespaceOf = (name: string) => ({ name: name.split("__")[1], description: `about ${name.split("__")[1]}` });
		const all = createCodemodeDescription(tools, { namespaceOf, inlineBudget: 10_000 });
		assert.match(all, /all 4 listed/);
		const tight = createCodemodeDescription(tools, { namespaceOf, inlineBudget: 200, deferred: new Set(["mcp__small__d"]) });
		assert.match(tight, /2 of 4 listed/);
		assert.match(tight, /## big \(2 tools, 1 shown\)\nabout big/);
		assert.match(tight, /## small \(2 tools, 1 shown\)/);
		assert.match(tight, /mcp__big__b/);
		assert.doesNotMatch(tight, /### `mcp__big__a`/);
		assert.match(tight, /searchTools\(query\)/);
	});

	it("tool_search loads BM25 matches it isn't already holding", async (t) => {
		const { client, tools } = await inMemoryTools();
		t.after(() => client.close());
		const held = new Set<string>();
		const search = createToolSearchTool(tools, () => ({ name: "demo" }), () => held, (added) => {
			for (const tool of added) held.add(tool.name);
		});
		assert.match(search.description, /- demo/);
		await search.execute("1", { query: "add numbers" });
		assert.deepEqual([...held], ["mcp__demo__add"]);
		const again = await search.execute("2", { query: "numbers" });
		assert.deepEqual(again.content, [{ type: "text", text: "nothing matched." }]);
		await search.execute("3", { query: "fails" });
		assert.deepEqual([...held], ["mcp__demo__add", "mcp__demo__boom"]);
		assert.deepEqual(
			[
				...loadedToolNames([
					{ role: "system", content: "", toolsAdded: [{ name: "mcp__demo__add", description: "", parameters: {} }], timestamp: 0 },
					{ role: "user", content: "hi", timestamp: 0 },
					{ role: "system", content: "", toolsRemoved: [{ name: "mcp__demo__add" }], toolsAdded: [{ name: "mcp__demo__boom", description: "", parameters: {} }], timestamp: 1 },
				] as any),
			],
			["mcp__demo__boom"],
		);
	});

	it("drops a loaded deferred tool once the transcript no longer declares it", async (t) => {
		const { client, tools } = await inMemoryTools();
		t.after(() => client.close());
		const base = { name: "bash", description: "", parameters: {} as any };
		const add = tools.find((tool) => tool.name === "mcp__demo__add")!;
		const declared = { role: "system", content: "", toolsAdded: [add], timestamp: 0 };
		const names = (messages: unknown[]) => {
			const agent = { state: { tools: [base, add] } } as any;
			pruneCondensedTools(agent, messages as any, new Set(tools.map((tool) => tool.name)));
			return agent.state.tools.map((tool: { name: string }) => tool.name);
		};
		assert.deepEqual(names([declared]), ["bash", "mcp__demo__add"]);
		assert.deepEqual(names([{ role: "user", content: "summary", timestamp: 0 }]), ["bash"]);
	});

	it("drops tool removals whose declaration was condensed away", () => {
		const tool = (name: string) => ({ name, description: "", parameters: {} });
		const head = { role: "system", content: "prompt", toolsAdded: [tool("bash"), tool("tool_search")], timestamp: 0 };
		const summary = { role: "assistant", content: [{ type: "text", text: "<from_earlier>" }], timestamp: 1 };
		const reload = { role: "system", content: "", toolsRemoved: [{ name: "tool_search" }], toolsAdded: [tool("tool_search")], timestamp: 2 };
		const orphan = { role: "system", content: "", toolsRemoved: [{ name: "browser" }], timestamp: 3 };
		const mixed = { role: "system", content: "", toolsRemoved: [{ name: "browser" }, { name: "bash" }], timestamp: 4 };
		const out = dropOrphanToolRemovals([head, summary, reload, orphan, mixed] as any) as any[];
		assert.deepEqual(out.slice(0, 3), [head, summary, reload]);
		assert.deepEqual(out[3].toolsRemoved, []);
		assert.deepEqual(out[4].toolsRemoved, [{ name: "bash" }]);
		assert.deepEqual(mixed.toolsRemoved, [{ name: "browser" }, { name: "bash" }]);
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
exposure = "direct"
`),
			);
			const config = await loadConfig(workspace);
			assert.equal(config.mcp.servers.fs.exposure, "codemode");
			assert.deepEqual(config.mcp.servers.fs.args, ["-y", "server"]);
			assert.equal(config.mcp.servers.remote.exposure, "direct");
			const wrong = await createWorkspace(t, minimalConfigToml(`[mcp.servers.x]\ncommand = "a"\nexposure = "lazy"\n`));
			await assert.rejects(loadConfig(wrong), /exposure/);
			const bad = await createWorkspace(t, minimalConfigToml(`[mcp.servers.x]\ncommand = "a"\nurl = "http://b"\n`));
			await assert.rejects(loadConfig(bad), /exactly one of command or url/);
		});
	});

	it("layers web servers over config.toml and syncs the hub without reconnecting on an exposure flip", async (t) => {
		const dataDir = await createTempDataDir(t);
		const config = await configWithDataDir(t, dataDir, {
			mcp: { servers: { fs: { command: "/nonexistent-mcp-server", exposure: "codemode", enabled: true } } },
		});
		setMcpServersPath(dataDir);
		await saveWebMcpServers({
				fs: { exposure: "direct" },
				remote: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}" }, exposure: "deferred" },
				gone: { exposure: "direct" },
			});
		const specs = await withEnv("MCP_TEST_TOKEN", "sekrit", async () => mcpServerSpecs(config));
		assert.deepEqual(Object.keys(specs).sort(), ["fs", "remote"]);
		assert.equal(specs.fs.source, "config");
		assert.equal(specs.fs.spec.exposure, "direct");
		assert.equal(specs.remote.source, "web");
		assert.equal(specs.remote.spec.headers?.Authorization, "Bearer sekrit");
		assert.equal(specs.remote.spec.enabled, true);

		let changes = 0;
		const hub = createMcpHub(() => {
			changes++;
		});
		t.after(() => hub.close());
		await hub.sync({ fs: specs.fs });
		const failed = hub.servers()[0];
		assert.equal(failed.status, "failed");
		assert.ok(failed.error);
		await hub.sync({ fs: { ...specs.fs, spec: { ...specs.fs.spec, exposure: "deferred" } } });
		assert.equal(hub.servers()[0].error, failed.error);
		assert.equal(hub.servers()[0].spec.exposure, "deferred");
		// switched off it stays listed, holds no tools and opens nothing
		await hub.sync({ fs: { ...specs.fs, spec: { ...specs.fs.spec, enabled: false } } });
		assert.equal(hub.servers()[0].spec.enabled, false);
		assert.deepEqual(hub.tools("direct"), []);
		assert.deepEqual(hub.tools("deferred"), []);
		await hub.sync({ fs: { ...specs.fs, spec: { ...specs.fs.spec, enabled: true } } });
		assert.equal(hub.servers()[0].status, "failed");
		await hub.sync({});
		assert.deepEqual(hub.servers(), []);
		assert.equal(changes, 5);
	});
});
