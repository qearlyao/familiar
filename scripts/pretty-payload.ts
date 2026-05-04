import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { inspect } from "node:util";

type Args = {
	dataDir: string;
	date?: string;
	model?: string;
	messages: number;
	full: boolean;
};

type PayloadRecord = {
	ts?: string;
	direction?: string;
	model?: string;
	payload?: Record<string, unknown>;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		dataDir: process.env.FAMILIAR_DATA_DIR || resolve(homedir(), ".familiar/data"),
		messages: 8,
		full: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--data-dir" && next) {
			args.dataDir = next;
			i++;
		} else if (arg === "--date" && next) {
			args.date = next;
			i++;
		} else if (arg === "--model" && next) {
			args.model = next;
			i++;
		} else if (arg === "--messages" && next) {
			args.messages = Math.max(0, Number.parseInt(next, 10) || args.messages);
			i++;
		} else if (arg === "--full") {
			args.full = true;
		} else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
	}
	return args;
}

function printHelp(): void {
	console.log(`Usage: npm run payload:pretty -- [options]

Options:
  --data-dir <path>   familiar data dir (default: ~/.familiar/data)
  --date <YYYY-MM-DD> payload log date (default: latest file)
  --model <text>      only show requests whose model includes text
  --messages <n>      number of tail messages to preview (default: 8)
  --full              print full text instead of compact previews
`);
}

async function latestPayloadPath(dataDir: string, date?: string): Promise<string> {
	const payloadDir = resolve(dataDir, "payloads");
	if (date) return resolve(payloadDir, `${date}.jsonl`);
	const files = (await readdir(payloadDir)).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
	const latest = files.at(-1);
	if (!latest) throw new Error(`No payload logs found in ${payloadDir}`);
	return resolve(payloadDir, latest);
}

function parseJsonl(contents: string): PayloadRecord[] {
	const records: PayloadRecord[] = [];
	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as PayloadRecord);
		} catch (error) {
			console.error(`Skipping unparsable line ${index + 1}:`, error instanceof Error ? error.message : error);
		}
	}
	return records;
}

function isAnthropicRequest(record: PayloadRecord, modelFilter?: string): boolean {
	if (record.direction !== "request" || !record.payload) return false;
	const payloadModel = typeof record.payload.model === "string" ? record.payload.model : "";
	const logModel = typeof record.model === "string" ? record.model : "";
	if (!payloadModel || !Array.isArray(record.payload.messages)) return false;
	if (modelFilter && !payloadModel.includes(modelFilter) && !logModel.includes(modelFilter)) return false;
	return payloadModel.includes("claude") || Array.isArray(record.payload.system);
}

function findLatestAnthropic(records: PayloadRecord[], modelFilter?: string): PayloadRecord | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		if (isAnthropicRequest(records[i], modelFilter)) return records[i];
	}
	return undefined;
}

function preview(value: unknown, full: boolean, max = 220): string {
	if (typeof value !== "string") return inspect(value, { depth: 5, colors: false, compact: false });
	if (full || value.length <= max) return value;
	return `${value.slice(0, max)}... (${value.length} chars)`;
}

function blockText(block: unknown): string {
	if (!block || typeof block !== "object") return "";
	const record = block as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.thinking === "string") return record.thinking;
	if (typeof record.content === "string") return record.content;
	return "";
}

function contentType(block: unknown): string {
	if (!block || typeof block !== "object") return typeof block;
	const record = block as Record<string, unknown>;
	if (typeof record.type === "string") return record.type;
	if ("tool_use_id" in record) return "tool_result";
	if ("cache_control" in record) return "unknown+cache_control";
	return Object.keys(record).join("+") || "object";
}

