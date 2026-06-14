import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { File as GeminiFile } from "@google/genai";
import type { Config } from "../config/index.js";
import { parseModelRef, resolveModel } from "../models/index.js";
import { isRecord } from "../util/guards.js";

export type GeminiHttpOptions = { baseUrl?: string; apiVersion?: string; timeout: number };
export type GeminiUploadFile = GeminiFile;
type NodeFetchStreamInit = Omit<RequestInit, "body"> & { body: NodeJS.ReadableStream; duplex: "half" };

const GEMINI_API_VERSION_PATTERN = /\/(v1(?:beta|alpha)?|v\d+beta\d*)\/?$/;
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_DEFAULT_API_VERSION = "v1beta";

export class GeminiFilesUploadUnsupportedError extends Error {
	constructor(message = "Gemini Files API upload start did not return an upload URL") {
		super(message);
		this.name = "GeminiFilesUploadUnsupportedError";
	}
}

export function geminiHttpOptions(config: Config, timeout: number): GeminiHttpOptions {
	const ref = parseModelRef(`google/${config.mediaUnderstanding.video.model}`);
	const model = ref ? resolveModel(ref, config) : undefined;
	const baseUrl = model?.baseUrl;
	if (!baseUrl) return { timeout };
	const match = baseUrl.match(GEMINI_API_VERSION_PATTERN);
	if (!match) return { baseUrl, timeout };
	return {
		baseUrl: baseUrl.slice(0, match.index),
		apiVersion: match[1],
		timeout,
	};
}

function uploadEndpoint(config: Config, timeout: number): string {
	const options = geminiHttpOptions(config, timeout);
	const baseUrl = options.baseUrl ?? GEMINI_DEFAULT_BASE_URL;
	const apiVersion = options.apiVersion ?? GEMINI_DEFAULT_API_VERSION;
	return `${baseUrl}/upload/${apiVersion}/files`;
}

function readGeminiFile(value: unknown): GeminiUploadFile {
	if (!isRecord(value)) throw new Error("Gemini Files API upload returned a non-object response");
	const file = value.file;
	if (!isRecord(file)) throw new Error("Gemini Files API upload did not return a file");
	return file as GeminiUploadFile;
}

export async function uploadGeminiFile(params: {
	config: Config;
	apiKey: string;
	localPath: string;
	mimeType: string;
	displayName: string;
	timeoutMs: number;
	signal: AbortSignal;
}): Promise<GeminiUploadFile> {
	const fileStat = await stat(params.localPath);
	const sizeBytes = String(fileStat.size);
	const startResponse = await fetch(uploadEndpoint(params.config, params.timeoutMs), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-goog-api-key": params.apiKey,
			"X-Goog-Upload-Protocol": "resumable",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": sizeBytes,
			"X-Goog-Upload-Header-Content-Type": params.mimeType,
		},
		body: JSON.stringify({ file: { display_name: params.displayName } }),
		signal: params.signal,
	});
	if (!startResponse.ok) throw new Error(`Gemini Files API upload start failed: HTTP ${startResponse.status}`);
	const uploadUrl = startResponse.headers.get("x-goog-upload-url");
	if (!uploadUrl) throw new GeminiFilesUploadUnsupportedError();
	const uploadInit: NodeFetchStreamInit = {
		method: "POST",
		headers: {
			"Content-Length": sizeBytes,
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
		},
		body: createReadStream(params.localPath),
		duplex: "half",
		signal: params.signal,
	};
	const uploadResponse = await fetch(uploadUrl, uploadInit as unknown as RequestInit);
	if (!uploadResponse.ok) throw new Error(`Gemini Files API upload failed: HTTP ${uploadResponse.status}`);
	if (uploadResponse.headers.get("x-goog-upload-status") !== "final") {
		throw new Error("Gemini Files API upload did not finalize");
	}
	return readGeminiFile(await uploadResponse.json());
}
