import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { buildRecordBase, type ChatLogRecord } from "../src/conversation/chat-log.js";
import { ownerDmRef } from "../src/runtime/agent-core.js";
import type { ConversationRuntime } from "../src/runtime/conversation-runtime.js";
import {
	createVoiceCall,
	formatVoiceTranscript,
	type VoiceCallDeps,
	voiceCallEntry,
	voiceCallOpening,
} from "../src/web/voice-call.js";
import { configWithDataDir, createTempDataDir } from "./helpers.js";

function chat(): ChatLogRecord[] {
	const said = (recordId: number, type: "inbound" | "outbound", text: string): ChatLogRecord =>
		type === "inbound"
			? {
					type,
					...buildRecordBase(ownerDmRef, recordId),
					messageId: `m${recordId}`,
					authorId: "owner",
					authorName: "qearl",
					text,
					isBot: false,
					mentionedBot: true,
					attachments: [],
				}
			: { type, ...buildRecordBase(ownerDmRef, recordId), messageIds: [`m${recordId}`], text };
	return [said(1, "inbound", "first"), said(2, "outbound", "second"), said(3, "inbound", "third")];
}

describe("web voice call", () => {
	it("opens with only the configured number of recent chat messages", async (t) => {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const opening = voiceCallOpening(config, chat(), "Fern", 2);
		assert.doesNotMatch(opening, /first/);
		assert.match(opening, /\[you @ [^\]]+\] second/);
		assert.match(opening, /\[qearl @ [^\]]+\] third/);
		assert.doesNotMatch(voiceCallOpening(config, chat(), "Fern", 0), /recent_chat/);
	});

	it("formats a kept call as one timestamped entry", () => {
		const transcript = formatVoiceTranscript(
			[
				{ who: "you", text: "hi", at: 3_000 },
				{ who: "them", text: "hello", at: 65_000 },
			],
			"qearl",
			"Fern",
		);
		assert.equal(transcript, "[00:03] qearl: hi\n[01:05] Fern: hello");
		assert.match(voiceCallEntry("transcript", 252_000, transcript), /^\(we were on a voice call for 4 minutes — here's all of it\)\n\[00:03\]/);
	});

	async function fakeCall(t: Parameters<typeof configWithDataDir>[0], options: { holdUntilAborted?: boolean } = {}) {
		const config = await configWithDataDir(t, await createTempDataDir(t));
		const prompts: { key: string; input: string; ephemeral?: boolean; settingsFrom?: string }[] = [];
		const sent: Record<string, unknown>[] = [];
		const state = { disposed: undefined as string | undefined, aborts: 0, interrupts: 0 };
		let release: (() => void) | undefined;
		const event = (body: unknown) => body as AgentEvent;
		const delta = (text: string) => event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
		const deps: VoiceCallDeps = {
			config,
			personaName: "Fern",
			getMainRuntime: async () => ({ channelKey: "web-web-main", getRecords: () => chat() }) as unknown as ConversationRuntime,
			summarizer: { summarizeVoiceCall: async () => "" },
			familiarAgent: {
				prompt: async (key, input, _images, listener, promptOptions) => {
					prompts.push({ key, input, ephemeral: promptOptions?.ephemeral, settingsFrom: promptOptions?.settingsFrom });
					await listener?.(event({ type: "agent_start" }));
					await listener?.(delta("hey "));
					// a reply still being written stops only when it is aborted
					if (options.holdUntilAborted) await new Promise<void>((resolve) => (release = resolve));
					else await listener?.(delta("you"));
					return { text: "", attachments: [] };
				},
				abort: async () => {
					state.aborts += 1;
					release?.();
					release = undefined;
				},
				dispose: async (key) => {
					state.disposed = key;
				},
			},
		};
		const call = createVoiceCall(
			deps,
			(body) => sent.push(body),
			() => {
				state.interrupts += 1;
			},
		);
		return { call, prompts, sent, state };
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

	it("streams each turn from its own session and opens only the first one with context", async (t) => {
		const { call, prompts, sent, state } = await fakeCall(t);
		call.say("one");
		await settle();
		call.say("two");
		await settle();
		call.close();

		assert.equal(prompts.length, 2);
		assert.match(prompts[0].input, /recent_chat[\s\S]*on the call:\none$/);
		assert.equal(prompts[1].input, "two");
		assert.equal(prompts[0].key, prompts[1].key);
		assert.equal(prompts[0].ephemeral, true);
		assert.equal(prompts[0].settingsFrom, "web-web-main");
		assert.equal(state.disposed, prompts[0].key);
		assert.equal(state.aborts, 0, "a finished reply is never cut");
		assert.deepEqual(
			sent.filter((body) => body.id === "reply-1"),
			[
				{ type: "reply", id: "reply-1", text: "hey " },
				{ type: "reply", id: "reply-1", text: "hey you" },
				{ type: "reply_end", id: "reply-1", text: "hey you", silent: false },
			],
		);
	});

	it("cuts a reply short when you speak again, the way stop does", async (t) => {
		const { call, prompts, sent, state } = await fakeCall(t, { holdUntilAborted: true });
		call.say("go to the shop");
		await settle();
		call.say("no wait, the park");
		await settle();

		assert.equal(state.aborts >= 1, true);
		assert.equal(state.interrupts, 1);
		assert.equal(call.wasCut("reply-1"), true);
		assert.equal(call.wasCut("reply-2"), false);
		assert.deepEqual(
			sent.filter((body) => body.id === "reply-1"),
			[
				{ type: "reply", id: "reply-1", text: "hey " },
				{ type: "interrupted", id: "reply-1" },
				{ type: "reply_end", id: "reply-1", text: "hey", silent: false },
			],
		);
		assert.equal(prompts.length, 2);
		assert.equal(prompts[1].input, "no wait, the park");
		call.close();
	});

	it("carries words from a turn cut before it began into the next one", async (t) => {
		const { call, prompts, sent } = await fakeCall(t);
		call.say("one");
		call.say("two");
		await settle();
		call.close();

		assert.equal(prompts.length, 1);
		assert.match(prompts[0].input, /on the call:\none\ntwo$/);
		assert.equal(sent.some((body) => body.id === "reply-1" && body.type !== "interrupted"), false);
	});
});
