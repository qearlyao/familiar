import type { Config } from "../config/index.js";
import { interpolateValue } from "../config/interpolate.js";
import type { McpServerConfig } from "../config/types.js";
import { jsonSettingsStore } from "../util/fs.js";

export type McpSource = "config" | "web";

/**
 * Servers added from the WebUI, plus deferred flips on config.toml servers (stored as just
 * `{ deferred }` under that server's name). Values keep `${NAME}` raw; they resolve at connect.
 */
export type WebMcpServers = Record<string, Partial<McpServerConfig>>;

const store = jsonSettingsStore("mcp-servers.json", (raw) => ({
	servers: (raw as { servers?: WebMcpServers } | undefined)?.servers ?? {},
}));

export const setMcpServersPath = store.setDataDir;

export function loadWebMcpServers(): WebMcpServers {
	return { ...store.load().servers };
}

export function saveWebMcpServers(servers: WebMcpServers): Promise<void> {
	return store.save({ servers });
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