function cacheControlLocations(payload: Record<string, unknown>): string[] {
	const locations: string[] = [];
	const system = payload.system;
	if (Array.isArray(system)) {
		system.forEach((block, i) => {
			if (block && typeof block === "object" && "cache_control" in block) locations.push(`system[${i}]`);
		});
	}
	const tools = payload.tools;
	if (Array.isArray(tools)) {
		tools.forEach((tool, i) => {
			if (tool && typeof tool === "object" && "cache_control" in tool) {
				locations.push(`tools[${i}] ${(tool as { name?: unknown }).name ?? ""}`.trim());
			}
		});
	}
	const messages = payload.messages;
	if (Array.isArray(messages)) {
		messages.forEach((message, i) => {
			const role = message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;
			const content =
				message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
			if (!Array.isArray(content)) return;
			content.forEach((block, j) => {
				if (block && typeof block === "object" && "cache_control" in block) {
					locations.push(`messages[${i}].content[${j}] role=${String(role)} type=${contentType(block)}`);
				}
			});
		});
	}
	return locations;
}

function sectionNames(systemText: string): string[] {
	return [...systemText.matchAll(/<([A-Z][A-Z-]+)>/g)].map((match) => match[1]);
}

function printRequest(record: PayloadRecord, args: Args, path: string): void {
	const payload = record.payload;
	if (!payload) throw new Error("Selected record has no payload");
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const system = Array.isArray(payload.system) ? payload.system : [];
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const cacheControls = cacheControlLocations(payload);

	console.log(`Payload log: ${path}`);
	console.log(`Timestamp: ${record.ts ?? "(unknown)"}`);
	console.log(`Model: ${String(payload.model ?? record.model ?? "(unknown)")}`);
	console.log(`Max tokens: ${String(payload.max_tokens ?? "(unset)")}`);
	console.log(`Thinking: ${inspect(payload.thinking ?? "(unset)", { depth: 4, colors: false, compact: true })}`);
	console.log(
		`Output config: ${inspect(payload.output_config ?? "(unset)", { depth: 4, colors: false, compact: true })}`,
	);
	console.log("");

	console.log(`System blocks: ${system.length}`);
	for (const [i, block] of system.entries()) {
		const text = blockText(block);
		console.log(`  system[${i}] textLen=${text.length} sections=${sectionNames(text).join(", ") || "(none)"}`);
		console.log(indent(preview(text, args.full), 4));
	}
	console.log("");

	console.log(`Tools: ${tools.length}`);
	for (const [i, tool] of tools.entries()) {
		const name = tool && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined;
		const hasCache = !!(tool && typeof tool === "object" && "cache_control" in tool);
		console.log(`  tools[${i}] ${String(name ?? "(unnamed)")}${hasCache ? " [cache_control]" : ""}`);
	}
	console.log("");

	console.log(`Cache controls: ${cacheControls.length}`);
	for (const location of cacheControls) console.log(`  ${location}`);
	console.log("");

	const start = Math.max(0, messages.length - args.messages);
	console.log(`Messages: ${messages.length} total, showing ${messages.length - start} tail`);
	for (let i = start; i < messages.length; i++) {
		const message = messages[i] as { role?: unknown; content?: unknown };
		console.log(`  messages[${i}] role=${String(message.role ?? "(unknown)")}`);
		if (typeof message.content === "string") {
			console.log(indent(preview(message.content, args.full), 4));
			continue;
		}
		if (!Array.isArray(message.content)) {
			console.log(indent(inspect(message.content, { depth: 4, colors: false, compact: false }), 4));
			continue;
		}
		for (const [j, block] of message.content.entries()) {
			const text = blockText(block);
			const hasCache = !!(block && typeof block === "object" && "cache_control" in block);
			console.log(
				`    content[${j}] type=${contentType(block)} textLen=${text.length}${hasCache ? " [cache_control]" : ""}`,
			);
			if (text) console.log(indent(preview(text, args.full), 6));
		}
	}
}

function indent(value: string, spaces: number): string {
	const prefix = " ".repeat(spaces);
	return value
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const path = await latestPayloadPath(args.dataDir, args.date);
	if (!existsSync(path)) throw new Error(`Payload log does not exist: ${path}`);
	const records = parseJsonl(await readFile(path, "utf8"));
	const record = findLatestAnthropic(records, args.model);
	if (!record) throw new Error(`No Anthropic request found in ${path}`);
	printRequest(record, args, path);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
