import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFamiliarTools, deferredToolNames, type ToolContext, toolReach, VOICE_CALL_SESSION_PREFIX } from "../src/agent/tools.js";
import { BUILTIN_TOOLS } from "../src/config/enums.js";
import type { Config } from "../src/config/index.js";
import type { McpHub } from "../src/tools/mcp.js";
import { configWithDataDir, createTempDataDir, stubMemoryService, withEnv } from "./helpers.js";

const tool = (name: string): AgentTool<any> => ({
	name,
	label: name,
	description: name, parameters: {} as any, execute: async () => ({ content: [], details: undefined }) });
const hub = (deferred: AgentTool<any>[] = []) =>
	({ tools: (exposure: string) => (exposure === "deferred" ? deferred : []), namespaceOf: () => undefined }) as unknown as McpHub;
const noMedia = { drain() {}, take: () => [] } as any;
const emptyAgent = () => ({ state: { messages: [], tools: [] } }) as any;
const context = (config: Config, overrides: Partial<ToolContext> = {}): ToolContext => ({
	config,
	sessionKey: "web",
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
		config.tools.reach = { search_web: "loadable", tts: "off" };
		const paused = new Set(["bash"]);
		assert.equal(toolReach(config, paused, "read"), "pinned");
		assert.equal(toolReach(config, paused, "search_web"), "loadable");
		assert.equal(toolReach(config, paused, "tts"), "off");
		assert.equal(toolReach(config, paused, "bash"), "off");
		assert.deepEqual([...deferredToolNames(config, hub([tool("mcp__demo__add")]), paused)], ["search_web", "mcp__demo__add"]);
	});

	it("declares pinned tools, hides loadable ones behind tool_search, and drops the rest", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t), { imageGen: { enabled: false } });
		config.tools.reach = { search_web: "loadable", tts: "off" };
		const names = createFamiliarTools(context(config, { paused: new Set(["fetch_web"]) })).map((t) => t.name);
		assert.ok(names.includes("bash"));
		assert.ok(names.includes("tool_search"));
		for (const hidden of ["search_web", "tts", "fetch_web"]) assert.ok(!names.includes(hidden), hidden);

		const loaded = () =>
			({ state: { tools: [], messages: [{ role: "system", content: "", toolsAdded: [{ name: "search_web", description: "", parameters: {} }], timestamp: 0 }] } }) as any;
		assert.ok(createFamiliarTools(context(config, { agent: loaded })).some((t) => t.name === "search_web"));

		const everything = createFamiliarTools(context({ ...config, tools: { reach: {} } })).map((t) => t.name);
		assert.ok(!everything.includes("tool_search"));
	});

	it("leaves codemode's mcp tools to codemode while it's pinned, and offers tool_search only the fetched ones", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t), { imageGen: { enabled: false } });
		const byExposure: Record<string, AgentTool<any>[]> = {
			codemode: [tool("mcp__browser__get_url")],
			deferred: [tool("mcp__docs__search")],
		};
		const mcp = { tools: (exposure: string) => byExposure[exposure] ?? [], namespaceOf: () => undefined } as unknown as McpHub;
		const search = (reach: Record<string, "pinned" | "loadable">) =>
			createFamiliarTools(context({ ...config, tools: { reach } }, { mcp })).find((t) => t.name === "tool_search")!;
		const pinned = search({});
		assert.match(pinned.description, /mcp__docs__search/);
		assert.doesNotMatch(pinned.description, /mcp__browser__get_url/);
		assert.match(search({ codemode: "loadable" }).description, /mcp__browser__get_url/);
	});
});

describe("voice call tools", () => {
	it("leaves tts out of a voice call's session, since its words are already spoken", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const names = (sessionKey: string) => createFamiliarTools(context(config, { sessionKey })).map((t) => t.name);
		assert.ok(names("web").includes("tts"));
		assert.ok(!names(`${VOICE_CALL_SESSION_PREFIX}call`).includes("tts"));
	});
});

describe("built-in tool registry", () => {
	it("builds exactly the tools BUILTIN_TOOLS names", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t), {
			imageGen: { enabled: true },
		});
		const memory = stubMemoryService({ memoryTools: () => [tool("memory_recall"), tool("memory_open")] });
		const names = createFamiliarTools(context({ ...config, tools: { reach: {} } }, { memory })).map((t) => t.name);
		assert.deepEqual([...names].sort(), [...BUILTIN_TOOLS].sort());
	});
});

describe("bash environment", () => {
	it("hides the workspace .env keys from bash, leaving ordinary variables", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		await writeFile(resolve(config.workspacePath, ".env"), "FAMILIAR_TEST_SECRET=sk-hidden\n", "utf8");
		const bash = createFamiliarTools(context(config)).find((t) => t.name === "bash")!;
		const result = await withEnv("FAMILIAR_TEST_SECRET", "sk-hidden", () =>
			bash.execute("call", { command: 'echo "${FAMILIAR_TEST_SECRET:-unset} ${HOME:+home}"' }),
		);
		assert.match(JSON.stringify(result.content), /unset home/);
	});
});
