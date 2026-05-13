import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { inspect } from "node:util";

type Args = {
	dataDir: string;
	date?: string;
	model?: string;
	session?: string;
	messages: number;
	full: boolean;
	diff: boolean;
};

type PayloadRecord = {
	ts?: string;
	direction?: string;
	sessionId?: string;
	sessionKey?: string;
	model?: string;
	payload?: Record<string, unknown>;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		dataDir: process.env.FAMILIAR_DATA_DIR || resolve(homedir(), ".familiar/data"),
		messages: 8,
		full: false,
		diff: false,
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
		} else if (arg === "--session" && next) {
			args.session = next;
			i++;
		} else if (arg === "--messages" && next) {
			args.messages = Math.max(0, Number.parseInt(next, 10) || args.messages);
			i++;
		} else if (arg === "--full") {
			args.full = true;
		} else if (arg === "--diff") {
			args.diff = true;
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
  --session <text>    only show requests whose session id/key includes text
  --messages <n>      number of tail messages to preview (default: 8)
  --diff              compare the latest request with the previous matching request
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

function recordModel(record: PayloadRecord): string {
	return String(record.payload?.model ?? record.model ?? "(unknown)");
}

function isRequest(record: PayloadRecord, args: Pick<Args, "model" | "session">): boolean {
	if (record.direction !== "request" || !record.payload) return false;
	if (args.model && !recordModel(record).includes(args.model) && !String(record.model ?? "").includes(args.model)) {
		return false;
	}
	if (
		args.session &&
		!String(record.sessionKey ?? "").includes(args.session) &&
		!String(record.sessionId ?? "").includes(args.session)
	) {
		return false;
	}
	return true;
}

function matchingRequests(records: PayloadRecord[], args: Pick<Args, "model" | "session">): PayloadRecord[] {
	return records.filter((record) => isRequest(record, args));
}

function findLatestRequest(records: PayloadRecord[], args: Pick<Args, "model" | "session">): PayloadRecord | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (record && isRequest(record, args)) return record;
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
	findObjectKeyLocations(payload, "cache_control", "$", locations);
	return locations;
}

function findObjectKeyLocations(value: unknown, key: string, path: string, locations: string[]): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => findObjectKeyLocations(item, key, `${path}[${index}]`, locations));
		return;
	}
	const record = value as Record<string, unknown>;
	if (key in record) locations.push(path);
	for (const [childKey, childValue] of Object.entries(record)) {
		findObjectKeyLocations(childValue, key, joinPath(path, childKey), locations);
	}
}

function anthropicCacheControlLocations(payload: Record<string, unknown>): string[] {
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
	const topLevelArrays = topLevelArraysForPreview(payload);
	const cacheControls = cacheControlLocations(payload);
	const anthropicCacheControls = anthropicCacheControlLocations(payload);

	console.log(`Payload log: ${path}`);
	console.log(`Timestamp: ${record.ts ?? "(unknown)"}`);
	console.log(`Session: ${record.sessionKey ?? "(unknown)"} (${record.sessionId ?? "no sessionId"})`);
	console.log(`Model: ${recordModel(record)}`);
	console.log(`Top-level keys: ${Object.keys(payload).sort().join(", ") || "(none)"}`);
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
	for (const location of anthropicCacheControls.length ? anthropicCacheControls : cacheControls) console.log(`  ${location}`);
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
	for (const [name, items] of topLevelArrays) {
		if (name === "messages" || name === "system" || name === "tools") continue;
		printArrayTail(name, items, args);
	}
}

function topLevelArraysForPreview(payload: Record<string, unknown>): Array<[string, unknown[]]> {
	return Object.entries(payload)
		.filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
		.sort(([a], [b]) => a.localeCompare(b));
}

function printArrayTail(name: string, items: unknown[], args: Args): void {
	console.log("");
	const start = Math.max(0, items.length - args.messages);
	console.log(`${name}: ${items.length} total, showing ${items.length - start} tail`);
	for (let index = start; index < items.length; index++) {
		const item = items[index];
		console.log(`  ${name}[${index}] ${summarizeValue(item, args)}`);
	}
}

type DiffLine = { path: string; detail: string };

