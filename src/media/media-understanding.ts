import { readFile } from "node:fs/promises";

import { createPartFromUri, createUserContent, FileState, GoogleGenAI } from "@google/genai";
import type { Config } from "../config/index.js";
import type { StoredAttachment } from "../conversation/chat-log.js";
import { parseModelRef, resolveModel } from "../models/index.js";

type DerivedText = NonNullable<StoredAttachment["derived"]>["text"];
type GeminiFile = Awaited<ReturnType<GoogleGenAI["files"]["upload"]>>;
const GEMINI_API_VERSION_PATTERN = /\/(v1(?:beta|alpha)?|v\d+beta\d*)\/?$/;
const AUDIO_UNDERSTANDING_TIMEOUT_MS = 30_000;
const VIDEO_UNDERSTANDING_TIMEOUT_MS = 5 * 60_000;
const GEMINI_FILE_POLL_INTERVAL_MS = 2_000;
const GEMINI_FILE_DELETE_TIMEOUT_MS = 5_000;

function normalizeDerivedText(text: string): string {
	return text.trim().replace(/\n{3,}/g, "\n\n");
}

function labelForAttachment(kind: StoredAttachment["kind"]): string {
	if (kind === "audio") return "transcription";
	if (kind === "video") return "summary";
	return "text";
}

function geminiHttpOptions(config: Config): { baseUrl?: string; apiVersion?: string; timeout: number } {
	const ref = parseModelRef(`google/${config.mediaUnderstanding.video.model}`);
	const model = ref ? resolveModel(ref, config) : undefined;
	const baseUrl = model?.baseUrl;
	if (!baseUrl) return { timeout: VIDEO_UNDERSTANDING_TIMEOUT_MS };
	const match = baseUrl.match(GEMINI_API_VERSION_PATTERN);
	if (!match) return { baseUrl, timeout: VIDEO_UNDERSTANDING_TIMEOUT_MS };
	return {
		baseUrl: baseUrl.slice(0, match.index),
		apiVersion: match[1],
		timeout: VIDEO_UNDERSTANDING_TIMEOUT_MS,
	};
}

function timedOut(error: unknown): boolean {
	return (
		error instanceof Error &&
		(/timed out|timeout/i.test(error.message) || error.name === "AbortError" || error.name === "TimeoutError")
	);
}

function videoTimeoutError(): Error {
	return new Error(
		`Gemini video understanding timed out after ${Math.round(VIDEO_UNDERSTANDING_TIMEOUT_MS / 60_000)} minutes.`,
	);
}

function remainingVideoUnderstandingMs(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw videoTimeoutError();
	return remaining;
}

class VideoUnderstandingDeadline {
	readonly expiresAt = Date.now() + VIDEO_UNDERSTANDING_TIMEOUT_MS;

	signal(): AbortSignal {
		return AbortSignal.timeout(remainingVideoUnderstandingMs(this.expiresAt));
	}

	async sleep(ms: number): Promise<void> {
		const delay = Math.min(ms, remainingVideoUnderstandingMs(this.expiresAt));
		await new Promise((resolve) => setTimeout(resolve, delay));
		remainingVideoUnderstandingMs(this.expiresAt);
	}
}

function fallbackDerivedText(attachment: StoredAttachment, error: unknown): DerivedText | undefined {
	if (!attachment.mimeType?.startsWith("video/")) return undefined;
	const detail = timedOut(error)
		? `Automatic video understanding timed out after ${Math.round(VIDEO_UNDERSTANDING_TIMEOUT_MS / 60_000)} minutes.`
		: "Automatic video understanding failed before a summary was produced.";
	return {
		provider: "local",
		model: "media-understanding-note",
		label: "note",
		text: detail,
	};
}

async function waitForGeminiFileActive(
	ai: GoogleGenAI,
	uploaded: GeminiFile,
	deadline: VideoUnderstandingDeadline,
): Promise<GeminiFile> {
	let file = uploaded;
	let polled = false;
	for (;;) {
		if (file.state === FileState.ACTIVE) return file;
		if (file.state === FileState.FAILED) {
			throw new Error(file.error?.message ?? "Gemini file processing failed");
		}
		if (!file.name) throw new Error("Gemini file upload did not return a file name");
		if (polled) await deadline.sleep(GEMINI_FILE_POLL_INTERVAL_MS);
		file = await ai.files.get({
			name: file.name,
			config: { abortSignal: deadline.signal() },
		});
		polled = true;
	}
}

