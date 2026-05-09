import { createHash } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import { type CachedContent, type GenerateContentParameters, GoogleGenAI, ResourceScope } from "@google/genai";

import type { CacheRetention } from "./config.js";

const API_VERSION = "v1";
const SHORT_CACHE_TTL_SECONDS = 300;
const LONG_CACHE_TTL_SECONDS = 3600;
const CACHE_EXPIRY_SKEW_MS = 15_000;

type GeneratePayload = GenerateContentParameters & {
	config?: Record<string, unknown>;
	contents?: unknown[];
};

interface CachedPrefix {
	name: string;
	model: string;
	configFingerprint: string;
	prefixFingerprint: string;
	prefixLength: number;
	expiresAt: number;
}

export interface VertexContextCacheClient {
	create(params: {
		model: string;
		config: Record<string, unknown>;
	}): Promise<Pick<CachedContent, "name" | "expireTime">>;
}

export interface VertexContextCacheOptions {
	retention: CacheRetention;
	sessionId: string;
	getApiKey: (model: Model<any>) => string | undefined;
	createClient?: (model: Model<any>, apiKey: string | undefined) => VertexContextCacheClient;
	now?: () => number;
	onError?: (error: unknown) => void;
}

export interface VertexContextCacheNormalizer {
	normalize(payload: unknown, model: Model<any>): Promise<unknown>;
}

export function createVertexContextCacheNormalizer(options: VertexContextCacheOptions): VertexContextCacheNormalizer {
	let cachedPrefix: CachedPrefix | undefined;
	let lastErrorLogAt = 0;

	const now = () => options.now?.() ?? Date.now();
	const createClient = options.createClient ?? createGoogleVertexCacheClient;

	return {
		async normalize(payload, model) {
			if (options.retention === "none" || !isGoogleVertexModel(model) || !isGeneratePayload(payload)) {
				return payload;
			}

			const modelName = typeof payload.model === "string" && payload.model ? payload.model : model.id;
			const contents = Array.isArray(payload.contents) ? payload.contents : [];
			const config = payload.config && typeof payload.config === "object" ? payload.config : {};
			const cacheConfig = extractCacheConfig(config);
			if (!cacheConfig) return payload;

			const configFingerprint = fingerprint(cacheConfig.fingerprintInput);
			const reusable = findReusablePrefix(cachedPrefix, modelName, configFingerprint, contents, now());
			if (reusable) return applyCachedPrefix(payload, reusable, contents, config);

			const prefixLength = Math.max(0, contents.length - 1);
			const prefixContents = contents.slice(0, prefixLength);
			const prefixFingerprint = fingerprint(prefixContents);
			const ttlSeconds = ttlForRetention(options.retention);

			try {
				const client = createClient(model, options.getApiKey(model));
				const created = await client.create({
					model: modelName,
					config: {
						...cacheConfig.createConfig,
						...(prefixContents.length > 0 ? { contents: prefixContents } : {}),
						displayName: `familiar-${hashText(`${options.sessionId}\0${modelName}\0${configFingerprint}\0${prefixFingerprint}`).slice(0, 24)}`,
						ttl: `${ttlSeconds}s`,
					},
				});
				if (!created.name) return payload;
				cachedPrefix = {
					name: created.name,
					model: modelName,
					configFingerprint,
					prefixFingerprint,
					prefixLength,
					expiresAt: parseExpireTime(created.expireTime) ?? now() + ttlSeconds * 1000 - CACHE_EXPIRY_SKEW_MS,
				};
				return applyCachedPrefix(payload, cachedPrefix, contents, config);
			} catch (error) {
				if (now() - lastErrorLogAt > 60_000) {
					lastErrorLogAt = now();
					options.onError?.(error);
				}
				return payload;
			}
		},
	};
}

function isGoogleVertexModel(model: Model<any>): boolean {
	return model.api === "google-vertex" || model.provider === "google-vertex";
}

function isGeneratePayload(payload: unknown): payload is GeneratePayload {
	return (
		!!payload &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		Array.isArray((payload as GeneratePayload).contents)
	);
}

