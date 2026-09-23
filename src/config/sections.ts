import { daysInMonth } from "../runtime/scheduler.js";
import { isRecord, readEnum } from "../util/guards.js";
import { CRON_DELIVERY_MODES, CRON_FREQUENCIES } from "./enums.js";
import {
	assertKnownKeys,
	readBoolean,
	readConfigString,
	readOptionalConfigString,
	readOptionalIntegerInRange,
	readString,
	resolveWorkspacePath,
} from "./readers.js";
import type { Config } from "./types.js";

/** which frequencies each optional schedule field means anything for */
const CRON_FIELD_FREQUENCIES: Record<string, readonly string[]> = {
	runAt: ["once"],
	time: ["daily", "weekly", "monthly"],
	minute: ["hourly"],
	weekday: ["weekly"],
	day: ["monthly"],
};

const listFrequencies = new Intl.ListFormat("en", { type: "disjunction" });

/** config.toml spells two fields in snake_case; the override file and the cron tool use Config's camelCase */
export type CronJobSpelling = "toml" | "camel";
const TOML_SPELLING: Record<string, string> = { runAt: "run_at", deliveryMode: "delivery_mode" };

function assertCronTime(value: string | undefined, path: string): void {
	if (value === undefined) return;
	if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(value)) {
		throw new Error(`Config value ${path} must be HH:MM local time`);
	}
}

function assertCronRunAt(value: string | undefined, path: string): void {
	if (value === undefined) return;
	const match =
		/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(
			value,
		);
	if (
		match &&
		Number(match[3]) <= daysInMonth(Number(match[1]), Number(match[2]) - 1) &&
		Number.isFinite(Date.parse(value.replace(" ", "T")))
	)
		return;
	throw new Error(`Config value ${path} must be an ISO timestamp or YYYY-MM-DD HH:MM local time`);
}

export function readPromptOverrides(
	value: Record<string, unknown>,
	workspacePath: string,
	prefix: string,
): { prompt?: string; promptPath?: string; systemPrompt?: string; systemPromptPath?: string } {
	const prompt = readOptionalConfigString(value.prompt, `${prefix}.prompt`);
	const promptPath = readOptionalConfigString(value.prompt_path, `${prefix}.prompt_path`);
	const systemPrompt = readOptionalConfigString(value.system_prompt, `${prefix}.system_prompt`);
	const systemPromptPath = readOptionalConfigString(value.system_prompt_path, `${prefix}.system_prompt_path`);
	if (prompt && promptPath) throw new Error(`Set either ${prefix}.prompt or ${prefix}.prompt_path, not both`);
	if (systemPrompt && systemPromptPath) {
		throw new Error(`Set either ${prefix}.system_prompt or ${prefix}.system_prompt_path, not both`);
	}
	return {
		...(prompt ? { prompt } : {}),
		...(promptPath ? { promptPath: resolveWorkspacePath(workspacePath, promptPath) } : {}),
		...(systemPrompt ? { systemPrompt } : {}),
		...(systemPromptPath ? { systemPromptPath: resolveWorkspacePath(workspacePath, systemPromptPath) } : {}),
	};
}

export function readCronJobs(rawJobs: unknown, path: string, spelling: CronJobSpelling): Config["cron"]["jobs"] {
	if (rawJobs === undefined) return [];
	if (!Array.isArray(rawJobs)) throw new Error(`Config value ${path} must be an array`);
	const seen = new Set<string>();
	return rawJobs.map((rawJob, index) => {
		const job = readCronJob(rawJob, `${path}[${index}]`, spelling);
		if (seen.has(job.name)) throw new Error(`Duplicate cron job name: ${job.name}`);
		seen.add(job.name);
		return job;
	});
}

export function readCronJob(
	rawJob: unknown,
	prefix: string,
	spelling: CronJobSpelling,
): Config["cron"]["jobs"][number] {
	if (!isRecord(rawJob)) throw new Error(`Config value ${prefix} must be a table`);
	const job = rawJob;
	const key = (field: string) => (spelling === "toml" ? (TOML_SPELLING[field] ?? field) : field);
	const at = (field: string) => `${prefix}.${key(field)}`;
	assertKnownKeys(
		job,
		prefix,
		["name", "enabled", "frequency", "deliveryMode", "prompt", "runAt", "time", "minute", "weekday", "day"].map(key),
	);
	const name = readString(job.name, at("name"));
	if (!/^[A-Za-z0-9._=-]+$/.test(name)) {
		throw new Error(`Config value ${at("name")} may only contain letters, numbers, dot, underscore, equals, or dash`);
	}
	const frequency = readEnum(
		readConfigString(job.frequency, "once", at("frequency")),
		at("frequency"),
		CRON_FREQUENCIES,
	);
	const runAt = readOptionalConfigString(job[key("runAt")], at("runAt"));
	const time = readOptionalConfigString(job.time, at("time"));
	assertCronRunAt(runAt, at("runAt"));
	assertCronTime(time, at("time"));
	// rejected rather than ignored at fire time, where "wednesdays at 9" would quietly run daily
	for (const [field, allowed] of Object.entries(CRON_FIELD_FREQUENCIES)) {
		if (job[key(field)] !== undefined && !allowed.includes(frequency)) {
			throw new Error(`Config value ${at(field)} is only valid for ${listFrequencies.format(allowed)} jobs`);
		}
	}
	if (frequency === "once" && !runAt) throw new Error(`Config value ${at("runAt")} is required for once jobs`);
	if (frequency !== "once" && frequency !== "hourly" && !time) {
		throw new Error(`Config value ${at("time")} is required for ${frequency} jobs`);
	}
	return {
		name,
		enabled: readBoolean(job.enabled, true, at("enabled")),
		frequency,
		deliveryMode: readEnum(
			readConfigString(job[key("deliveryMode")], "queue", at("deliveryMode")),
			at("deliveryMode"),
			CRON_DELIVERY_MODES,
		),
		prompt: readString(job.prompt, at("prompt")),
		...(runAt ? { runAt } : {}),
		...(time ? { time } : {}),
		...(job.minute !== undefined ? { minute: readOptionalIntegerInRange(job.minute, at("minute"), 0, 59) } : {}),
		...(job.weekday !== undefined ? { weekday: readOptionalIntegerInRange(job.weekday, at("weekday"), 0, 6) } : {}),
		...(job.day !== undefined ? { day: readOptionalIntegerInRange(job.day, at("day"), 1, 31) } : {}),
	};
}

export function defaultBrowserAllowedSites(): Config["browser"]["allowedSites"] {
	return {
		twitter: true,
		xiaohongshu: true,
		rednote: true,
		reddit: true,
		bilibili: true,
		youtube: true,
		tiktok: true,
		douyin: true,
		spotify: true,
	};
}
