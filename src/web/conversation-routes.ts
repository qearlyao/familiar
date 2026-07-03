import { readFile } from "node:fs/promises";

import type { FamiliarAgent } from "../agent/factory.js";
import type { Config, WebAuthMode } from "../config/index.js";
import { getContactNickname } from "../conversation/contact-note.js";
import { messageId } from "../conversation/ids.js";
import { materializeInboundAttachments } from "../media/inbound-attachments.js";
import type { AgentCore } from "../runtime/agent-core.js";
import type { ConversationRuntime, InboundMessageInput } from "../runtime/conversation-runtime.js";
import { isRecord } from "../util/guards.js";
import type { WebAuth } from "./auth.js";
import { requestAuthContext, sessionCookie, verifyTotp } from "./auth.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { memeCatalogPath, parseMemeCatalog } from "./memes.js";
import { webHistoryPayload } from "./messages.js";
import {
	isMultipartContentType,
	isWebUploadAttachment,
	readMultipartBody,
	type WebUploadAttachment,
} from "./multipart.js";
import { commandArgs, lastContextTokens, sessionDto } from "./payloads.js";
import { getChannelKeyFromRequest } from "./route-helpers.js";
import type { RegisterWebRoute } from "./routes.js";
import type { WebRuntimeActions } from "./runtime-actions.js";
import { WEB_USER_NAME } from "./types.js";

type RuntimeResolver = (channelKey?: string) => Promise<ConversationRuntime>;

interface RegisterWebConversationRoutesOptions {
	route: RegisterWebRoute;
	config: Config;
	auth: WebAuth;
	authMode: WebAuthMode;
	agentCore: AgentCore;
	getRuntime: RuntimeResolver;
	personaName: string;
	actions: WebRuntimeActions;
	familiarAgent: Pick<FamiliarAgent, "steer" | "resolveChannelModel">;
}

