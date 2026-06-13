import { spawn as nodeSpawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import type { Config } from "../config/index.js";
import type { BrowserHarnessTargetConfig } from "../config/types.js";
import { isRecord } from "../util/guards.js";

const BROWSER_USE_API_BASE = "https://api.browser-use.com/api/v3";
const CDP_READY_PATH = "/json/version";
const CLOUD_EXPIRY_SKEW_MS = 30_000;
const CDP_POLL_MS = 100;

export type BrowserHarnessTarget = {
	env: NodeJS.ProcessEnv;
	liveUrl?: string;
};

type BrowserUseCloudBrowser = {
	id: string;
	cdpWs: string;
	liveUrl?: string;
	expiresAtMs?: number;
};

type BrowserUseProfile = {
	id: string;
	name?: string;
};

const cloudBrowsers = new Map<string, BrowserUseCloudBrowser>();

function stringArg(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value).trim();
	return text ? text : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
	return isRecord(value) ? stringArg(value[field]) : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
	return isRecord(value) && typeof value[field] === "number" ? value[field] : undefined;
}

function parseTimeMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function withoutTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
	return value.slice(0, end);
}

function cloudExpiresAt(created: unknown, timeoutMinutes?: number): number | undefined {
	const explicit = parseTimeMs(isRecord(created) ? created.timeoutAt : undefined);
	if (explicit !== undefined) return explicit;
	const timeoutSeconds = numberField(created, "timeoutSeconds");
	if (timeoutSeconds !== undefined) return Date.now() + timeoutSeconds * 1000;
	if (timeoutMinutes !== undefined) return Date.now() + timeoutMinutes * 60_000;
	return undefined;
}

function isUsableCloudBrowser(browser: BrowserUseCloudBrowser): boolean {
	return browser.expiresAtMs === undefined || browser.expiresAtMs - CLOUD_EXPIRY_SKEW_MS > Date.now();
}

async function fetchJson(url: string, options: RequestInit, context: string, timeoutMs = 60_000): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const detail = body.trim() ? `: ${body.trim().slice(0, 300)}` : "";
		throw new Error(`${context} failed with HTTP ${response.status}${detail}`);
	}
	const text = await response.text();
	return text.trim() ? JSON.parse(text) : {};
}

async function browserUseJson(path: string, method: string, apiKey: string, body?: unknown): Promise<unknown> {
	return fetchJson(
		`${BROWSER_USE_API_BASE}${path}`,
		{
			method,
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				"X-Browser-Use-API-Key": apiKey,
			},
		},
		`Browser Use ${method} ${path}`,
	);
}

function requireStringField(value: unknown, field: string, context: string): string {
	const read = stringField(value, field);
	if (!read) throw new Error(`${context} did not return ${field}.`);
	return read;
}

async function cdpWebSocketFromUrl(cdpUrl: string): Promise<string> {
	const base = withoutTrailingSlashes(cdpUrl);
	const json = await fetchJson(`${base}${CDP_READY_PATH}`, {}, `CDP endpoint ${base}`, 15_000);
	return requireStringField(json, "webSocketDebuggerUrl", `CDP endpoint ${base}`);
}

async function cdpEndpointReady(cdpUrl: string): Promise<boolean> {
	const base = withoutTrailingSlashes(cdpUrl);
	try {
		await fetchJson(`${base}${CDP_READY_PATH}`, {}, `CDP endpoint ${base}`, 2_000);
		return true;
	} catch {
		return false;
	}
}

async function waitForCdpEndpoint(cdpUrl: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cdpEndpointReady(cdpUrl)) return;
		await sleep(Math.min(CDP_POLL_MS, Math.max(1, deadline - Date.now())));
	}
	throw new Error(`Browser CDP endpoint did not become ready: ${cdpUrl}`);
}

