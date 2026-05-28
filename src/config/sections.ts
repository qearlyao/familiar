import { readEnum } from "../util/guards.js";
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

function assertCronTime(value: string | undefined, path: string): void {
	if (value === undefined) return;
	if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(value)) {
		throw new Error(`Config value ${path} must be HH:MM local time`);
	}
}

function assertCronRunAt(value: string | undefined, path: string): void {
	if (value === undefined) return;
	if (Number.isFinite(Date.parse(value))) return;
	if (/^\d{4}-\d{2}-\d{2}[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.test(value)) return;
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

export function readCronJobs(cron: Record<string, unknown>): Config["cron"]["jobs"] {
	const rawJobs = cron.jobs;
	if (rawJobs === undefined) return [];
	if (!Array.isArray(rawJobs)) throw new Error("Config value cron.jobs must be an array");
	const seen = new Set<string>();
	return rawJobs.map((rawJob, index) => {
		if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) {
			throw new Error(`Config value cron.jobs[${index}] must be a table`);
		}
		const job = rawJob as Record<string, unknown>;
		const prefix = `cron.jobs[${index}]`;
		assertKnownKeys(job, prefix, [
			"id",
			"enabled",
			"frequency",
			"delivery_mode",
			"prompt",
			"run_at",
			"time",
			"minute",
			"weekday",
			"day",
		]);
		const id = readString(job.id, `${prefix}.id`);
		if (!/^[A-Za-z0-9._=-]+$/.test(id)) {
			throw new Error(
				`Config value ${prefix}.id may only contain letters, numbers, dot, underscore, equals, or dash`,
			);
		}
		if (seen.has(id)) throw new Error(`Duplicate cron job id: ${id}`);
		seen.add(id);
		const frequency = readEnum(
			readConfigString(job.frequency, "once", `${prefix}.frequency`),
			`${prefix}.frequency`,
			CRON_FREQUENCIES,
		);
		const runAt = readOptionalConfigString(job.run_at, `${prefix}.run_at`);
		const time = readOptionalConfigString(job.time, `${prefix}.time`);
		assertCronRunAt(runAt, `${prefix}.run_at`);
		assertCronTime(time, `${prefix}.time`);
		if (frequency === "once" && !runAt) throw new Error(`Config value ${prefix}.run_at is required for once jobs`);
		if (frequency === "once" && time) throw new Error(`Config value ${prefix}.time is only valid for repeating jobs`);
		if (frequency !== "once" && runAt) throw new Error(`Config value ${prefix}.run_at is only valid for once jobs`);
		if (frequency !== "once" && frequency !== "hourly" && !time) {
			throw new Error(`Config value ${prefix}.time is required for ${frequency} jobs`);
		}
		return {
			id,
			enabled: readBoolean(job.enabled, true, `${prefix}.enabled`),
			frequency,
			deliveryMode: readEnum(
				readConfigString(job.delivery_mode, "queue", `${prefix}.delivery_mode`),
				`${prefix}.delivery_mode`,
				CRON_DELIVERY_MODES,
			),
			prompt: readString(job.prompt, `${prefix}.prompt`),
			...(runAt ? { runAt } : {}),
			...(time ? { time } : {}),
			...(job.minute !== undefined
				? { minute: readOptionalIntegerInRange(job.minute, `${prefix}.minute`, 0, 59) }
				: {}),
			...(job.weekday !== undefined
				? { weekday: readOptionalIntegerInRange(job.weekday, `${prefix}.weekday`, 0, 6) }
				: {}),
			...(job.day !== undefined ? { day: readOptionalIntegerInRange(job.day, `${prefix}.day`, 1, 31) } : {}),
		};
	});
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