function printDiff(before: PayloadRecord, after: PayloadRecord, args: Args, path: string): void {
	if (!before.payload || !after.payload) throw new Error("Selected records must contain request payloads");
	const beforePayload = before.payload;
	const afterPayload = after.payload;
	const diffLines: DiffLine[] = [];
	diffValue(beforePayload, afterPayload, "$", diffLines, args);
	const beforeCacheControls = cacheControlLocations(beforePayload);
	const afterCacheControls = cacheControlLocations(afterPayload);
	const beforeLcm = lcmSummaryLocations(beforePayload);
	const afterLcm = lcmSummaryLocations(afterPayload);

	console.log(`Payload log: ${path}`);
	console.log("Comparing latest request with previous matching request");
	console.log(`Previous: ${before.ts ?? "(unknown)"} ${before.sessionKey ?? "(unknown session)"} ${recordModel(before)}`);
	console.log(`Latest:   ${after.ts ?? "(unknown)"} ${after.sessionKey ?? "(unknown session)"} ${recordModel(after)}`);
	console.log(`Payload hash: ${hashValue(beforePayload).slice(0, 12)} -> ${hashValue(afterPayload).slice(0, 12)}`);
	console.log("");
	console.log("Summary:");
	const summaryLines = summaryDiffLines(beforePayload, afterPayload, args);
	if (summaryLines.length === 0) console.log("  (no payload changes)");
	for (const line of summaryLines.slice(0, 16)) console.log(`  ${line}`);
	if (summaryLines.length > 16) console.log(`  ... ${summaryLines.length - 16} more summary change(s)`);
	console.log("");
	console.log("Structure:");
	printTopLevelSummary(beforePayload, afterPayload);
	console.log("");
	printArraySummary("messages", beforePayload.messages, afterPayload.messages);
	printArraySummary("input", beforePayload.input, afterPayload.input);
	printArraySummary("contents", beforePayload.contents, afterPayload.contents);
	console.log("");
	console.log(`Cache controls: ${beforeCacheControls.length} -> ${afterCacheControls.length}`);
	printLocationChange(beforeCacheControls, afterCacheControls, args);
	console.log("");
	console.log(`LCM summaries: ${beforeLcm.length} -> ${afterLcm.length}`);
	printLocationChange(beforeLcm, afterLcm, args);
	console.log("");
	console.log("Changed paths:");
	if (diffLines.length === 0) {
		console.log("  (no payload changes)");
		return;
	}
	for (const line of diffLines.slice(0, 40)) console.log(`  ${line.path}: ${line.detail}`);
	if (diffLines.length > 40) console.log(`  ... ${diffLines.length - 40} more change(s)`);
}

function summaryDiffLines(before: Record<string, unknown>, after: Record<string, unknown>, args: Args): string[] {
	for (const key of ["input", "messages", "contents"]) {
		const beforeArray = before[key];
		const afterArray = after[key];
		if (Array.isArray(beforeArray) || Array.isArray(afterArray)) {
			const lines = summaryArrayLines(
				Array.isArray(beforeArray) ? beforeArray : [],
				Array.isArray(afterArray) ? afterArray : [],
				args,
			);
			if (lines.length > 0) return lines;
		}
	}
	return Object.keys(after)
		.sort()
		.filter((key) => hashValue(before[key]) !== hashValue(after[key]))
		.map((key) => `~ ${key}`);
}

function summaryArrayLines(before: unknown[], after: unknown[], args: Args): string[] {
	if (hashValue(before) === hashValue(after)) return [];
	const common = commonArrayShape(before, after);
	const beforeEnd = before.length - common.suffix;
	const afterEnd = after.length - common.suffix;
	const lines: string[] = [];
	for (let index = common.prefix; index < Math.max(beforeEnd, afterEnd); index++) {
		if (index >= beforeEnd) {
			lines.push(`+ ${summaryItem(after[index], args)}`);
		} else if (index >= afterEnd) {
			lines.push(`- ${summaryItem(before[index], args)}`);
		} else if (hashValue(before[index]) !== hashValue(after[index])) {
			const nested = nestedSummaryLines(before[index], after[index], args);
			if (nested.length > 0) lines.push(...nested);
			else lines.push(`~ ${summaryItem(after[index], args)}`);
		}
	}
	return lines;
}

