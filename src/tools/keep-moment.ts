import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { Config } from "../config/index.js";
import type { ChatLogRecord } from "../conversation/chat-log.js";
import { clippingSpanByWords, keepClipping, MAX_KEPT_BY_THEM } from "../web/clippings.js";
import { webMessagesFromRecords } from "../web/messages.js";

const keepMomentSchema = Type.Object(
	{
		from: Type.String({
			description: "a few words, just as they were said, from the message where the moment starts.",
		}),
		to: Type.Optional(
			Type.String({
				description: "optional. a few words from the message where it ends. leave it out and it runs up to now.",
			}),
		),
		title: Type.Optional(Type.String({ description: "optional. what you'd call it." })),
		note: Type.Optional(Type.String({ description: "optional. a line of your own about why you kept it." })),
	},
	{ additionalProperties: false },
);

type KeepMomentInput = Static<typeof keepMomentSchema>;

export interface KeepMomentSource {
	/** this conversation as it stands; the reply being written isn't in it yet */
	records(): Promise<readonly ChatLogRecord[] | undefined>;
	personaName(): string;
}

/** the start of a message, short enough to say back */
function opening(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 60 ? `${line.slice(0, 60).trimEnd()}…` : line;
}

export function createKeepMomentTool(
	config: Config,
	source: KeepMomentSource,
): AgentTool<typeof keepMomentSchema, { id: string }> {
	return {
		name: "keep_moment",
		label: "keep_moment",
		description:
			"keep a moment from our talk: something that made you laugh, something that got to you, a line you'd hate to see scroll away. whatever you feel like holding on to. it goes on the shelf in my library with your name on it, thoughts and all, and i'll find it there.",
		parameters: keepMomentSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input: KeepMomentInput) {
			const records = await source.records();
			if (!records) throw new Error("keep_moment: there's no conversation here to keep from.");
			let span: ReturnType<typeof clippingSpanByWords>;
			try {
				span = clippingSpanByWords(
					webMessagesFromRecords(config, records, source.personaName()),
					input.from,
					input.to,
				);
			} catch (error) {
				throw new Error(`keep_moment: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (span.length > MAX_KEPT_BY_THEM) {
				throw new Error(
					`keep_moment: that stretch is ${span.length} messages (limit ${MAX_KEPT_BY_THEM}). start it later or end it sooner.`,
				);
			}
			const first = span[0]!;
			const last = span.at(-1)!;
			const clipping = await keepClipping(config, span, { title: input.title, note: input.note, keptBy: "them" });
			const reach =
				span.length === 1
					? `1 message, ${first.who}: "${opening(first.text)}"`
					: `${span.length} messages, from ${first.who}: "${opening(first.text)}" to ${last.who}: "${opening(last.text)}"`;
			return {
				content: [{ type: "text", text: `kept on the shelf (${reach}).` }],
				details: { id: clipping.id },
			};
		},
	};
}
