import type { FamiliarAgent } from "../agent/factory.js";
import { MCP_EXPOSURES } from "../config/enums.js";
import { type Config, readMcpServers } from "../config/index.js";
import { loadWebMcpServers, mcpServerSpecs, saveWebMcpServers } from "../tools/mcp-servers.js";
import { isRecord } from "../util/guards.js";
import { errorMessage } from "./errors.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { getChannelKeyFromRequest } from "./route-helpers.js";
import type { RegisterWebRoute } from "./routes.js";

type RuntimeResolver = (channelKey?: string) => Promise<{ channelKey: string }>;

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

export function registerWebMcpRoutes(
	route: RegisterWebRoute,
	config: Config,
	familiarAgent: FamiliarAgent,
	getRuntime: RuntimeResolver,
): void {
	const { mcp } = familiarAgent;

	const payload = async (url: URL) => {
		const { channelKey } = await getRuntime(getChannelKeyFromRequest(url));
		const held = new Set(await familiarAgent.toolNames(channelKey));
		const web = loadWebMcpServers();
		const servers = mcp
			.servers()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((server) => {
				// what's shown keeps ${NAME} unresolved for servers added here, so secrets never reach the page
				const spec = server.source === "web" ? { ...server.spec, ...web[server.name] } : server.spec;
				return {
					name: server.name,
					source: server.source,
					transport: spec.url ? "http" : "stdio",
					where: spec.url ?? [spec.command, ...(spec.args ?? [])].join(" "),
					headers: Object.keys(spec.headers ?? {}).length,
					exposure: server.spec.exposure,
					enabled: server.spec.enabled,
					status: server.status,
					error: server.error,
					tools: server.tools.map((tool) => ({
						name: tool.name.replace(`mcp__${server.name}__`, ""),
						description: tool.description,
						loaded: server.spec.exposure !== "direct" && held.has(tool.name),
					})),
				};
			});
		return { servers };
	};

	const serverName = (body: unknown): string => {
		if (!isRecord(body) || typeof body.name !== "string") throw new HttpError(400, "name is required");
		return body.name;
	};

	const save = async (next: ReturnType<typeof loadWebMcpServers>) => {
		await saveWebMcpServers(next);
		await mcp.sync(mcpServerSpecs(config));
	};

	route("GET", "/api/web/mcp", async (_request, response, url) => {
		sendJson(response, 200, await payload(url));
	});

	route("POST", "/api/web/mcp", async (request, response, url) => {
		const body = await readJsonBody(request);
		const name = serverName(body);
		if (!SERVER_NAME.test(name)) throw new HttpError(400, "name may use letters, digits, - and _ (up to 32)");
		if (mcp.servers().some((server) => server.name === name)) throw new HttpError(400, `${name} is already here`);
		const { name: _name, ...raw } = body as Record<string, unknown>;
		let spec: ReturnType<typeof loadWebMcpServers>[string];
		try {
			spec = readMcpServers({ [name]: raw })[name]!;
		} catch (error) {
			throw new HttpError(400, errorMessage(error));
		}
		await save({ ...loadWebMcpServers(), [name]: spec });
		sendJson(response, 200, await payload(url));
	});

	route("DELETE", "/api/web/mcp", async (request, response, url) => {
		const name = serverName(await readJsonBody(request));
		if (config.mcp.servers[name]) throw new HttpError(400, `${name} lives in config.toml`);
		const next = loadWebMcpServers();
		delete next[name];
		await save(next);
		sendJson(response, 200, await payload(url));
	});

	// exposure and enabled are the two flips a config.toml server can keep here
	const flips = {
		exposure: (value: unknown) => typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value),
		enabled: (value: unknown) => typeof value === "boolean",
	};
	for (const [flag, valid] of Object.entries(flips)) {
		route("POST", `/api/web/mcp/${flag}`, async (request, response, url) => {
			const body = await readJsonBody(request);
			const name = serverName(body);
			const value = (body as Record<string, unknown>)[flag];
			if (!valid(value)) throw new HttpError(400, `${flag} can't be ${JSON.stringify(value)}`);
			const web = loadWebMcpServers();
			if (!web[name] && !config.mcp.servers[name]) throw new HttpError(404, `no mcp server named ${name}`);
			await save({ ...web, [name]: { ...web[name], [flag]: value } });
			sendJson(response, 200, await payload(url));
		});
	}

	route("POST", "/api/web/mcp/reconnect", async (request, response, url) => {
		const name = serverName(await readJsonBody(request));
		try {
			await mcp.reconnect(name);
		} catch (error) {
			throw new HttpError(404, errorMessage(error));
		}
		sendJson(response, 200, await payload(url));
	});
}
