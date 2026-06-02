import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import type { ConversationRuntime } from "../runtime.js";
import { isRecord } from "../util/guards.js";
import type { WebEventHub } from "./event-hub.js";
import { acceptWebSocket, decodeFrames, type WebSocketClient } from "./events.js";

type StreamAction = (runtime: ConversationRuntime) => Promise<void>;

export function attachWebSocketStream(
	server: Server,
	options: {
		authorize(request: IncomingMessage, pathname: string): boolean;
		eventHub: WebEventHub;
		getRuntime(channelKey?: string): Promise<ConversationRuntime>;
		abort: StreamAction;
		retry: StreamAction;
		deleteLatest: StreamAction;
	},
): void {
	const { authorize, eventHub, getRuntime, abort, retry, deleteLatest } = options;
	const runtimeActions: Record<string, StreamAction> = { abort, retry, delete: deleteLatest };

	const handleStreamMessage = (raw: string, client: WebSocketClient): void => {
		const message = JSON.parse(raw) as unknown;
		if (!isRecord(message) || typeof message.type !== "string") return;
		if (message.type === "hello") {
			if (!client.channelKey) return;
			eventHub.replay(
				client,
				client.channelKey,
				typeof message.lastEventId === "string" ? message.lastEventId : null,
			);
			return;
		}
		const action = runtimeActions[message.type];
		if (action) {
			void getRuntime(client.channelKey)
				.then(action)
				.catch((error) => console.error(`WebSocket ${message.type} runtime lookup failed`, error));
		}
	};

	server.on("upgrade", (request, socket) => {
		const netSocket = socket as Socket;
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (url.pathname !== "/api/web/stream" || !authorize(request, url.pathname)) {
			netSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			netSocket.destroy();
			return;
		}
		const requestedChannelKey = url.searchParams.get("channelKey") || undefined;
		void getRuntime(requestedChannelKey)
			.then((runtime) => {
				if (netSocket.destroyed) return;
				if (!acceptWebSocket(request, netSocket)) return;
				netSocket.setNoDelay(true);
				const client: WebSocketClient = { socket: netSocket, channelKey: runtime.channelKey, authed: false };
				const dispose = eventHub.registerClient(client);
				let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
				netSocket.on("data", (chunk: Buffer) => {
					try {
						frameBuffer = Buffer.concat([frameBuffer, chunk]);
						const decoded = decodeFrames(frameBuffer);
						frameBuffer = decoded.remaining;
						if (decoded.close) netSocket.destroy();
						for (const raw of decoded.messages) {
							handleStreamMessage(raw, client);
						}
					} catch (error) {
						console.error("WebSocket frame handling failed", error);
						netSocket.destroy();
					}
				});
				netSocket.on("close", dispose);
				netSocket.on("error", dispose);
			})
			.catch((error) => {
				console.error("WebSocket runtime lookup failed", error);
				if (!netSocket.destroyed) {
					netSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
					netSocket.destroy();
				}
			});
	});
}
