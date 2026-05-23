export const SILENT_RESPONSE_MARKER = "[[FAMILIAR_SILENT]]";

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

export function parseAgentReply(text: string): { text: string; silent: boolean } {
	const normalized = normalizeNewlines(text);
	if (normalized === SILENT_RESPONSE_MARKER) {
		return { text: "", silent: true };
	}
	if (normalized.startsWith(`${SILENT_RESPONSE_MARKER}\n`)) {
		return { text: normalized.slice(SILENT_RESPONSE_MARKER.length + 1), silent: true };
	}
	return { text, silent: false };
}

export interface SilentFilterState {
	accumulated: string;
	buffered: string;
	silent: boolean;
	carryCR: boolean;
}

export function createSilentFilterState(): SilentFilterState {
	return { accumulated: "", buffered: "", silent: false, carryCR: false };
}

export type SilentFilterResult =
	| { kind: "emit"; text: string }
	| { kind: "buffer" }
	| { kind: "silent" };

function normalizeStreamingChunk(state: SilentFilterState, chunk: string): string {
	let working = chunk;
	if (state.carryCR) {
		state.carryCR = false;
		working = `\r${working}`;
	}
	if (working.endsWith("\r")) {
		state.carryCR = true;
		working = working.slice(0, -1);
	}
	return working.replace(/\r\n/g, "\n");
}

export function consumeSilentDelta(
	state: SilentFilterState,
	delta: string,
): SilentFilterResult {
	if (state.silent) return { kind: "silent" };
	const normalized = normalizeStreamingChunk(state, delta);
	state.accumulated += normalized;
	state.buffered += normalized;
	if (state.accumulated.startsWith(`${SILENT_RESPONSE_MARKER}\n`)) {
		state.silent = true;
		state.buffered = "";
		return { kind: "silent" };
	}
	if (SILENT_RESPONSE_MARKER.startsWith(state.accumulated)) {
		return { kind: "buffer" };
	}
	const emit = state.buffered;
	state.buffered = "";
	return emit ? { kind: "emit", text: emit } : { kind: "buffer" };
}

export function finalizeSilentFilter(
	state: SilentFilterState,
): { silent: boolean; flush: string } {
	if (state.carryCR) {
		state.buffered += "\r";
		state.accumulated += "\r";
		state.carryCR = false;
	}
	if (state.silent) return { silent: true, flush: "" };
	if (state.accumulated === SILENT_RESPONSE_MARKER) {
		state.silent = true;
		state.buffered = "";
		return { silent: true, flush: "" };
	}
	const flush = state.buffered;
	state.buffered = "";
	return { silent: false, flush };
}
