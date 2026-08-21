import type { Config } from "../config/index.js";
import { loadConfigOverrides } from "../config/overrides.js";
import {
	CONFIG_KEYS,
	CONFIG_REGISTRY,
	type ConfigKey,
	clearConfigChange,
	commitConfigChange,
	isConfigKey,
} from "../config/registry.js";
import type { RestartHandler } from "../lifecycle/control.js";
import type { AgentCore } from "../runtime/agent-core.js";
import { isRecord } from "../util/guards.js";
import { errorMessage } from "./errors.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";

function configPayload(config: Config): {
	values: Record<ConfigKey, { value: unknown; source: "config" | "override" }>;
} {
	const overrides = loadConfigOverrides();
	const values = {} as Record<ConfigKey, { value: unknown; source: "config" | "override" }>;
	for (const key of CONFIG_KEYS) {
		const entry = CONFIG_REGISTRY[key];
		values[key] = {
			value: entry.read(config),
			source: key in overrides ? "override" : "config",
		};
	}
	return { values };
}

function configChangeFromBody(body: unknown): { key: ConfigKey; value: unknown } {
	if (!isRecord(body) || typeof body.key !== "string") {
		throw new HttpError(400, "key is required");
	}
	if (!isConfigKey(body.key)) {
		throw new HttpError(400, `unknown config key: ${body.key}`);
	}
	return { key: body.key, value: body.value };
}

export function registerWebConfigRoutes(
	route: RegisterWebRoute,
	config: Config,
	agentCore: AgentCore,
	restart?: RestartHandler,
): void {
	route("GET", "/api/web/config", async (_request, response) => {
		sendJson(response, 200, configPayload(config));
	});
	route("POST", "/api/web/config", async (request, response) => {
		const body = await readJsonBody(request);
		const { key, value } = configChangeFromBody(body);
		const entry = CONFIG_REGISTRY[key];
		try {
			const validated = entry.validate(value, config);
			await commitConfigChange(key, validated, { config, scheduler: agentCore });
			if (key === "discord.enabled" || key === "qq.enabled") await restart?.();
		} catch (error) {
			throw new HttpError(400, errorMessage(error));
		}
		sendJson(response, 200, configPayload(config));
	});
	route("DELETE", "/api/web/config", async (request, response) => {
		const body = await readJsonBody(request);
		const { key } = configChangeFromBody(body);
		try {
			await clearConfigChange(key, { config, scheduler: agentCore });
			if (key === "discord.enabled" || key === "qq.enabled") await restart?.();
		} catch (error) {
			throw new HttpError(400, errorMessage(error));
		}
		sendJson(response, 200, configPayload(config));
	});
}