function nestedSummaryLines(before: unknown, after: unknown, args: Args): string[] {
	if (hashValue(before) === hashValue(after)) return [];
	if (typeof before === "string" || typeof after === "string") return stringSummaryLines(before, after, args);
	if (Array.isArray(before) || Array.isArray(after)) {
		return summaryArrayLines(Array.isArray(before) ? before : [], Array.isArray(after) ? after : [], args);
	}
	if (isPlainObject(before) || isPlainObject(after)) {
		const beforeRecord = isPlainObject(before) ? before : {};
		const afterRecord = isPlainObject(after) ? after : {};
		const lines: string[] = [];
		for (const key of [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()) {
			if (hashValue(beforeRecord[key]) === hashValue(afterRecord[key])) continue;
			if (!(key in afterRecord)) lines.push(`- ${summaryItem(beforeRecord[key], args)}`);
			else if (!(key in beforeRecord)) lines.push(`+ ${summaryItem(afterRecord[key], args)}`);
			else lines.push(...nestedSummaryLines(beforeRecord[key], afterRecord[key], args));
		}
		return lines;
	}
	return [];
}

function stringSummaryLines(before: unknown, after: unknown, args: Args): string[] {
	if (typeof before !== "string" || typeof after !== "string") return [];
	const beforeMemory = xmlishBlocks(before).filter((block) => block.tag === "injected_memory");
	const afterMemory = xmlishBlocks(after).filter((block) => block.tag === "injected_memory");
	const lines: string[] = [];
	const max = Math.max(beforeMemory.length, afterMemory.length);
	for (let index = 0; index < max; index++) {
		const oldBlock = beforeMemory[index]?.body;
		const newBlock = afterMemory[index]?.body;
		if (oldBlock === newBlock) continue;
		if (oldBlock !== undefined) lines.push(`- <injected_memory> ${inlinePreview(oldBlock, args, 700)}`);
		if (newBlock !== undefined) lines.push(`+ <injected_memory> ${inlinePreview(newBlock, args, 700)}`);
	}
	if (lines.length > 0) return lines;
	return [`~ text ${inlinePreview(after, args, 220)}`];
}

function summaryItem(value: unknown, args: Args): string {
	const memory = firstXmlBlock(value, "injected_memory");
	if (memory !== undefined) return `<injected_memory> ${inlinePreview(memory, args, 700)}`;
	if (isPlainObject(value)) {
		const role = typeof value.role === "string" ? value.role : undefined;
		const type = typeof value.type === "string" ? value.type : undefined;
		const text = firstText(value);
		if (role === "assistant") return `assistant turn${text ? `: ${inlinePreview(text, args, 180)}` : ""}`;
		if (role === "user") return `user turn${text ? `: ${inlinePreview(text, args, 180)}` : ""}`;
		if (type) return `${type}${text ? `: ${inlinePreview(text, args, 180)}` : ""}`;
	}
	if (typeof value === "string") return `text: ${inlinePreview(value, args, 180)}`;
	return stripHash(summarizeValue(value, args));
}

function firstXmlBlock(value: unknown, tag: string): string | undefined {
	if (typeof value === "string") return xmlishBlocks(value).find((block) => block.tag === tag)?.body;
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstXmlBlock(item, tag);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = firstXmlBlock(child, tag);
		if (found !== undefined) return found;
	}
	return undefined;
}

function firstText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = firstText(item);
			if (found) return found;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of ["text", "content", "output"]) {
		if (typeof record[key] === "string") return record[key] as string;
	}
	for (const child of Object.values(record)) {
		const found = firstText(child);
		if (found) return found;
	}
	return undefined;
}

function inlinePreview(text: string, args: Args, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (args.full || compact.length <= max) return compact;
	return `${compact.slice(0, max)}... (${compact.length} chars, truncated)`;
}

function stripHash(value: string): string {
	return value.replace(/\s+hash=[0-9a-f]+/g, "");
}

function printTopLevelSummary(before: Record<string, unknown>, after: Record<string, unknown>): void {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const changed = keys.filter((key) => hashValue(before[key]) !== hashValue(after[key]));
	console.log(`Top-level keys changed: ${changed.length ? changed.join(", ") : "(none)"}`);
}

function printArraySummary(name: string, before: unknown, after: unknown): void {
	if (!Array.isArray(before) && !Array.isArray(after)) return;
	const beforeArray = Array.isArray(before) ? before : [];
	const afterArray = Array.isArray(after) ? after : [];
	const common = commonArrayShape(beforeArray, afterArray);
	console.log(
		`${name}: ${beforeArray.length} -> ${afterArray.length}; common prefix ${common.prefix}, suffix ${common.suffix}`,
	);
	if (common.firstChanged !== null) {
		console.log(`  first changed: ${name}[${common.firstChanged}]`);
	}
}

