import { randomUUID } from "node:crypto";

import type { FamiliarAgent } from "../agent/factory.js";
import type { Config } from "../config/index.js";
import type { ChatLogRecord, VoiceCallLine } from "../conversation/chat-log.js";
import { getContactNickname } from "../conversation/contact-note.js";
import { messageId } from "../conversation/ids.js";
import type { DefaultLcmSummarizer } from "../memory/lcm/summarizer.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import { parseAgentReply } from "../runtime/silent-marker.js";
import { isRecord } from "../util/guards.js";
import { formatLocalTimestamp } from "../util/time.js";
import { errorMessage } from "./errors.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { webHistoryPayload } from "./messages.js";
import type { RegisterWebRoute } from "./routes.js";
import { WEB_USER_NAME, type WebMessage } from "./types.js";

export interface VoiceCallDeps {
	config: Config;
	familiarAgent: Pick<FamiliarAgent, "prompt" | "abort" | "dispose">;
	/** the main chat — where a call starts from and where a kept call lands */
	getMainRuntime: () => Promise<ConversationRuntime>;
	personaName: string;
	summarizer: Pick<DefaultLcmSummarizer, "summarizeVoiceCall">;
}

function spokenText(message: WebMessage): string | undefined {
	const raw =
		message.text ||
		(message.steps ?? [])
			.filter((step) => step.kind === "text")
			.map((step) => step.text)
			.join("");
	const parsed = parseAgentReply(raw);
	return parsed.silent || !parsed.text.trim() ? undefined : parsed.text.trim();
}

/** The first thing the call's session hears: what a call is, and where the chat was. */
export function voiceCallOpening(
	config: Config,
	records: readonly ChatLogRecord[],
	personaName: string,
	count: number,
): string {
	const recent =
		count > 0
			? webHistoryPayload(config, records, personaName, "", { limit: count * 2 })
					.messages.filter((message) => message.role !== "system" && !message.silent)
					.flatMap((message) => {
						const text = spokenText(message);
						const who = message.role === "assistant" ? "you" : message.who;
						return text ? [`[${who} @ ${formatLocalTimestamp(message.ts)}] ${text}`] : [];
					})
					.slice(-count)
			: [];
	const intro =
		"hey, i'm calling you~ this is a voice call, its own little room apart from our chat. everything you say is spoken out loud, so talk the way you would on the phone.";
	const chat = recent.length
		? `\n\nhere's where our chat was when i called:\n<recent_chat>\n${recent.join("\n")}\n</recent_chat>`
		: "";
	return `${intro}${chat}\n\non the call:`;
}

/** One call is one session of its own. Replies stream back as their whole text so far.
    Talking again cuts the reply short, the way stop does in the chat: a call never makes you sit
    through an answer to something you've already corrected. */
export function createVoiceCall(
	deps: VoiceCallDeps,
	send: (body: Record<string, unknown>) => void,
	/** a reply was cut short: silence whatever of it is still on its way out */
	onInterrupt: () => void,
) {
	const sessionKey = `voice:${randomUUID()}`;
	// snapshot the chat as it was when the call picked up
	const main = deps.getMainRuntime();
	const opening = main.then((runtime) =>
		voiceCallOpening(deps.config, runtime.getRecords(), deps.personaName, deps.config.web.voiceContextMessages),
	);
	let turns = 0;
	let closed = false;
	let introduced = false;
	// turns run one at a time; a turn cut before it began hands its words to the next one
	let chain: Promise<void> = Promise.resolve();
	let current: { id: string; cut: boolean; done: boolean } | undefined;
	let unheard: string[] = [];
	const cutReplies = new Set<string>();

	const cut = (): void => {
		if (!current || current.cut || current.done) return;
		current.cut = true;
		cutReplies.add(current.id);
		send({ type: "interrupted", id: current.id });
		onInterrupt();
		void deps.familiarAgent.abort(sessionKey);
	};

	return {
		say(text: string): void {
			cut();
			const turn = { id: `reply-${++turns}`, cut: false, done: false };
			current = turn;
			unheard.push(text);
			chain = chain.then(async () => {
				if (closed || turn.cut) return;
				const words = unheard.join("\n");
				unheard = [];
				let reply = "";
				try {
					const intro = await opening;
					// the call thinks with whatever model and thinking level the chat is set to
					const { channelKey } = await main;
					if (turn.cut) {
						unheard.unshift(words);
						return;
					}
					const input = introduced ? words : `${intro}\n${words}`;
					introduced = true;
					await deps.familiarAgent.prompt(
						sessionKey,
						input,
						undefined,
						(event) => {
							if (closed) return;
							// cut before the run could be stopped: stop it now that it has started
							if (turn.cut) {
								if (event.type === "agent_start") void deps.familiarAgent.abort(sessionKey);
								return;
							}
							if (event.type === "message_start" && event.message.role === "assistant" && reply) reply += "\n";
							if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
								reply += event.assistantMessageEvent.delta;
								send({ type: "reply", id: turn.id, text: reply });
							}
						},
						{ ephemeral: true, ambientQuery: words, settingsFrom: channelKey },
					);
				} catch (error) {
					if (!closed && !turn.cut) send({ type: "error", source: "agent", message: errorMessage(error) });
				}
				turn.done = true;
				if (closed) return;
				const parsed = parseAgentReply(reply);
				send({ type: "reply_end", id: turn.id, text: parsed.text.trim(), silent: parsed.silent });
			});
		},
		/** you talked over the reply: stop writing the rest of it */
		interrupt: cut,
		/** speech for a reply that was cut short is never sent on to be spoken */
		wasCut: (id: unknown): boolean => typeof id === "string" && cutReplies.has(id),
		close(): void {
			closed = true;
			void deps.familiarAgent.dispose(sessionKey);
		},
	};
}

