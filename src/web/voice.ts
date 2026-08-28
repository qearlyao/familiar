import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import type { Config } from "../config/index.js";
import { buildElevenLabsVoiceSettings } from "../media/tts.js";
import { isRecord } from "../util/guards.js";
import { acceptWebSocket, decodeFrames, encodeFrame } from "./events.js";
import { sendJson } from "./http.js";
import type { RegisterWebRoute } from "./routes.js";

export const WEB_VOICE_PATH = "/api/web/voice";
const ELEVENLABS_STT_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const ELEVENLABS_STT_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const ELEVENLABS_TTD_URL = "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input";
const STT_MODEL_ID = "scribe_v2_realtime";
const STT_VAD_SILENCE_THRESHOLD_SECS = 1.2;
// Realtime playback decodes raw PCM in the browser; config.tts.output_format stays for file attachments.
const TTS_OUTPUT_FORMAT = "pcm_24000";

type VoiceMessage = Record<string, unknown>;

function send(socket: Socket, body: VoiceMessage): void {
	if (!socket.destroyed && !socket.writableEnded) socket.write(encodeFrame(JSON.stringify(body)));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function apiKey(config: Config): string {
	if (config.tts.provider !== "elevenlabs") {
		throw new Error("Voice calls require tts.provider = elevenlabs");
	}
	const key = process.env[config.tts.apiKeyEnv];
	if (!key) throw new Error(`Missing ElevenLabs API key env: ${config.tts.apiKeyEnv}`);
	if (!config.tts.voiceId.trim()) throw new Error("tts.voice_id is not configured");
	return key;
}

export function buildElevenLabsRealtimeSttUrl(
	token: string,
	languageCode?: string,
	voiceCallMode: "continuous" | "push_to_talk" = "continuous",
): string {
	const url = new URL(ELEVENLABS_STT_URL);
	url.searchParams.set("model_id", STT_MODEL_ID);
	url.searchParams.set("audio_format", "pcm_16000");
	url.searchParams.set("commit_strategy", voiceCallMode === "push_to_talk" ? "manual" : "vad");
	if (voiceCallMode !== "push_to_talk") {
		url.searchParams.set("vad_silence_threshold_secs", String(STT_VAD_SILENCE_THRESHOLD_SECS));
	}
	url.searchParams.set("token", token);
	const normalizedLanguageCode = normalizeElevenLabsLanguageCode(languageCode);
	if (normalizedLanguageCode) url.searchParams.set("language_code", normalizedLanguageCode);
	return url.toString();
}

export function normalizeElevenLabsLanguageCode(languageCode?: string | null): string | undefined {
	const normalized = languageCode?.trim().toLowerCase();
	return normalized && /^[a-z]{3}$/.test(normalized) ? normalized : undefined;
}

export function buildElevenLabsRealtimeTtsUrl(config: Config): string {
	const url = new URL(ELEVENLABS_TTD_URL);
	url.searchParams.set("model_id", config.tts.voiceCallModelId);
	url.searchParams.set("output_format", TTS_OUTPUT_FORMAT);
	return url.toString();
}

export function buildElevenLabsRealtimeTtsInit(config: Config, key: string): Record<string, unknown> {
	return {
		voices: [config.tts.voiceId],
		xi_api_key: key,
		voice_settings: buildElevenLabsVoiceSettings(config, config.tts.voiceCallModelId),
	};
}

async function createSttToken(key: string): Promise<string> {
	const response = await fetch(ELEVENLABS_STT_TOKEN_URL, { method: "POST", headers: { "xi-api-key": key } });
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`STT token request failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
	const body = (await response.json()) as unknown;
	if (!isRecord(body) || typeof body.token !== "string" || !body.token)
		throw new Error("STT token response was invalid");
	return body.token;
}

export function normalizeSpeechEvent(event: unknown): VoiceMessage | undefined {
	if (!isRecord(event) || typeof event.message_type !== "string") return undefined;
	const messageType = event.message_type;
	if (
		(messageType === "partial_transcript" ||
			messageType === "final_transcript" ||
			messageType === "final_transcript_with_timestamps" ||
			messageType === "committed_transcript" ||
			messageType === "committed_transcript_with_timestamps") &&
		typeof event.text === "string"
	) {
		return {
			type: "transcript",
			final: messageType !== "partial_transcript",
			text: event.text,
		};
	}
	if (
		[
			"error",
			"auth_error",
			"quota_exceeded",
			"commit_throttled",
			"unaccepted_terms",
			"rate_limited",
			"queue_overflow",
			"resource_exhausted",
			"session_time_limit_exceeded",
			"input_error",
			"invalid_request",
			"chunk_size_exceeded",
			"insufficient_audio_activity",
			"transcriber_error",
		].includes(messageType)
	) {
		return { type: "error", source: "stt", message: typeof event.error === "string" ? event.error : messageType };
	}
	return undefined;
}

type WebSocketInitWithHeaders = { headers: Record<string, string> };

function openUpstream(url: string, label: string, headers?: Record<string, string>): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		let socket: WebSocket;
		try {
			const WebSocketWithHeaders = WebSocket as unknown as {
				new (url: string, options?: WebSocketInitWithHeaders): WebSocket;
			};
			socket = new WebSocketWithHeaders(url, headers ? { headers } : undefined);
		} catch (error) {
			reject(error);
			return;
		}
		let opened = false;
		let settled = false;
		let upstreamError: string | undefined;
		const rejectOnce = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		socket.addEventListener("open", () => {
			if (settled) return;
			settled = true;
			opened = true;
			resolve(socket);
		});
		socket.addEventListener("error", (event) => {
			if (!opened && "message" in event && typeof event.message === "string" && event.message)
				upstreamError = event.message;
		});
		socket.addEventListener("close", (event) => {
			if (opened) return;
			const reason = event.reason ? `: ${event.reason}` : "";
			const detail = ` (close code ${event.code}${reason})`;
			rejectOnce(new Error(`${label} connection failed${upstreamError ? `: ${upstreamError}` : ""}${detail}`));
		});
	});
}

async function eventText(data: unknown): Promise<string | undefined> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (data instanceof Blob) return data.text();
	return undefined;
}

export function registerWebVoiceRoutes(route: RegisterWebRoute, config: Config): void {
	route("GET", "/api/web/voice/config", async (_request, response) => {
		sendJson(response, 200, {
			enabled: config.tts.provider === "elevenlabs",
			voiceCallMode: config.web.voiceCallMode,
		});
	});
}

export function attachWebSocketVoice(
	server: Server,
	options: { authorize(request: IncomingMessage, pathname: string): Promise<boolean>; config: Config },
): void {
	server.on("upgrade", (request, rawSocket) => {
		const socket = rawSocket as Socket;
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (url.pathname !== WEB_VOICE_PATH) return;
		void options
			.authorize(request, url.pathname)
			.then(async (authorized) => {
				if (!authorized) {
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
					socket.destroy();
					return;
				}
				if (!acceptWebSocket(request, socket)) return;
				socket.setNoDelay(true);
				let stt: WebSocket | undefined;
				let sttReady: Promise<WebSocket> | undefined;
				let tts: WebSocket | undefined;
				let ttsReady: Promise<WebSocket> | undefined;
				let ttsKeepAliveTimer: ReturnType<typeof setInterval> | undefined;
				let ttsDialogueNeedsTurn = true;
				let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
				let closed = false;
				const close = (): void => {
					if (closed) return;
					closed = true;
					if (ttsKeepAliveTimer) clearInterval(ttsKeepAliveTimer);
					ttsKeepAliveTimer = undefined;
					stt?.close();
					tts?.close();
					if (!socket.destroyed) socket.destroy();
				};
				const fail = (source: string, error: unknown): void => {
					console.error(`Web voice ${source} failed`, error);
					send(socket, { type: "error", source, message: errorMessage(error) });
				};
				const key = (() => {
					try {
						return apiKey(options.config);
					} catch (error) {
						fail("config", error);
						close();
						return undefined;
					}
				})();
				if (!key) return;

				const connectStt = async (): Promise<WebSocket> => {
					if (stt) return stt;
					// upstream self-closes after ~15s idle; reopen on the next chunk
					sttReady ??= (async () => {
						const token = await createSttToken(key);
						const connection = await openUpstream(
							buildElevenLabsRealtimeSttUrl(
								token,
								url.searchParams.get("language_code") ?? undefined,
								options.config.web.voiceCallMode,
							),
							"STT",
						);
						stt = connection;
						connection.addEventListener("message", (event) => {
							void eventText((event as MessageEvent).data)
								.then((text) => {
									if (!text) return;
									try {
										const normalized = normalizeSpeechEvent(JSON.parse(text));
										if (normalized) send(socket, normalized);
									} catch (error) {
										fail("stt-message", error);
									}
								})
								.catch((error) => fail("stt-message", error));
						});
						connection.addEventListener("error", () => fail("stt", new Error("upstream connection error")));
						connection.addEventListener("close", () => {
							if (stt === connection) {
								stt = undefined;
								sttReady = undefined;
							}
							if (!closed) send(socket, { type: "stt_closed" });
						});
						return connection;
					})().catch((error) => {
						sttReady = undefined;
						throw error;
					});
					return sttReady;
				};

				const connectTts = async (): Promise<WebSocket> => {
					if (tts) return tts;
					ttsReady ??= openUpstream(
						buildElevenLabsRealtimeTtsUrl(options.config),
						`TTS (${options.config.tts.modelId})`,
						{
							"xi-api-key": key,
						},
					).then((connection) => {
						tts = connection;
						ttsKeepAliveTimer = setInterval(() => {
							if (closed || tts !== connection || connection.readyState !== WebSocket.OPEN) return;
							try {
								connection.send(JSON.stringify({ keep_alive: true }));
							} catch (error) {
								fail("tts-keep-alive", error);
							}
						}, 10_000);
						ttsKeepAliveTimer.unref?.();
						connection.addEventListener("message", (event) => {
							void eventText((event as MessageEvent).data)
								.then((text) => {
									if (!text) return;
									try {
										const message = JSON.parse(text) as unknown;
										if (!isRecord(message)) return;
										if (typeof message.audio === "string") {
											send(socket, { type: "audio", audioBase64: message.audio });
										}
										if (
											message.isFinal === true ||
											message.is_final === true ||
											message.is_final_audio_for_turn === true
										) {
											send(socket, { type: "tts_done" });
										}
										const error =
											typeof message.message === "string"
												? message.message
												: typeof message.error === "string"
													? message.error
													: undefined;
										if (error) send(socket, { type: "error", source: "tts", message: error });
									} catch (error) {
										fail("tts-message", error);
									}
								})
								.catch((error) => fail("tts-message", error));
						});
						connection.addEventListener("error", () => fail("tts", new Error("upstream connection error")));
						connection.addEventListener("close", () => {
							if (tts === connection) {
								tts = undefined;
								ttsReady = undefined;
							}
							if (ttsKeepAliveTimer) clearInterval(ttsKeepAliveTimer);
							ttsKeepAliveTimer = undefined;
						});
						connection.send(JSON.stringify(buildElevenLabsRealtimeTtsInit(options.config, key)));
						return connection;
					});
					return ttsReady;
				};

				// push-to-talk is silent until the first press, so let that chunk open it
				if (options.config.web.voiceCallMode !== "push_to_talk") {
					void connectStt().catch((error) => {
						fail("stt", error);
						close();
					});
				}
				const handleMessage = async (raw: string): Promise<void> => {
					const message = JSON.parse(raw) as unknown;
					if (!isRecord(message) || typeof message.type !== "string") return;
					if (message.type === "audio") {
						if (
							typeof message.audioBase64 !== "string" ||
							!message.audioBase64 ||
							!/^[A-Za-z0-9+/]*={0,2}$/.test(message.audioBase64)
						) {
							throw new Error("audioBase64 is required");
						}
						const connection = await connectStt();
						const chunk: Record<string, unknown> = {
							message_type: "input_audio_chunk",
							audio_base_64: message.audioBase64,
						};
						if (typeof message.commit === "boolean") chunk.commit = message.commit;
						if (Number.isInteger(message.sampleRate)) chunk.sample_rate = message.sampleRate;
						connection.send(JSON.stringify(chunk));
						return;
					}
					if (message.type === "tts") {
						if (typeof message.text !== "string") throw new Error("text is required");
						if (message.text.length > options.config.tts.maxInputChars)
							throw new Error(
								`tts text is too long (${message.text.length}/${options.config.tts.maxInputChars} chars).`,
							);
						const connection = await connectTts();
						connection.send(
							JSON.stringify({
								inputs: [
									{
										text: message.text,
										voice_id: options.config.tts.voiceId,
										new_turn: ttsDialogueNeedsTurn,
									},
								],
								flush: message.flush === true,
							}),
						);
						ttsDialogueNeedsTurn = message.flush === true;
						return;
					}
					if (message.type === "tts_end") {
						const connection = await connectTts();
						connection.send(JSON.stringify({ flush: true }));
						ttsDialogueNeedsTurn = true;
						return;
					}
					if (message.type === "tts_cancel") {
						tts?.close();
						tts = undefined;
						ttsReady = undefined;
						ttsDialogueNeedsTurn = true;
						return;
					}
					if (message.type === "close") close();
				};

				socket.on("data", (chunk: Buffer) => {
					try {
						frameBuffer = Buffer.concat([frameBuffer, chunk]);
						const decoded = decodeFrames(frameBuffer);
						frameBuffer = decoded.remaining;
						if (decoded.close) close();
						for (const raw of decoded.messages) void handleMessage(raw).catch((error) => fail("message", error));
					} catch (error) {
						fail("frame", error);
						close();
					}
				});
				socket.on("close", close);
				socket.on("error", close);
			})
			.catch((error) => {
				console.error("Web voice upgrade failed", error);
				if (!socket.destroyed) socket.destroy();
			});
	});
}