export function registerWebConversationRoutes(options: RegisterWebConversationRoutesOptions): void {
	const { route, config, auth, authMode, agentCore, getRuntime, personaName, actions, familiarAgent } = options;

	route("GET", "/api/web/sessions", async (_request, response) => {
		if (!agentCore.hasSessionSource()) {
			sendJson(response, 200, { sessions: [] });
			return;
		}
		const sessions = await agentCore.getWebSessions();
		const payload = await Promise.all(
			sessions.map(async (session) => {
				// ponytail: peek only — sessions with no live runtime just omit the context ring
				const runtime = await agentCore.peekRuntime(session.key);
				const tokens = runtime ? lastContextTokens(runtime.getRecords()) : undefined;
				const context =
					tokens === undefined
						? undefined
						: { tokens, limit: familiarAgent.resolveChannelModel(session.key).model.contextWindow ?? 200_000 };
				return sessionDto(session, context);
			}),
		);
		sendJson(response, 200, { sessions: payload });
	});
	route("GET", "/api/web/history", async (_request, response, url) => {
		const runtime = await getRuntime(getChannelKeyFromRequest(url));
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
		const before = url.searchParams.get("before") ?? undefined;
		sendJson(
			response,
			200,
			webHistoryPayload(config, runtime.getRecords(), personaName, runtime.channelKey, { limit, before }),
		);
	});
	route("GET", "/api/web/memes", async (_request, response) => {
		try {
			const markdown = await readFile(memeCatalogPath(config), "utf8");
			sendJson(response, 200, { families: parseMemeCatalog(markdown) });
		} catch {
			sendJson(response, 500, { error: "memes catalog unavailable" });
		}
	});
	route("POST", "/api/web/send", async (request, response, url) => {
		const contentType = request.headers["content-type"] ?? "";
		const isMultipart = isMultipartContentType(contentType);
		const body = isMultipart ? await readMultipartBody(request, contentType) : await readJsonBody(request);
		const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
		if (!isRecord(body) || typeof body.text !== "string") {
			throw new HttpError(400, "text is required");
		}
		if (!isMultipart && isRecord(body) && Array.isArray(body.attachments) && body.attachments.length > 0) {
			throw new HttpError(400, "attachments require multipart form data");
		}
		const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
		const attachments = await materializeInboundAttachments(
			config,
			rawAttachments
				.filter((attachment): attachment is WebUploadAttachment => isWebUploadAttachment(attachment))
				.map((attachment) => ({ ...attachment, source: "web" })),
		);
		if (!body.text.trim() && attachments.length === 0) {
			throw new HttpError(400, "text or attachment is required");
		}
		const id = messageId("user");
		const ts = Date.now();
		const input: InboundMessageInput = {
			messageId: id,
			authorId: config.discord.ownerId,
			authorName: getContactNickname(WEB_USER_NAME),
			text: body.text,
			isBot: false,
			mentionedBot: true,
			remoteTimestamp: new Date(ts).toISOString(),
			checkpoint: { messageId: id },
			attachments,
		};
		const shouldTrySteer =
			config.discord.dmMode === "steer" &&
			runtime.channel.scope === "dm" &&
			runtime.hasActiveJob() &&
			agentCore.activeOwner === runtime.channelKey;
		const { record } = await runtime.ingestInbound(input, { mode: shouldTrySteer ? "collect" : "queue" });
		if (shouldTrySteer) {
			if (runtime.hasActiveJob() && agentCore.activeOwner === runtime.channelKey) {
				familiarAgent.steer(runtime.channelKey, runtime.buildSteerPromptForRecord(record));
			} else {
				await runtime.queueLatestTrigger();
				void actions.drainJobs(runtime).catch((error) => console.error("Web job drain failed", error));
			}
			sendJson(response, 200, { id, ts, channelKey: runtime.channelKey });
			return;
		}
		void actions.drainJobs(runtime).catch((error) => console.error("Web job drain failed", error));
		sendJson(response, 200, { id, ts, channelKey: runtime.channelKey });
	});
	route("POST", "/api/web/retry", async (request, response, url) => {
		const body = await readJsonBody(request);
		const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
		void actions.retryLatestAssistant(runtime).catch((error) => console.error("Web retry failed", error));
		sendJson(response, 200, { ok: true, channelKey: runtime.channelKey });
	});
	route("POST", "/api/web/delete", async (request, response, url) => {
		const body = await readJsonBody(request);
		const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
		void actions.deleteLatestAssistant(runtime).catch((error) => console.error("Web delete failed", error));
		sendJson(response, 200, { ok: true, channelKey: runtime.channelKey });
	});
	route("POST", "/api/web/edit", async (request, response, url) => {
		const body = await readJsonBody(request);
		const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
		if (!isRecord(body) || typeof body.text !== "string") {
			throw new HttpError(400, "text is required");
		}
		await actions.editLatestAssistant(runtime, body.text);
		sendJson(response, 200, { ok: true, channelKey: runtime.channelKey });
	});
	route("POST", "/api/web/control", async (request, response, url) => {
		const body = await readJsonBody(request);
		const runtime = await getRuntime(getChannelKeyFromRequest(url, body));
		if (!isRecord(body) || typeof body.command !== "string") {
			throw new HttpError(400, "command is required");
		}
		if (authMode === "public-2fa" && body.command === "login") {
			const token = isRecord(body.args) && typeof body.args.token === "string" ? body.args.token : "";
			if (!config.web.totpSecret || !verifyTotp(config.web.totpSecret, token)) {
				sendJson(response, 401, { ok: false, message: "Invalid TOTP token." });
				return;
			}
			const session = await auth.createSession(request, "2fa login");
			sendJson(
				response,
				200,
				{ ok: true, message: "Authenticated.", device: session.device },
				{ "set-cookie": sessionCookie(session.token, requestAuthContext(request).secure) },
			);
			return;
		}
		const args = commandArgs(body.command, body.args);
		const input: InboundMessageInput = {
			messageId: messageId("control"),
			authorId: config.discord.ownerId,
			authorName: getContactNickname(WEB_USER_NAME),
			text: `/${body.command}${args ? ` ${args}` : ""}`,
			isBot: false,
			mentionedBot: true,
			remoteTimestamp: new Date().toISOString(),
		};
		const control = runtime.parseControlCommand(input);
		if (!control) {
			sendJson(response, 400, { ok: false, message: "Unsupported command." });
			return;
		}
		await runtime.noteControlCommand(input, control);
		const message = await actions.applyControlCommand(runtime, control);
		await runtime.noteOutbound({ text: message, messageIds: [], control: control.command });
		sendJson(response, 200, { ok: true, message, channelKey: runtime.channelKey });
	});
}
