export interface ControlCommandDefinition {
	name: string;
	description: string;
	argumentLabel?: string;
}

export const CONTROL_COMMANDS = [
	{ name: "status", description: "show runtime status" },
	{ name: "stop", description: "stop current work" },
	{ name: "new", description: "start a fresh transcript" },
	{ name: "reload", description: "reload config and skills" },
	{ name: "restart", description: "restart Familiar" },
	{ name: "model", description: "show or set the model", argumentLabel: "model" },
	{ name: "thinking", description: "show or set thinking", argumentLabel: "level" },
	{ name: "channel-trigger", description: "show the Discord trigger note", argumentLabel: "mode" },
	{ name: "compact", description: "log a compaction request" },
] as const satisfies readonly ControlCommandDefinition[];

export type ControlCommand = (typeof CONTROL_COMMANDS)[number]["name"];

export interface ParsedControlCommandText {
	command: ControlCommand;
	args: string;
}

const controlCommandNames = new Set<string>(CONTROL_COMMANDS.map((command) => command.name));

export function isControlCommand(value: string): value is ControlCommand {
	return controlCommandNames.has(value);
}

export function parseControlCommandText(
	text: string,
	options: { allowBare?: boolean } = {},
): ParsedControlCommandText | undefined {
	const normalized = text.replace(/\s+/g, " ").trim();
	const [rawCommand = "", ...argParts] = normalized.split(" ");
	const slashCommand = rawCommand.startsWith("/");
	if (!slashCommand && !options.allowBare) return undefined;
	const command = rawCommand.replace(/^\//, "").toLowerCase();
	if (!isControlCommand(command)) return undefined;
	return { command, args: argParts.join(" ").trim() };
}

export function controlCommandCompletionQuery(text: string): string | undefined {
	const draft = text.trimStart();
	if (!draft.startsWith("/")) return undefined;
	const afterSlash = draft.slice(1);
	if (afterSlash.includes("\n") || /\s/.test(afterSlash)) return undefined;
	return afterSlash.toLowerCase();
}

export function matchingControlCommands(text: string): readonly ControlCommandDefinition[] {
	const query = controlCommandCompletionQuery(text);
	if (query === undefined) return [];
	return CONTROL_COMMANDS.filter((command) => command.name.startsWith(query));
}