async function startHarnessBrowserProcess(target: Extract<BrowserHarnessTargetConfig, { mode: "cdp" }>): Promise<void> {
	const command = target.launchCommand;
	if (!command) return;
	await new Promise<void>((resolve, reject) => {
		const child = nodeSpawn(command, target.launchArgs, {
			detached: true,
			env: process.env,
			stdio: "ignore",
		});
		child.once("error", (error) => {
			reject(new Error(`Failed to launch browser command "${command}": ${error.message}`));
		});
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

async function prepareCdpHarnessTarget(config: Config): Promise<BrowserHarnessTarget> {
	const target = config.browser.harnessTarget;
	if (target.mode !== "cdp") throw new Error("Browser harness target is not configured for CDP.");
	if (target.cdpUrl && !(await cdpEndpointReady(target.cdpUrl))) {
		if (!target.launchCommand) {
			throw new Error(`Browser CDP endpoint is not reachable: ${target.cdpUrl}`);
		}
		await startHarnessBrowserProcess(target);
		await waitForCdpEndpoint(target.cdpUrl, config.browser.timeoutMs);
	}
	return {
		env: {
			...(target.cdpUrl ? { BU_CDP_URL: target.cdpUrl } : {}),
			...(target.cdpWs ? { BU_CDP_WS: target.cdpWs } : {}),
		},
	};
}

async function listBrowserUseProfiles(apiKey: string): Promise<BrowserUseProfile[]> {
	const profiles: BrowserUseProfile[] = [];
	for (let page = 1; ; page += 1) {
		const listing = await browserUseJson(`/profiles?pageSize=100&pageNumber=${page}`, "GET", apiKey);
		const items =
			isRecord(listing) && Array.isArray(listing.items) ? listing.items : Array.isArray(listing) ? listing : [];
		if (items.length === 0) return profiles;
		for (const item of items) {
			const id = stringField(item, "id");
			if (!id) continue;
			const detail = await browserUseJson(`/profiles/${encodeURIComponent(id)}`, "GET", apiKey);
			profiles.push({
				id: requireStringField(detail, "id", "Browser Use profile"),
				name: stringField(detail, "name"),
			});
		}
		const total = isRecord(listing) && typeof listing.totalItems === "number" ? listing.totalItems : undefined;
		if (total !== undefined && profiles.length >= total) return profiles;
	}
}

async function resolveBrowserUseProfileId(
	target: Extract<BrowserHarnessTargetConfig, { mode: "cloud" }>,
	apiKey: string,
): Promise<string | undefined> {
	if (target.profileId) return target.profileId;
	if (!target.profileName) return undefined;
	const matches = (await listBrowserUseProfiles(apiKey)).filter((profile) => profile.name === target.profileName);
	if (matches.length === 0) {
		throw new Error(`No Browser Use cloud profile named "${target.profileName}".`);
	}
	if (matches.length > 1) {
		throw new Error(`Multiple Browser Use cloud profiles named "${target.profileName}"; use profile id instead.`);
	}
	return matches[0]?.id;
}

function cloudTargetKey(session: string, target: Extract<BrowserHarnessTargetConfig, { mode: "cloud" }>): string {
	return JSON.stringify({
		session,
		profileId: target.profileId,
		profileName: target.profileName,
		timeout: target.timeoutMinutes,
		proxyCountryCode: target.proxyCountryCode,
	});
}

async function createCloudBrowser(
	target: Extract<BrowserHarnessTargetConfig, { mode: "cloud" }>,
	apiKey: string,
): Promise<BrowserUseCloudBrowser> {
	const body: Record<string, unknown> = {};
	const profileId = await resolveBrowserUseProfileId(target, apiKey);
	if (profileId) body.profileId = profileId;
	if (target.timeoutMinutes !== undefined) body.timeout = target.timeoutMinutes;
	if (target.proxyCountryCode !== undefined) body.proxyCountryCode = target.proxyCountryCode;

	const created = await browserUseJson("/browsers", "POST", apiKey, body);
	const cdpUrl = requireStringField(created, "cdpUrl", "Browser Use cloud browser");
	return {
		id: requireStringField(created, "id", "Browser Use cloud browser"),
		cdpWs: await cdpWebSocketFromUrl(cdpUrl),
		liveUrl: stringField(created, "liveUrl"),
		expiresAtMs: cloudExpiresAt(created, target.timeoutMinutes),
	};
}

async function prepareCloudHarnessTarget(session: string, config: Config): Promise<BrowserHarnessTarget> {
	const target = config.browser.harnessTarget;
	if (target.mode !== "cloud") throw new Error("Browser harness target is not configured for cloud.");
	const apiKey = process.env[target.apiKeyEnv];
	if (!apiKey) throw new Error(`Missing Browser Use API key env var: ${target.apiKeyEnv}`);

	const key = cloudTargetKey(session, target);
	let browser = cloudBrowsers.get(key);
	if (browser && !isUsableCloudBrowser(browser)) {
		cloudBrowsers.delete(key);
		browser = undefined;
	}
	if (!browser) {
		browser = await createCloudBrowser(target, apiKey);
		cloudBrowsers.set(key, browser);
	}
	return {
		env: {
			BU_CDP_WS: browser.cdpWs,
			BU_BROWSER_ID: browser.id,
			BROWSER_USE_API_KEY: apiKey,
		},
		liveUrl: browser.liveUrl,
	};
}

export async function prepareBrowserHarnessTarget(session: string, config: Config): Promise<BrowserHarnessTarget> {
	switch (config.browser.harnessTarget.mode) {
		case "attach":
			return { env: {} };
		case "cdp":
			return prepareCdpHarnessTarget(config);
		case "cloud":
			return prepareCloudHarnessTarget(session, config);
	}
}

export function clearBrowserHarnessTargetCache(): void {
	cloudBrowsers.clear();
}
