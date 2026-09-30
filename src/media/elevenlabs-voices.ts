import type { Config } from "../config/index.js";
import { isRecord } from "../util/guards.js";

const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices";
const PAGE_SIZE = 100;
// a library past a thousand voices is someone else's shelf; stop there rather than page forever
const MAX_PAGES = 10;

export interface VoiceOption {
	id: string;
	name: string;
	/** premade, cloned, generated, professional… as ElevenLabs files it */
	category?: string;
	/** accent, gender, age, use case: whatever labels the voice carries */
	labels: string[];
	previewUrl?: string;
}

export function parseElevenLabsVoices(body: unknown): { voices: VoiceOption[]; nextPageToken?: string } {
	if (!isRecord(body) || !Array.isArray(body.voices)) throw new Error("elevenlabs voices: invalid response");
	const voices: VoiceOption[] = [];
	for (const voice of body.voices) {
		if (!isRecord(voice) || typeof voice.voice_id !== "string" || !voice.voice_id) continue;
		const labels = isRecord(voice.labels)
			? Object.values(voice.labels).filter((label): label is string => typeof label === "string" && label.length > 0)
			: [];
		voices.push({
			id: voice.voice_id,
			name: typeof voice.name === "string" && voice.name ? voice.name : voice.voice_id,
			category: typeof voice.category === "string" ? voice.category : undefined,
			labels,
			previewUrl: typeof voice.preview_url === "string" && voice.preview_url ? voice.preview_url : undefined,
		});
	}
	const nextPageToken =
		body.has_more === true && typeof body.next_page_token === "string" ? body.next_page_token : undefined;
	return { voices, nextPageToken };
}

/** every voice the configured ElevenLabs key can speak with, by name */
export async function listElevenLabsVoices(config: Config, signal?: AbortSignal): Promise<VoiceOption[]> {
	const apiKey = process.env[config.tts.apiKeyEnv];
	if (!apiKey) throw new Error(`Missing elevenlabs API key env: ${config.tts.apiKeyEnv}`);
	const voices: VoiceOption[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL(ELEVENLABS_VOICES_URL);
		url.searchParams.set("page_size", String(PAGE_SIZE));
		url.searchParams.set("sort", "name");
		url.searchParams.set("sort_direction", "asc");
		url.searchParams.set("include_total_count", "false");
		if (pageToken) url.searchParams.set("next_page_token", pageToken);
		const response = await fetch(url, { headers: { "xi-api-key": apiKey }, signal });
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			throw new Error(`elevenlabs voices failed: ${response.status}${detail ? ` ${detail}` : ""}`);
		}
		const parsed = parseElevenLabsVoices(await response.json());
		voices.push(...parsed.voices);
		if (!parsed.nextPageToken) break;
		pageToken = parsed.nextPageToken;
	}
	return voices;
}
