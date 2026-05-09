import { readFile } from "node:fs/promises";

import { createPartFromBase64, createUserContent, GoogleGenAI } from "@google/genai";

import type { StoredAttachment } from "./chat-log.js";
import type { Config } from "./config.js";

type DerivedText = NonNullable<StoredAttachment["derived"]>["text"];

function normalizeDerivedText(text: string): string {
	return text.trim().replace(/\n{3,}/g, "\n\n");
}

function labelForAttachment(kind: StoredAttachment["kind"]): string {
	if (kind === "audio") return "transcription";
	if (kind === "video") return "summary";
	return "text";
}

async function transcribeAudioAttachment(
	config: Config,
	attachment: StoredAttachment,
): Promise<DerivedText | undefined> {
	if (!attachment.localPath || !attachment.mimeType?.startsWith("audio/")) return undefined;
	const apiKey = process.env[config.mediaUnderstanding.audio.apiKeyEnv];
	if (!apiKey) return undefined;
	const form = new FormData();
	form.set("model", config.mediaUnderstanding.audio.model);
	form.set("file", new Blob([await readFile(attachment.localPath)]), attachment.name);
	const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: form,
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
	if (!apiKey) return undefined;
	const ai = new GoogleGenAI({ apiKey });
	const video = await readFile(attachment.localPath);
	const response = await ai.models.generateContent({
		model: config.mediaUnderstanding.video.model,
		contents: createUserContent([
			{
				text: "Provide a concise description of this video, including any spoken content if present, and summarize the key visible events.",
			},
			createPartFromBase64(video.toString("base64"), attachment.mimeType),
		]),
	});
	const text = response.text?.trim();
	if (!text) return undefined;
	return {
		provider: "google",
		model: config.mediaUnderstanding.video.model,
		text: normalizeDerivedText(text),
		label: labelForAttachment(attachment.kind),
	};
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
		}
		next.push(attachment);
	}
	return next;
}
