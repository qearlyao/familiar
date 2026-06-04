import { getProviders } from "@earendil-works/pi-ai";
import type { FamiliarAgent } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import { addModel, loadAddedModels, removeModel } from "../models/added-models.js";
import { type ModelRef, PROVIDER_DEFAULTS, parseModelRef } from "../models/index.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { isRecord } from "../util/guards.js";
import { errorMessage } from "./errors.js";
import type { WebEventHub } from "./event-hub.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { agentSettingsPayload } from "./payloads.js";
import { getChannelKeyFromRequest } from "./route-helpers.js";
import type { RegisterWebRoute } from "./routes.js";

type RuntimeResolver = (channelKey?: string) => Promise<ConversationRuntime>;

interface RegisterWebAgentRoutesOptions {
	route: RegisterWebRoute;
	config: Config;
	familiarAgent: FamiliarAgent;
	getRuntime: RuntimeResolver;
	personaName: string;
	publish: WebEventHub["publish"];
}

function agentModelsPayload(config: Config): { models: string[]; added: string[] } {
	const models: string[] = [];
	const added: string[] = [];
	const seen = new Set<string>();
	for (const model of config.models.allow) {
		if (seen.has(model)) continue;
		seen.add(model);
		models.push(model);
	}
	for (const model of loadAddedModels()) {
		if (seen.has(model)) continue;
		seen.add(model);
		models.push(model);
		added.push(model);
	}
	return { models, added };
}

function parseRequestedModel(value: unknown): { model: string; ref: ModelRef } {
	if (typeof value !== "string") throw new HttpError(400, "format must be provider/model-id");
	const ref = parseModelRef(value);
	if (!ref) throw new HttpError(400, "format must be provider/model-id");
	return { model: ref.key, ref };
}

export function registerWebAgentRoutes(options: RegisterWebAgentRoutesOptions): void {
	const { route, config, familiarAgent, getRuntime, personaName, publish } = options;

	route("GET", "/api/web/agent/settings", async (_request, response, url) => {
		const runtime = await getRuntime(getChannelKeyFromRequest(url));
		sendJson(response, 200, agentSettingsPayload(familiarAgent, runtime.channelKey, personaName));
	});
	route("GET", "/api/web/agent/models", async (_request, response) => {
		sendJson(response, 200, agentModelsPayload(config));
	});
	route("POST", "/api/web/agent/models", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body)) {
			throw new HttpError(400, "body is required");
		}
		const parsed = parseRequestedModel(body.model);
		if (
			!Object.hasOwn(PROVIDER_DEFAULTS, parsed.ref.provider) &&
			!getProviders().includes(parsed.ref.provider as never)
		) {
			throw new HttpError(400, `unsupported provider: ${parsed.ref.provider}`);
		}
		if (config.models.allow.includes(parsed.model) || loadAddedModels().includes(parsed.model)) {
			sendJson(response, 200, agentModelsPayload(config));
			return;
		}
		await addModel(parsed.model);
		sendJson(response, 200, agentModelsPayload(config));
	});
	route("DELETE", "/api/web/agent/models", async (request, response) => {
		const body = await readJsonBody(request);
		if (!isRecord(body)) {
			throw new HttpError(400, "body is required");
		}
		const parsed = parseRequestedModel(body.model);
		if (!loadAddedModels().includes(parsed.model)) {
			throw new HttpError(400, "model is not user-added");
		}
		await removeModel(parsed.model);
		sendJson(response, 200, agentModelsPayload(config));
	});
	route("POST", "/api/web/agent/settings", async (request, response, url) => {
		const body = await readJsonBody(request);
		const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
		if (!isRecord(body)) {
			throw new HttpError(400, "body is required");
		}
		try {
			if (typeof body.model === "string") await familiarAgent.setModel(runtime.channelKey, body.model);
			if (typeof body.thinking === "string") await familiarAgent.setThinkingLevel(runtime.channelKey, body.thinking);
		} catch (error) {
			throw new HttpError(400, errorMessage(error));
		}
		sendJson(response, 200, agentSettingsPayload(familiarAgent, runtime.channelKey, personaName));
	});
	route("POST", "/api/web/agent/new", async (request, response, url) => {
		const body = await readJsonBody(request);
		const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
		await familiarAgent.reset(runtime.channelKey);
		await runtime.resetConversation("new conversation requested from web");
		publish({
			type: "status",
			channelKey: runtime.channelKey,
			kind: "idle",
			detail: "started fresh from web",
		});
		sendJson(response, 200, { ok: true });
	});
}
