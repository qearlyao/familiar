import type { Config } from "../config/index.js";
import { isRecord } from "../util/guards.js";
import { CARTESIA_VERSION } from "./tts.js";

const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices";
const CARTESIA_VOICES_URL = "https://api.cartesia.ai/voices";
const PAGE_SIZE = 100;
// a library past a thousand voices is someone else's shelf; stop there rather than page forever
const MAX_PAGES = 10;

export interface VoiceOption {
	id: string;
	name: string;
	/** ElevenLabs: premade, cloned, generated…; Cartesia: yours or public */
	category?: string;
	/** accent, gender, age, use case: whatever the provider says about the voice */
	labels: string[];
	previewUrl?: string;
}

interface VoicePage {
	voices: VoiceOption[];
	/** where the next page starts, when there is one */
	next?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export function parseElevenLabsVoices(body: unknown): VoicePage {
	if (!isRecord(body) || !Array.isArray(body.voices)) throw new Error("elevenlabs voices: invalid response");
	const voices: VoiceOption[] = [];
	for (const voice of body.voices) {
		if (!isRecord(voice) || !text(voice.voice_id)) continue;
		const id = voice.voice_id as string;
		voices.push({
			id,
			name: text(voice.name) ?? id,
			category: text(voice.category),
			labels: isRecord(voice.labels) ? Object.values(voice.labels).flatMap((label) => text(label) ?? []) : [],
			previewUrl: text(voice.preview_url),
		});
	}
	return { voices, next: body.has_more === true ? text(body.next_page_token) : undefined };
}

export function parseCartesiaVoices(body: unknown): VoicePage {
	if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("cartesia voices: invalid response");
	const voices: VoiceOption[] = [];
	for (const voice of body.data) {
		if (!isRecord(voice) || !text(voice.id)) continue;
		const id = voice.id as string;
		const gender = text(voice.gender)?.replace(/_/g, " ");
		const accents = Array.isArray(voice.accents)
			? voice.accents.flatMap((accent) => (isRecord(accent) ? (text(accent.locale) ?? []) : []))
			: [];
		voices.push({
			id,
			name: text(voice.name) ?? id,
			category: typeof voice.is_owner === "boolean" ? (voice.is_owner ? "yours" : "public") : undefined,
			labels: [...(gender ? [gender] : []), ...accents, ...(text(voice.tagline) ? [voice.tagline as string] : [])],
			previewUrl: text(voice.preview_file_url),
		});
	}
	// Cartesia pages by cursor: the next page starts after the last voice of this one
	return { voices, next: body.has_more === true ? voices.at(-1)?.id : undefined };
}

async function fetchPage(
	url: URL,
	headers: Record<string, string>,
	provider: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`${provider} voices failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}
	return response.json();
}

/** every voice the active TTS provider's key can speak with, by name */
export async function listVoices(config: Config, signal?: AbortSignal): Promise<VoiceOption[]> {
	const provider = config.tts.provider;
	const apiKeyEnv = provider === "cartesia" ? config.tts.cartesia.apiKeyEnv : config.tts.apiKeyEnv;
	const apiKey = process.env[apiKeyEnv];
	if (!apiKey) throw new Error(`Missing ${provider} API key env: ${apiKeyEnv}`);
	const voices: VoiceOption[] = [];
	let next: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		let parsed: VoicePage;
		if (provider === "cartesia") {
			const url = new URL(CARTESIA_VOICES_URL);
			url.searchParams.set("limit", String(PAGE_SIZE));
			url.searchParams.append("expand[]", "preview_file_url");
			if (next) url.searchParams.set("starting_after", next);
			const headers = { authorization: `Bearer ${apiKey}`, "cartesia-version": CARTESIA_VERSION };
			parsed = parseCartesiaVoices(await fetchPage(url, headers, provider, signal));
		} else {
			const url = new URL(ELEVENLABS_VOICES_URL);
			url.searchParams.set("page_size", String(PAGE_SIZE));
			url.searchParams.set("sort", "name");
			url.searchParams.set("sort_direction", "asc");
			url.searchParams.set("include_total_count", "false");
			if (next) url.searchParams.set("next_page_token", next);
			parsed = parseElevenLabsVoices(await fetchPage(url, { "xi-api-key": apiKey }, provider, signal));
		}
		voices.push(...parsed.voices);
		if (!parsed.next) break;
		next = parsed.next;
	}
	return voices;
}
