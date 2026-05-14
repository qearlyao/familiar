import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

import type { Config } from "./config.js";
import type { GeneratedMediaSink } from "./generated-media.js";
import { ensureGeneratedAttachmentsDir } from "./generated-media.js";

const ELEVENLABS_TTS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const AUDIO_EXTENSIONS = ["mp3", "opus", "pcm", "ulaw", "alaw"] as const;
const TTS_NOTICE_PREFIX = "Generated speech audio attachment:";
const ttsSchema = Type.Object(
	{
		text: Type.String({ description: "Text to synthesize as speech." }),
		voiceId: Type.Optional(
			Type.String({ description: "Optional ElevenLabs voice ID. Overrides the configured voice_id." }),
		),
	},
	{ additionalProperties: false },
);

type TtsToolInput = Static<typeof ttsSchema>;

interface TtsToolDetails {
	provider: "elevenlabs";
	voiceId: string;
	modelId: string;
	outputFormat: string;
	localPath: string;
	mimeType: string;
	size: number;
}

interface ElevenLabsVoiceSettingsPayload {
	stability: number;
	similarity_boost?: number;
	style?: number;
	speed?: number;
	use_speaker_boost?: boolean;
}

export function audioExtension(outputFormat: string): string {
	for (const extension of AUDIO_EXTENSIONS) {
		if (outputFormat.startsWith(`${extension}_`)) return extension;
	}
	return "mp3";
}

function formatTtsNotice(name: string): string {
	return `${TTS_NOTICE_PREFIX} ${name}`;
}

export function audioMimeType(outputFormat: string): string {
	if (outputFormat.startsWith("pcm_")) return "audio/L16";
	if (outputFormat.startsWith("ulaw_")) return "audio/basic";
	if (outputFormat.startsWith("alaw_")) return "audio/basic";
	if (outputFormat.startsWith("opus_")) return "audio/ogg";
	return "audio/mpeg";
}

export function isElevenLabsV3Model(modelId: string): boolean {
	return modelId === "eleven_v3" || modelId.startsWith("eleven_v3_");
}

export function buildElevenLabsVoiceSettings(config: Config): ElevenLabsVoiceSettingsPayload {
	const settings = config.tts.voiceSettings;
	if (isElevenLabsV3Model(config.tts.modelId)) {
		return {
			stability: settings.stability,
		};
	}
	return {
		stability: settings.stability,
		similarity_boost: settings.similarityBoost,
		style: settings.style,
		speed: settings.speed,
		use_speaker_boost: settings.useSpeakerBoost,
	};
}

async function readElevenLabsError(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) return `${response.status} ${response.statusText}`.trim();
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && "detail" in parsed) {
			const detail = (parsed as { detail?: unknown }).detail;
			if (typeof detail === "string") return detail;
			if (detail && typeof detail === "object" && "message" in detail) {
				const message = (detail as { message?: unknown }).message;
				if (typeof message === "string") return message;
			}
		}
	} catch {}
	return text;
}

export function createTtsTool(
	config: Config,
	mediaSink: GeneratedMediaSink,
): AgentTool<typeof ttsSchema, TtsToolDetails> {
	return {
		name: "tts",
		label: "tts",
		description:
			"synthesize text into a voice message. bracketed tags steer delivery — voice tags like [laughs] or [whispers], sound effects like [applause] or [gunshot], special tags like [sings] or [strong Manchester accent]. tags go before the text they affect; combine when useful, like [excited][laughs]. keep them short.",
		parameters: ttsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input: TtsToolInput, signal?: AbortSignal) {
			const text = input.text.trim();
			if (!text) throw new Error("tts text is required.");
			if (text.length > config.tts.maxInputChars) {
				throw new Error(`tts text is too long (${text.length}/${config.tts.maxInputChars} chars).`);
			}
			const voiceId = input.voiceId?.trim() || config.tts.voiceId.trim();
			if (!voiceId) throw new Error("tts.voice_id is not configured and no voiceId was provided.");
			const apiKey = process.env[config.tts.apiKeyEnv];
			if (!apiKey) throw new Error(`Missing ElevenLabs API key env: ${config.tts.apiKeyEnv}`);

			const outputFormat = config.tts.outputFormat;
			const url = new URL(`${ELEVENLABS_TTS_BASE_URL}/${encodeURIComponent(voiceId)}`);
			url.searchParams.set("output_format", outputFormat);
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"xi-api-key": apiKey,
				},
				body: JSON.stringify({
					text,
					model_id: config.tts.modelId,
					voice_settings: buildElevenLabsVoiceSettings(config),
				}),
				signal,
			});
			if (!response.ok) {
				throw new Error(`ElevenLabs TTS failed: ${await readElevenLabsError(response)}`);
			}

			const buffer = Buffer.from(await response.arrayBuffer());
			const attachmentDir = await ensureGeneratedAttachmentsDir(config);
			const extension = audioExtension(outputFormat);
			const id = `tts_${randomUUID()}`;
			const name = `${id}.${extension}`;
			const localPath = resolve(attachmentDir, name);
			await writeFile(localPath, buffer);
			const mimeType = audioMimeType(outputFormat);
			const attachment = {
				id,
				name,
				mimeType,
				size: buffer.length,
				localPath,
				provider: "elevenlabs",
				toolName: "tts",
			} as const;
			mediaSink.add(attachment);
			return {
				content: [{ type: "text", text: formatTtsNotice(name) }],
				details: {
					provider: "elevenlabs",
					voiceId,
					modelId: config.tts.modelId,
					outputFormat,
					localPath,
					mimeType,
					size: buffer.length,
				},
			};
		},
	};
}