function printLocationChange(before: string[], after: string[], args: Args): void {
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	const added = after.filter((location) => !beforeSet.has(location));
	const removed = before.filter((location) => !afterSet.has(location));
	if (added.length === 0 && removed.length === 0) {
		for (const location of after.slice(0, 8)) console.log(`  ${location}`);
		if (after.length > 8) console.log(`  ... ${after.length - 8} more`);
		return;
	}
	for (const location of removed.slice(0, args.full ? removed.length : 8)) console.log(`  - ${location}`);
	for (const location of added.slice(0, args.full ? added.length : 8)) console.log(`  + ${location}`);
	const omitted = removed.length + added.length - (args.full ? removed.length + added.length : 16);
	if (omitted > 0) console.log(`  ... ${omitted} more location change(s)`);
}

function diffValue(before: unknown, after: unknown, path: string, lines: DiffLine[], args: Args): void {
	if (hashValue(before) === hashValue(after) || lines.length >= 200) return;
	if (typeof before === "string" || typeof after === "string") {
		lines.push({ path, detail: stringDiffDetail(before, after, args) });
		return;
	}
	if (Array.isArray(before) || Array.isArray(after)) {
		diffArray(Array.isArray(before) ? before : [], Array.isArray(after) ? after : [], path, lines, args);
		return;
	}
	if (isPlainObject(before) || isPlainObject(after)) {
		const beforeRecord = isPlainObject(before) ? before : {};
		const afterRecord = isPlainObject(after) ? after : {};
		for (const key of [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()) {
			diffValue(beforeRecord[key], afterRecord[key], joinPath(path, key), lines, args);
			if (lines.length >= 200) return;
		}
		return;
	}
	lines.push({
		path,
		detail: `${summarizeValue(before, args)} -> ${summarizeValue(after, args)}`,
	});
}

function diffArray(before: unknown[], after: unknown[], path: string, lines: DiffLine[], args: Args): void {
	const common = commonArrayShape(before, after);
	lines.push({
		path,
		detail: `array length ${before.length} -> ${after.length}; common prefix ${common.prefix}, suffix ${common.suffix}`,
	});
	const beforeEnd = before.length - common.suffix;
	const afterEnd = after.length - common.suffix;
	const maxItems = args.full ? Number.POSITIVE_INFINITY : 8;
	let shown = 0;
	for (let index = common.prefix; index < Math.max(beforeEnd, afterEnd); index++) {
		if (shown >= maxItems) {
			lines.push({ path, detail: `... ${Math.max(beforeEnd, afterEnd) - index} more changed item(s)` });
			return;
		}
		const childPath = `${path}[${index}]`;
		if (index >= beforeEnd) lines.push({ path: childPath, detail: `added ${summarizeValue(after[index], args)}` });
		else if (index >= afterEnd) lines.push({ path: childPath, detail: `removed ${summarizeValue(before[index], args)}` });
		else if (hashValue(before[index]) !== hashValue(after[index])) {
			if (isDrillablePair(before[index], after[index])) {
				diffValue(before[index], after[index], childPath, lines, args);
			} else {
				lines.push({
					path: childPath,
					detail: `${summarizeValue(before[index], args)} -> ${summarizeValue(after[index], args)}`,
				});
			}
		}
		shown++;
	}
}

function isDrillablePair(before: unknown, after: unknown): boolean {
	if (typeof before === "string" || typeof after === "string") return true;
	if (Array.isArray(before) || Array.isArray(after)) return true;
	return isPlainObject(before) || isPlainObject(after);
}

function commonArrayShape(before: unknown[], after: unknown[]): { prefix: number; suffix: number; firstChanged: number | null } {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && hashValue(before[prefix]) === hashValue(after[prefix])) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		hashValue(before[before.length - 1 - suffix]) === hashValue(after[after.length - 1 - suffix])
	) {
		suffix++;
	}
	return {
		prefix,
		suffix,
		firstChanged: prefix === before.length && prefix === after.length ? null : prefix,
	};
}

function summarizeValue(value: unknown, args: Args): string {
	if (value === undefined) return "(missing)";
	if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") return JSON.stringify(preview(value, args.full, 140));
	if (Array.isArray(value)) return `[${value.length} item(s)] hash=${hashValue(value).slice(0, 10)}`;
	if (!isPlainObject(value)) return typeof value;
	const role = typeof value.role === "string" ? ` role=${value.role}` : "";
	const type = typeof value.type === "string" ? ` type=${value.type}` : "";
	const name = typeof value.name === "string" ? ` name=${value.name}` : "";
	const text = blockText(value);
	const textSummary = text ? ` text=${JSON.stringify(preview(text, args.full, 120))}` : "";
	return `{${Object.keys(value).length} key(s)${role}${type}${name}${textSummary}} hash=${hashValue(value).slice(0, 10)}`;
}

