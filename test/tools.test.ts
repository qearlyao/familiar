import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFamiliarTools, deferredToolNames, type ToolContext, toolReach } from "../src/agent/tools.js";
import { BUILTIN_TOOLS } from "../src/config/enums.js";
import type { Config } from "../src/config/index.js";
import type { McpHub } from "../src/tools/mcp.js";
import { configWithDataDir, createTempDataDir, stubMemoryService } from "./helpers.js";

const tool = (name: string): AgentTool<any> => ({
	name,
	label: name,
	description: name, parameters: {} as any, execute: async () => ({ content: [], details: undefined }) });
const hub = (deferred: AgentTool<any>[] = []) => ({ tools: [], deferred }) as unknown as McpHub;
const noMedia = { drain() {}, take: () => [] } as any;
const emptyAgent = () => ({ state: { messages: [], tools: [] } }) as any;
const context = (config: Config, overrides: Partial<ToolContext> = {}): ToolContext => ({
	config,
	mediaSink: noMedia,
	referenceAttachments: () => [],
	memory: stubMemoryService(),
	mcp: hub(),
	agent: emptyAgent,
	paused: new Set(),
	...overrides,
});

describe("built-in tool reach", () => {
	it("pins by default, and a pause outranks the lasting reach", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		config.tools.reach = { browser: "loadable", tts: "off" };
		const paused = new Set(["bash"]);
		assert.equal(toolReach(config, paused, "read"), "pinned");
		assert.equal(toolReach(config, paused, "browser"), "loadable");
		assert.equal(toolReach(config, paused, "tts"), "off");
		assert.equal(toolReach(config, paused, "bash"), "off");
		assert.deepEqual([...deferredToolNames(config, hub([tool("demo__add")]), paused)], ["browser", "demo__add"]);
	});

	it("declares pinned tools, hides loadable ones behind load_tools, and drops the rest", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t), { imageGen: { enabled: false } });
		config.tools.reach = { search_web: "loadable", tts: "off" };
		const names = createFamiliarTools(context(config, { paused: new Set(["fetch_web"]) })).map((t) => t.name);
		assert.ok(names.includes("bash"));
		assert.ok(names.includes("load_tools"));
		for (const hidden of ["search_web", "tts", "fetch_web"]) assert.ok(!names.includes(hidden), hidden);

		const loaded = () =>
			({ state: { tools: [], messages: [{ role: "system", content: "", toolsAdded: [{ name: "search_web", description: "", parameters: {} }], timestamp: 0 }] } }) as any;
		assert.ok(createFamiliarTools(context(config, { agent: loaded })).some((t) => t.name === "search_web"));

		const everything = createFamiliarTools(context({ ...config, tools: { reach: {} } })).map((t) => t.name);
		assert.ok(!everything.includes("load_tools"));
	});
});

describe("built-in tool registry", () => {
	it("builds exactly the tools BUILTIN_TOOLS names", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t), {
			imageGen: { enabled: true },
			browser: { enabled: true },
		});
		const memory = stubMemoryService({ memoryTools: () => [tool("memory_recall"), tool("memory_open")] });
		const names = createFamiliarTools(context({ ...config, tools: { reach: {} } }, { memory })).map((t) => t.name);
		assert.deepEqual([...names].sort(), [...BUILTIN_TOOLS].sort());
	});
});