async function deleteGeminiFile(ai: GoogleGenAI, name: string): Promise<void> {
	try {
		await ai.files.delete({ name, config: { abortSignal: AbortSignal.timeout(GEMINI_FILE_DELETE_TIMEOUT_MS) } });
	} catch (error) {
		console.warn("Gemini file cleanup failed", error);
	}
}

async function transcribeAudioAttachment(
	config: Config,
	attachment: StoredAttachment,
): Promise<DerivedText | undefined> {
	if (!attachment.localPath || !attachment.mimeType?.startsWith("audio/")) return undefined;
	const apiKey = process.env[config.mediaUnderstanding.audio.apiKeyEnv];
	if (!apiKey) {
		console.warn(`media understanding skipped: ${config.mediaUnderstanding.audio.apiKeyEnv} is not set`);
		return undefined;
	}
	const form = new FormData();
	form.set("model", config.mediaUnderstanding.audio.model);
	form.set("file", new Blob([await readFile(attachment.localPath)], { type: attachment.mimeType }), attachment.name);
	const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: form,
		signal: AbortSignal.timeout(AUDIO_UNDERSTANDING_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Groq transcription failed: HTTP ${response.status}`);
	const parsed = (await response.json()) as { text?: string };
	const text = parsed.text?.trim();
	if (!text) return undefined;
	return {
		provider: "groq",
		model: config.mediaUnderstanding.audio.model,
		text: normalizeDerivedText(text),
		label: labelForAttachment(attachment.kind),
	};
}

async function summarizeVideoAttachment(
	config: Config,
	attachment: StoredAttachment,
): Promise<DerivedText | undefined> {
	if (!attachment.localPath || !attachment.mimeType?.startsWith("video/")) return undefined;
	const apiKey = process.env[config.mediaUnderstanding.video.apiKeyEnv];
	if (!apiKey) {
		console.warn(`media understanding skipped: ${config.mediaUnderstanding.video.apiKeyEnv} is not set`);
		return undefined;
	}
	const ai = new GoogleGenAI({ apiKey, httpOptions: geminiHttpOptions(config) });
	const deadline = new VideoUnderstandingDeadline();
	let uploadedName: string | undefined;
	try {
		const uploaded = await ai.files.upload({
			file: attachment.localPath,
			config: {
				mimeType: attachment.mimeType,
				displayName: attachment.name,
				abortSignal: deadline.signal(),
			},
		});
		uploadedName = uploaded.name;
		const file = await waitForGeminiFileActive(ai, uploaded, deadline);
		const fileUri = file.uri ?? uploaded.uri;
		if (!fileUri) throw new Error("Gemini file upload did not return a file URI");
		const response = await ai.models.generateContent({
			model: config.mediaUnderstanding.video.model,
			contents: createUserContent([
				{
					text: "Provide a concise description of this video, including any spoken content if present, and summarize the key visible events.",
				},
				createPartFromUri(fileUri, file.mimeType ?? uploaded.mimeType ?? attachment.mimeType),
			]),
			config: { abortSignal: deadline.signal() },
		});
		const text = response.text?.trim();
		if (!text) return undefined;
		return {
			provider: "google",
			model: config.mediaUnderstanding.video.model,
			text: normalizeDerivedText(text),
			label: labelForAttachment(attachment.kind),
		};
	} finally {
		if (uploadedName) await deleteGeminiFile(ai, uploadedName);
	}
}

export async function deriveInboundAttachmentText(
	config: Config,
	attachments: StoredAttachment[],
): Promise<StoredAttachment[]> {
	const next: StoredAttachment[] = [];
	for (const attachment of attachments) {
		if (attachment.derived?.text || !attachment.localPath) {
			next.push(attachment);
			continue;
		}
		try {
			if (attachment.mimeType?.startsWith("audio/")) {
				const text = await transcribeAudioAttachment(config, attachment);
				if (text) {
					next.push({ ...attachment, derived: { ...(attachment.derived ?? {}), text } });
					continue;
				}
			}
			if (attachment.mimeType?.startsWith("video/")) {
				const text = await summarizeVideoAttachment(config, attachment);
				if (text) {
					next.push({ ...attachment, derived: { ...(attachment.derived ?? {}), text } });
					continue;
				}
			}
		} catch (error) {
			console.error("media understanding failed", error);
			const fallback = fallbackDerivedText(attachment, error);
			if (fallback) {
				next.push({ ...attachment, derived: { ...(attachment.derived ?? {}), text: fallback } });
				continue;
			}
		}
		next.push(attachment);
	}
	return next;
}
