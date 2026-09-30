import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { supportsSystemNotes } from "./index.js";

export function userTextMessage(text: string, timestamp = Date.now()): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

// harness text the agent hears in the harness's own voice, not as one of us typing. A model pi
// marks as lacking mid-conversation system messages would have them dropped, so it hears the same
// text as plain user text; so does a turn with no model to ask.
export function harnessNoteMessage(model: Model<any> | undefined, text: string, timestamp = Date.now()): AgentMessage {
	if (!model || !supportsSystemNotes(model)) return userTextMessage(text, timestamp);
	return { role: "system", content: text, timestamp };
}
