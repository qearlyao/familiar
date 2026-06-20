import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type ToolCall,
} from "@earendil-works/pi-ai";

type ToolNameResolver = (name: string) => string;
type NamedTool = { name: string };

function createToolNameResolver(tools: readonly NamedTool[]): ToolNameResolver {
	const exactNames = new Set(tools.map((tool) => tool.name));
	const lowerToNames = new Map<string, string[]>();
	for (const tool of tools) {
		const lower = tool.name.toLowerCase();
		const names = lowerToNames.get(lower);
		if (names) names.push(tool.name);
		else lowerToNames.set(lower, [tool.name]);
	}

	return (name: string) => {
		if (exactNames.has(name)) return name;
		const matches = lowerToNames.get(name.toLowerCase());
		return matches?.length === 1 ? matches[0] : name;
	};
}

function normalizeToolCall(toolCall: ToolCall, resolveToolName: ToolNameResolver): ToolCall {
	const name = resolveToolName(toolCall.name);
	return name === toolCall.name ? toolCall : { ...toolCall, name };
}

function normalizeAssistantToolNames(message: AssistantMessage, resolveToolName: ToolNameResolver): AssistantMessage {
	let changed = false;
	const content = message.content.map((item) => {
		if (item.type !== "toolCall") return item;
		const normalized = normalizeToolCall(item, resolveToolName);
		if (normalized !== item) changed = true;
		return normalized;
	});
	return changed ? { ...message, content } : message;
}

function normalizeAssistantEventToolNames(
	event: AssistantMessageEvent,
	resolveToolName: ToolNameResolver,
): AssistantMessageEvent {
	const normalizeMessage = (message: AssistantMessage) => normalizeAssistantToolNames(message, resolveToolName);
	switch (event.type) {
		case "start":
			return { ...event, partial: normalizeMessage(event.partial) };
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
			return { ...event, partial: normalizeMessage(event.partial) };
		case "toolcall_end": {
			return {
				...event,
				toolCall: normalizeToolCall(event.toolCall, resolveToolName),
				partial: normalizeMessage(event.partial),
			};
		}
		case "done":
			return { ...event, message: normalizeMessage(event.message) };
		case "error":
			return { ...event, error: normalizeMessage(event.error) };
	}
}

export function normalizeToolNameStream(
	source: AssistantMessageEventStream,
	tools: readonly NamedTool[],
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const resolveToolName = createToolNameResolver(tools);
	void (async () => {
		for await (const event of source) {
			stream.push(normalizeAssistantEventToolNames(event, resolveToolName));
		}
	})();
	return stream;
}
