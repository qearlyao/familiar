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
	const body = options.body ?? "Read HEARTBEAT.md before replying. Do not finalize voice yet.";

	return `<heartbeat local_time="${formatLocalTimestamp(nowDate)}" idle_duration="${formatIdleDuration(idleDurationMs)}" idle_minutes="${idleMinutes}">\n${body}\n</heartbeat>`;
}

export function isHeartbeatDue(options: {
	now: number;
	lastUserInteractionAt: number;
	lastHeartbeatAt?: number;
	idleThresholdMs: number;
	intervalMs: number;
}): boolean {
	if (options.now < options.lastUserInteractionAt) return false;
	const idleDurationMs = options.now - options.lastUserInteractionAt;
	if (idleDurationMs < options.idleThresholdMs) return false;
	if (options.lastHeartbeatAt == null || options.lastHeartbeatAt <= options.lastUserInteractionAt) {
		return true;
	}
	return options.now - options.lastHeartbeatAt >= Math.max(0, options.intervalMs);
}
