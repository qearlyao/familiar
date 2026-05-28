import net from "node:net";

import { ProviderError } from "./types.js";

export function isBlockedHostname(hostname: string): boolean {
	if (
		hostname === "localhost" ||
		hostname === "metadata.google.internal" ||
		hostname === "metadata" ||
		hostname === "169.254.169.254" ||
		hostname === "169.254.169.250" ||
		hostname === "100.100.100.200" ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".home")
	) {
		return true;
	}

	const ipVersion = net.isIP(hostname);
	if (ipVersion === 4) {
		const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
		const [a, b] = octets;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a >= 224) return true;
		return false;
	}

	if (ipVersion === 6) {
		const normalized = hostname.toLowerCase();
		return (
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			normalized.startsWith("fe8") ||
			normalized.startsWith("fe9") ||
			normalized.startsWith("fea") ||
			normalized.startsWith("feb") ||
			normalized.startsWith("ff")
		);
	}

	return false;
}

export function validateFetchUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Invalid URL: URL is required.");
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("Invalid URL: malformed URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Invalid URL: only http and https URLs are allowed.");
	}
	if (parsed.username || parsed.password) {
		throw new Error("Invalid URL: embedded credentials are not allowed.");
	}
	const hostname = parsed.hostname.replaceAll(/^\[|\]$/g, "").toLowerCase();
	if (!hostname) throw new Error("Invalid URL: hostname is required.");
	if (isBlockedHostname(hostname)) throw new Error("Blocked URL: target host is not allowed.");
	return parsed.toString();
}

export function isTransientProviderError(error: unknown): boolean {
	return error instanceof ProviderError ? error.transient : false;
}
