import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFamiliarTools, deferredToolNames, toolReach } from "../src/agent/tools.js";
import type { McpHub } from "../src/tools/mcp.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

const tool = (name: string): AgentTool<any> => ({
	name,
	label: name,
	description: name, parameters: {} as any, execute: async () => ({ content: [], details: undefined }) });
const hub = (deferred: AgentTool<any>[] = []) => ({ tools: [], deferred }) as unknown as McpHub;
const noMedia = { drain() {}, take: () => [] } as any;

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
		const agent = () => ({ state: { messages: [], tools: [] } }) as any;
		const names = createFamiliarTools(config, noMedia, undefined, undefined, hub(), agent, new Set(["fetch_web"])).map((t) => t.name);
		assert.ok(names.includes("bash"));
		assert.ok(names.includes("load_tools"));
		for (const hidden of ["search_web", "tts", "fetch_web"]) assert.ok(!names.includes(hidden), hidden);

		const loaded = () =>
			({ state: { tools: [], messages: [{ role: "system", content: "", toolsAdded: [{ name: "search_web", description: "", parameters: {} }], timestamp: 0 }] } }) as any;
		assert.ok(createFamiliarTools(config, noMedia, undefined, undefined, hub(), loaded, new Set()).some((t) => t.name === "search_web"));

		const everything = createFamiliarTools({ ...config, tools: { reach: {} } }, noMedia, undefined, undefined, hub(), agent).map((t) => t.name);
		assert.ok(!everything.includes("load_tools"));
	});
});