function extractCacheConfig(config: Record<string, unknown>):
	| {
			createConfig: Record<string, unknown>;
			fingerprintInput: Record<string, unknown>;
	  }
	| undefined {
	const createConfig: Record<string, unknown> = {};
	const fingerprintInput: Record<string, unknown> = {};
	for (const key of ["systemInstruction", "tools", "toolConfig"] as const) {
		if (config[key] !== undefined) {
			createConfig[key] = config[key];
			fingerprintInput[key] = config[key];
		}
	}
	if (Object.keys(createConfig).length === 0) return undefined;
	if (config.abortSignal !== undefined) createConfig.abortSignal = config.abortSignal;
	return { createConfig, fingerprintInput };
}

function findReusablePrefix(
	cachedPrefix: CachedPrefix | undefined,
	model: string,
	configFingerprint: string,
	contents: unknown[],
	now: number,
): CachedPrefix | undefined {
	if (!cachedPrefix || cachedPrefix.expiresAt <= now) return undefined;
	if (cachedPrefix.model !== model || cachedPrefix.configFingerprint !== configFingerprint) return undefined;
	if (contents.length < cachedPrefix.prefixLength) return undefined;
	const prefix = contents.slice(0, cachedPrefix.prefixLength);
	if (fingerprint(prefix) !== cachedPrefix.prefixFingerprint) return undefined;
	return cachedPrefix;
}

function applyCachedPrefix(
	payload: GeneratePayload,
	cachedPrefix: CachedPrefix,
	contents: unknown[],
	config: Record<string, unknown>,
): GeneratePayload {
	return {
		...payload,
		contents: contents.slice(cachedPrefix.prefixLength),
		config: {
			...withoutCacheBackedConfig(config),
			cachedContent: cachedPrefix.name,
		},
	};
}

function withoutCacheBackedConfig(config: Record<string, unknown>): Record<string, unknown> {
	const next = { ...config };
	delete next.systemInstruction;
	delete next.tools;
	delete next.toolConfig;
	return next;
}

function ttlForRetention(retention: CacheRetention): number {
	return retention === "long" ? LONG_CACHE_TTL_SECONDS : SHORT_CACHE_TTL_SECONDS;
}

function parseExpireTime(expireTime: string | undefined): number | undefined {
	if (!expireTime) return undefined;
	const parsed = Date.parse(expireTime);
	return Number.isFinite(parsed) ? parsed - CACHE_EXPIRY_SKEW_MS : undefined;
}

function fingerprint(value: unknown): string {
	return hashText(JSON.stringify(value));
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function createGoogleVertexCacheClient(model: Model<any>, apiKey: string | undefined): VertexContextCacheClient {
	const client = apiKey
		? new GoogleGenAI({
				vertexai: true,
				apiKey,
				apiVersion: API_VERSION,
				httpOptions: buildHttpOptions(model),
			})
		: new GoogleGenAI({
				vertexai: true,
				project: resolveProject(),
				location: resolveLocation(),
				apiVersion: API_VERSION,
				httpOptions: buildHttpOptions(model),
			});
	return {
		create: (params) => client.caches.create(params as any),
	};
}

function buildHttpOptions(
	model: Model<any>,
):
	| { baseUrl?: string; baseUrlResourceScope?: ResourceScope; apiVersion?: string; headers?: Record<string, string> }
	| undefined {
	const httpOptions: {
		baseUrl?: string;
		baseUrlResourceScope?: ResourceScope;
		apiVersion?: string;
		headers?: Record<string, string>;
	} = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) httpOptions.apiVersion = "";
	}
	if (model.headers) httpOptions.headers = model.headers;
	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) return undefined;
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function resolveProject(): string {
	const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	if (!project)
		throw new Error(
			"Vertex AI context caching requires GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT when no API key is configured.",
		);
	return project;
}

function resolveLocation(): string {
	const location = process.env.GOOGLE_CLOUD_LOCATION;
	if (!location)
		throw new Error("Vertex AI context caching requires GOOGLE_CLOUD_LOCATION when no API key is configured.");
	return location;
}
