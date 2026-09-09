export function parseContactNickname(raw: string | null, fallback: string): string {
	let remaining = raw?.trim() ?? "";
	while (remaining.startsWith("<!--")) {
		const end = remaining.indexOf("-->");
		if (end === -1) return fallback;
		remaining = remaining.slice(end + 3).trim();
	}
	const firstLine = remaining
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("<!--"));
	return firstLine ?? fallback;
}
