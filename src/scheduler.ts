import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type CronFrequency = "once" | "hourly" | "daily" | "weekly" | "monthly";
export type CronDeliveryMode = "queue" | "follow_up";

export interface CronJobConfig {
	id: string;
	enabled: boolean;
	frequency: CronFrequency;
	deliveryMode: CronDeliveryMode;
	prompt: string;
	runAt?: string;
	time?: string;
	minute?: number;
	weekday?: number;
	day?: number;
}

export interface CronJobState {
	lastFiredSlot?: string;
	lastFiredAt?: string;
	completed?: boolean;
}

export interface SchedulerState {
	heartbeat?: {
		lastFiredAt?: string;
	};
	cron: Record<string, CronJobState>;
}

export interface SchedulerLogEvent {
	ts?: string;
	type: "cron_due" | "cron_skipped" | "cron_started" | "cron_completed" | "cron_failed";
	jobId: string;
	slot?: string;
	deliveryMode?: CronDeliveryMode;
	detail?: string;
}

const stateWriteQueues = new Map<string, Promise<void>>();

function toDate(value: Date | number | string): Date {
	if (value instanceof Date) return value;
	return new Date(value);
}

function formatOffset(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absolute = Math.abs(offsetMinutes);
	const hours = Math.floor(absolute / 60);
	const minutes = absolute % 60;
	return minutes === 0 ? `GMT${sign}${hours}` : `GMT${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

export function formatLocalTimestamp(value: Date | number | string): string {
	const date = toDate(value);
	if (Number.isNaN(date.getTime())) return String(value);
	const localDate = [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
	const localTime = [
		String(date.getHours()).padStart(2, "0"),
		String(date.getMinutes()).padStart(2, "0"),
		String(date.getSeconds()).padStart(2, "0"),
	].join(":");
	return `${localDate} ${localTime} ${formatOffset(date)}`;
}

export function formatIdleDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const totalMinutes = Math.floor(ms / 60000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) {
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}
	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
}

export function buildHeartbeatInjectionText(options: {
	now: Date | number | string;
	idleSince: Date | number | string;
	body?: string;
}): string {
	const nowDate = toDate(options.now);
	const idleSinceDate = toDate(options.idleSince);
	const idleDurationMs = Math.max(0, nowDate.getTime() - idleSinceDate.getTime());
	const idleMinutes = Math.floor(idleDurationMs / 60000);
	const body =
		options.body ??
		`hey~ been quiet for a bit. this is your time now.

what you do with it is up to you — HEARTBEAT.md has the menu if you don't remember it. once you know the shape of it you don't have to re-read every fire, just trust what you remember and pick what fits.

it's okay to sit one out, but only when that's actually the real answer — not when it's the easy one.`;

	return `<heartbeat local_time="${formatLocalTimestamp(nowDate)}" idle_duration="${formatIdleDuration(idleDurationMs)}" idle_minutes="${idleMinutes}">\n${body}\n</heartbeat>`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function localDateKey(date: Date): string {
	return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-");
}

function parseTimeOfDay(value: string): { hour: number; minute: number } {
	const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
	if (!match) throw new Error(`Invalid cron time: ${value}`);
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseLocalDateTime(value: string): Date {
	const normalized = value.trim().replace("T", " ");
	const match = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(normalized);
	if (!match) return new Date(value);
	return new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		Number(match[4]),
		Number(match[5]),
		Number(match[6] ?? 0),
	);
}

function daysInMonth(year: number, month: number): number {
	return new Date(year, month + 1, 0).getDate();
}

function scheduledDate(year: number, month: number, day: number, time: { hour: number; minute: number }): Date {
	const clampedDay = Math.min(day, daysInMonth(year, month));
	// Local Date construction follows host timezone DST rules; rare skipped or repeated wall-clock hours are acceptable for v0.
	return new Date(year, month, clampedDay, time.hour, time.minute, 0, 0);
}

function cronSlotKey(job: CronJobConfig, date: Date): string {
	return `${job.id}:${job.frequency}:${localDateKey(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function latestScheduledDate(job: CronJobConfig, now: Date): Date | undefined {
	if (job.frequency === "once") {
		if (!job.runAt) return undefined;
		const runAt = parseLocalDateTime(job.runAt);
		return now.getTime() >= runAt.getTime() ? runAt : undefined;
	}
	if (job.frequency === "hourly") {
		const minute = job.minute ?? 0;
		const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), minute, 0, 0);
		if (candidate.getTime() <= now.getTime()) return candidate;
		return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 1, minute, 0, 0);
	}
	const time = parseTimeOfDay(job.time ?? "00:00");
	if (job.frequency === "daily") {
		const candidate = scheduledDate(now.getFullYear(), now.getMonth(), now.getDate(), time);
		if (candidate.getTime() <= now.getTime()) return candidate;
		return scheduledDate(now.getFullYear(), now.getMonth(), now.getDate() - 1, time);
	}
	if (job.frequency === "weekly") {
		const weekday = job.weekday ?? 0;
		const daysSince = (now.getDay() - weekday + 7) % 7;
		const candidate = scheduledDate(now.getFullYear(), now.getMonth(), now.getDate() - daysSince, time);
		if (candidate.getTime() <= now.getTime()) return candidate;
		return scheduledDate(now.getFullYear(), now.getMonth(), now.getDate() - daysSince - 7, time);
	}
	const day = job.day ?? 1;
	const candidate = scheduledDate(now.getFullYear(), now.getMonth(), day, time);
	if (candidate.getTime() <= now.getTime()) return candidate;
	return scheduledDate(now.getFullYear(), now.getMonth() - 1, day, time);
}

export function dueCronSlot(
	job: CronJobConfig,
	state: CronJobState | undefined,
	now: Date | number,
): string | undefined {
	if (!job.enabled) return undefined;
	if (state?.completed) return undefined;
	const nowDate = toDate(now);
	const scheduled = latestScheduledDate(job, nowDate);
	if (!scheduled) return undefined;
	const slot = cronSlotKey(job, scheduled);
	return state?.lastFiredSlot === slot ? undefined : slot;
}

export function buildCronInjectionText(options: {
	job: CronJobConfig;
	now: Date | number | string;
	slot: string;
}): string {
	const nowDate = toDate(options.now);
	return `<cron id="${options.job.id}" frequency="${options.job.frequency}" delivery="${options.job.deliveryMode}" local_time="${formatLocalTimestamp(nowDate)}" slot="${options.slot}">\n${options.job.prompt}\n</cron>`;
}

export function schedulerStatePath(dataDir: string): string {
	return resolve(dataDir, "scheduler", "cron-state.json");
}

export function schedulerLogPath(dataDir: string, now = new Date()): string {
	return resolve(dataDir, "scheduler", `${now.toISOString().slice(0, 10)}.jsonl`);
}

export async function loadSchedulerState(dataDir: string): Promise<SchedulerState> {
	const path = schedulerStatePath(dataDir);
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<SchedulerState>;
		return {
			heartbeat:
				parsed.heartbeat && typeof parsed.heartbeat === "object" && !Array.isArray(parsed.heartbeat)
					? parsed.heartbeat
					: undefined,
			cron: parsed.cron && typeof parsed.cron === "object" && !Array.isArray(parsed.cron) ? parsed.cron : {},
		};
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { cron: {} };
		throw error;
	}
}

export async function saveSchedulerState(dataDir: string, state: SchedulerState): Promise<void> {
	const path = schedulerStatePath(dataDir);
	const prior = stateWriteQueues.get(path) ?? Promise.resolve();
	const write = prior.then(async () => {
		await mkdir(dirname(path), { recursive: true });
		const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(tempPath, path);
	});
	const queued: Promise<void> = write.catch(() => undefined);
	stateWriteQueues.set(path, queued);
	void queued.finally(() => {
		if (stateWriteQueues.get(path) === queued) stateWriteQueues.delete(path);
	});
	await write;
}

export async function appendSchedulerLog(dataDir: string, event: SchedulerLogEvent): Promise<void> {
	const record = { ...event, ts: event.ts ?? new Date().toISOString() };
	const path = schedulerLogPath(dataDir);
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function isHeartbeatDue(options: {
	now: number;
	lastUserInteractionAt: number;
	lastHeartbeatAt?: string;
	idleThresholdMs: number;
	intervalMs: number;
}): boolean {
	if (options.now < options.lastUserInteractionAt) return false;
	const idleDurationMs = options.now - options.lastUserInteractionAt;
	if (idleDurationMs < options.idleThresholdMs) return false;
	const lastHeartbeatAt = options.lastHeartbeatAt ? Date.parse(options.lastHeartbeatAt) : undefined;
	if (lastHeartbeatAt == null || !Number.isFinite(lastHeartbeatAt) || lastHeartbeatAt <= options.lastUserInteractionAt) {
		return true;
	}
	return options.now - lastHeartbeatAt >= Math.max(0, options.intervalMs);
}
