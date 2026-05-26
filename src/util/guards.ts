export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value === "string" && allowed.includes(value as T)) return value as T;
	throw new Error(`Config value ${path} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`);
}
