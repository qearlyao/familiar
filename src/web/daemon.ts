import { createServer } from "node:http";

import type { FamiliarAgent } from "../agent/factory.js";
import type { Config, WebAuthMode } from "../config/index.js";
import { refreshContactNote, setContactNotePath } from "../conversation/contact-note.js";
import type { RestartHandler } from "../lifecycle/control.js";
import { setAddedModelsPath } from "../models/added-models.js";
import { loadPersona, parsePersonaName } from "../prompting/persona.js";
import type { AgentCore } from "../runtime/agent-core.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { registerWebAgentRoutes } from "./agent-routes.js";
import { createAuth, loadWebSessionStore } from "./auth.js";
import { registerWebAuthRoutes } from "./auth-routes.js";
import { registerWebConfigRoutes } from "./config-routes.js";
import { registerWebConversationRoutes } from "./conversation-routes.js";
import { registerWebDiaryRoutes } from "./diary-routes.js";
import { createWebEventHub } from "./event-hub.js";
import { registerWebFileRoutes } from "./file-routes.js";
import { registerWebGalleryRoutes } from "./gallery-routes.js";
import { HttpError, sendText } from "./http.js";
import { createWebRouteRegistry } from "./routes.js";
import { createWebRuntimeActions } from "./runtime-actions.js";
import { registerWebSkillRoutes } from "./skill-routes.js";
import { serveStatic } from "./static.js";
import { attachWebSocketStream } from "./stream.js";
import type { WebDaemon } from "./types.js";

export async function startWebDaemon(
	config: Config,
	familiarAgent: FamiliarAgent,
	agentCore: AgentCore,
	options: { restart?: RestartHandler } = {},
): Promise<WebDaemon> {
	setAddedModelsPath(config.workspace.dataDir);
	setContactNotePath(config.persona.contact);
	await refreshContactNote();
	const persona = await loadPersona(config);
	const personaName = parsePersonaName(persona.soul);
	const webSessions = await loadWebSessionStore(config);
	const auth = createAuth(config, webSessions);
	const eventHub = createWebEventHub(config, personaName);

	const getRuntime = async (channelKey?: string): Promise<ConversationRuntime> => {
		if (!agentCore.hasSessionSource()) throw new HttpError(503, "Owner identity is not established yet.");
		const runtime = await agentCore.getRuntimeForWebChannel(channelKey);
		eventHub.subscribeRuntime(runtime);
		return runtime;
	};

	const subscribeKnownRuntimes = async (): Promise<void> => {
		if (!agentCore.hasSessionSource()) return;
		const sessions = await agentCore.getWebSessions();
		await Promise.all(
			sessions.map(async (session) => {
				const runtime = await agentCore.getRuntimeForWebChannel(session.key);
				eventHub.subscribeRuntime(runtime);
			}),
		);
	};

	const { route, handleApi } = createWebRouteRegistry(config, auth);
	const actions = createWebRuntimeActions({
		config,
		familiarAgent,
		agentCore,
		eventHub,
		personaName,
		restart: options.restart,
	});

	registerWebAuthRoutes(route, auth, { authMode: config.web.authMode, personaName });
	registerWebConversationRoutes({
		route,
		config,
		auth,
		authMode: config.web.authMode,
		agentCore,
		getRuntime,
		personaName,
		actions,
	});
	registerWebAgentRoutes({
		route,
		config,
		familiarAgent,
		getRuntime,
		personaName,
		publish: eventHub.publish,
	});
	registerWebConfigRoutes(route, config, agentCore);
	registerWebDiaryRoutes(route, config);
	registerWebFileRoutes(route, config);
	registerWebGalleryRoutes(route, config);
	registerWebSkillRoutes(route, config);

	await subscribeKnownRuntimes();

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		void handleApi(request, response, url).then(async (handled) => {
			if (handled) return;
			if (await serveStatic(response, url.pathname)) return;
			sendText(response, 404, "Not found");
		});
	});

	attachWebSocketStream(server, {
		authorize: (request, pathname) => auth.authorize(request, pathname),
		eventHub,
		getRuntime,
		abort: (runtime) => familiarAgent.abort(runtime.channelKey),
		retry: actions.retryLatestAssistant,
		deleteLatest: actions.deleteLatestAssistant,
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(config.web.port, config.web.bindAddress, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	console.log(`Web side-door listening on http://${config.web.bindAddress}:${config.web.port}`);

	return {
		server,
		async stop(): Promise<void> {
			eventHub.stop();
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => (error ? rejectClose(error) : resolveClose()));
			});
		},
	};
}

export type { WebAuthMode, WebDaemon };
