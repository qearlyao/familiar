export const SILENT_RESPONSE_MARKER = "[[FAMILIAR_SILENT]]";

/**
 * A marker anywhere in the reply means the agent chose silence. The remaining
 * text (marker stripped) is private reflection: never delivered to Discord,
 * rendered muted in the web UI.
 */
export function parseAgentReply(text: string): { text: string; silent: boolean } {
	if (!text.includes(SILENT_RESPONSE_MARKER)) return { text, silent: false };
	return { text: text.split(SILENT_RESPONSE_MARKER).join("").trim(), silent: true };
}

export function normalizeOutboundText(text: string): string {
	return text.trim() || "(empty response)";
}

export function parseOutboundReply(text: string): { text: string; silent: boolean } {
	const parsed = parseAgentReply(text);
	if (parsed.silent) return parsed;
	return { text: normalizeOutboundText(parsed.text), silent: false };
}