function stringDiffDetail(before: unknown, after: unknown, args: Args): string {
	if (typeof before !== "string" || typeof after !== "string") {
		return `${summarizeValue(before, args)} -> ${summarizeValue(after, args)}`;
	}
	const blockDiff = xmlishBlockDiff(before, after, args);
	if (blockDiff) return blockDiff;
	const common = commonStringShape(before, after);
	return `text len ${before.length} -> ${after.length}; common prefix ${common.prefix}, suffix ${common.suffix}\n${indent(
		`- ${previewChangedSlice(before, common, args)}\n+ ${previewChangedSlice(after, common, args)}`,
		4,
	)}`;
}

function xmlishBlockDiff(before: string, after: string, args: Args): string | null {
	const beforeBlocks = xmlishBlocks(before);
	const afterBlocks = xmlishBlocks(after);
	if (beforeBlocks.length === 0 && afterBlocks.length === 0) return null;
	const beforeByTag = blocksByTag(beforeBlocks);
	const afterByTag = blocksByTag(afterBlocks);
	const tags = [...new Set([...beforeByTag.keys(), ...afterByTag.keys()])].sort();
	const lines: string[] = [];
	for (const tag of tags) {
		const previous = beforeByTag.get(tag) ?? [];
		const current = afterByTag.get(tag) ?? [];
		const max = Math.max(previous.length, current.length);
		for (let index = 0; index < max; index++) {
			const oldText = previous[index];
			const newText = current[index];
			const label = max > 1 ? `<${tag}>[${index}]` : `<${tag}>`;
			if (oldText === newText) continue;
			if (oldText === undefined) {
				lines.push(`+ ${label} ${previewXmlBlock(newText ?? "", args)}`);
			} else if (newText === undefined) {
				lines.push(`- ${label} ${previewXmlBlock(oldText, args)}`);
			} else {
				lines.push(`~ ${label} len ${oldText.length} -> ${newText.length}`);
				lines.push(`  - ${previewXmlBlock(oldText, args)}`);
				lines.push(`  + ${previewXmlBlock(newText, args)}`);
			}
		}
	}
	if (lines.length === 0) return null;
	return `text block changes:\n${indent(lines.join("\n"), 4)}`;
}

function xmlishBlocks(text: string): Array<{ tag: string; body: string }> {
	const blocks: Array<{ tag: string; body: string }> = [];
	const pattern = /<([A-Za-z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const tag = match[1];
		const body = match[2];
		if (tag && body !== undefined) blocks.push({ tag, body: body.trim() });
	}
	return blocks;
}

function blocksByTag(blocks: Array<{ tag: string; body: string }>): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const block of blocks) {
		const values = map.get(block.tag) ?? [];
		values.push(block.body);
		map.set(block.tag, values);
	}
	return map;
}

function commonStringShape(before: string, after: string): { prefix: number; suffix: number } {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}
	return { prefix, suffix };
}

function previewChangedSlice(text: string, common: { prefix: number; suffix: number }, args: Args): string {
	const end = common.suffix ? text.length - common.suffix : text.length;
	const slice = text.slice(common.prefix, end).trim();
	if (!slice) return "(empty)";
	return JSON.stringify(preview(slice, args.full, 360));
}

function previewXmlBlock(text: string, args: Args): string {
	return JSON.stringify(preview(text.trim(), args.full, 500));
}

function lcmSummaryLocations(payload: Record<string, unknown>): string[] {
	const locations: string[] = [];
	findStringLocations(payload, "[retained LCM summary]", "$", locations);
	return locations;
}

function findStringLocations(value: unknown, needle: string, path: string, locations: string[]): void {
	if (typeof value === "string") {
		if (value.includes(needle)) locations.push(path);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => findStringLocations(item, needle, `${path}[${index}]`, locations));
		return;
	}
	for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
		findStringLocations(childValue, needle, joinPath(path, key), locations);
	}
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function joinPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
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
	if (args.diff) {
		const requests = matchingRequests(records, args);
		if (requests.length < 2) {
			throw new Error(`Need at least two matching request records in ${path}; found ${requests.length}`);
		}
		printDiff(requests[requests.length - 2] as PayloadRecord, requests[requests.length - 1] as PayloadRecord, args, path);
		return;
	}
	const record = findLatestRequest(records, args);
	if (!record) throw new Error(`No matching request found in ${path}`);
	printRequest(record, args, path);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
