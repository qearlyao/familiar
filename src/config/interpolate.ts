export function interpolateEnv(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
		return process.env[name] ?? fallback ?? "";
	});
}

export function interpolateValue(value: unknown): unknown {
	if (typeof value === "string") return interpolateEnv(value);
	if (Array.isArray(value)) return value.map(interpolateValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, interpolateValue(child)]));
	}
	return value;
}