function clock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatVoiceTranscript(lines: readonly VoiceCallLine[], you: string, them: string): string {
	return lines.map((line) => `[${clock(line.at)}] ${line.who === "you" ? you : them}: ${line.text}`).join("\n");
}

function spokenDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return `${hours === 1 ? "an hour" : `${hours} hours`}${rest ? ` and ${rest} minutes` : ""}`;
}

export function voiceCallEntry(choice: "transcript" | "summary", durationMs: number, body: string): string {
	const what = choice === "summary" ? "here's what it was about" : "here's all of it";
	return `(we were on a voice call for ${spokenDuration(durationMs)} — ${what})\n${body}`;
}

function parseKeepBody(body: unknown): {
	choice: "transcript" | "summary" | "discard";
	durationMs: number;
	lines: VoiceCallLine[];
} {
	if (!isRecord(body)) throw new HttpError(400, "body is required");
	if (body.choice !== "transcript" && body.choice !== "summary" && body.choice !== "discard")
		throw new HttpError(400, "choice must be transcript, summary or discard");
	if (typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs) || body.durationMs < 0)
		throw new HttpError(400, "durationMs is required");
	if (body.choice === "discard") return { choice: "discard", durationMs: body.durationMs, lines: [] };
	if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 5000)
		throw new HttpError(400, "lines are required");
	const lines = body.lines.map((line): VoiceCallLine => {
		if (
			!isRecord(line) ||
			(line.who !== "you" && line.who !== "them") ||
			typeof line.text !== "string" ||
			typeof line.at !== "number"
		)
			throw new HttpError(400, "each line needs who, text and at");
		return { who: line.who, text: line.text.trim(), at: line.at };
	});
	return { choice: body.choice, durationMs: body.durationMs, lines: lines.filter((line) => line.text) };
}

export function registerWebVoiceCallRoutes(route: RegisterWebRoute, deps: VoiceCallDeps): void {
	// A finished call lands in the main chat as one entry. It never asks for a reply;
	// it rides along with whatever is said there next. A discarded call leaves only a mark for you to see.
	route("POST", "/api/web/voice/keep", async (request, response) => {
		const { choice, durationMs, lines } = parseKeepBody(await readJsonBody(request));
		const runtime = await deps.getMainRuntime();
		if (choice === "discard") {
			await runtime.noteCallDiscarded(durationMs);
			sendJson(response, 200, { ok: true, channelKey: runtime.channelKey });
			return;
		}
		if (lines.length === 0) throw new HttpError(400, "lines are required");
		const you = getContactNickname(WEB_USER_NAME);
		const transcript = formatVoiceTranscript(lines, you, deps.personaName);
		const body = choice === "summary" ? await deps.summarizer.summarizeVoiceCall(transcript) : transcript;
		const id = messageId("user");
		await runtime.ingestInbound(
			{
				messageId: id,
				authorId: runtime.ownerId,
				authorName: you,
				text: voiceCallEntry(choice, durationMs, body),
				call:
					choice === "summary"
						? { kept: "summary", durationMs, summary: body }
						: { kept: "transcript", durationMs, lines },
				isBot: false,
				mentionedBot: false,
				remoteTimestamp: new Date().toISOString(),
			},
			{ mode: "collect" },
		);
		sendJson(response, 200, { ok: true, id, channelKey: runtime.channelKey });
	});
}
