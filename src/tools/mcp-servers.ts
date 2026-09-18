import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Config } from "../config/index.js";
import { interpolateValue } from "../config/interpolate.js";
import type { McpServerConfig } from "../config/types.js";
import { atomicWriteJson, createWriteQueue, isEnoent } from "../util/fs.js";

export type McpSource = "config" | "web";

/**
 * Servers added from the WebUI, plus deferred flips on config.toml servers (stored as just
 * `{ deferred }` under that server's name). Values keep `${NAME}` raw; they resolve at connect.
 */
export type WebMcpServers = Record<string, Partial<McpServerConfig>>;

let path = resolve(process.cwd(), "data", "settings", "mcp-servers.json");
let cache: WebMcpServers | undefined;
const enqueueWrite = createWriteQueue("mcp servers");

export function setMcpServersPath(dataDir: string): void {
	path = resolve(dataDir, "settings", "mcp-servers.json");
	cache = undefined;
}

export function loadWebMcpServers(): WebMcpServers {
	if (!cache) {
		try {
			cache = (JSON.parse(readFileSync(path, "utf8")) as { servers?: WebMcpServers }).servers ?? {};
		} catch (error) {
			if (!isEnoent(error)) throw error;
			cache = {};
		}
	}
	return { ...cache };
}

export async function saveWebMcpServers(servers: WebMcpServers): Promise<void> {
	cache = servers;
	await enqueueWrite(() => atomicWriteJson(path, { servers }));
}

export function mcpServerSpecs(config: Config): Record<string, { spec: McpServerConfig; source: McpSource }> {
	const specs: Record<string, { spec: McpServerConfig; source: McpSource }> = {};
	for (const [name, spec] of Object.entries(config.mcp.servers)) specs[name] = { spec, source: "config" };
	for (const [name, raw] of Object.entries(loadWebMcpServers())) {
		const base = specs[name];
		if (base) base.spec = { ...base.spec, deferred: raw.deferred ?? base.spec.deferred };
		// a deferred flip whose config.toml server has since gone is left inert
		else if (raw.command || raw.url) specs[name] = { spec: interpolateValue(raw) as McpServerConfig, source: "web" };
	}
	return specs;
}
