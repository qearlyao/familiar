# Chat redesign: capability notes

Reviewed on 2026-09-08 against `Web UI redesign scope/Familiar Chat.dc.html` and the current Familiar routes. This is an internal discussion list, not a promise of implemented behavior. The first pass rebuilds chat using existing capabilities; new backend contracts remain deferred until discussed.

## Available with the current backend

| Design area | Existing support and limits |
| --- | --- |
| Conversation | History pagination, streaming text/thinking/tool steps, quiet replies, attachments, session switching, and starting fresh are supported. Retry, edit, and delete operate on the latest assistant reply only. |
| Quick settings | Model selection and thinking levels are channel-specific. Use the server's `supportedThinking` list rather than the design's fixed list. Adding models already has an API and can stay in full settings. |
| Media | Audio/video/image/file upload and playback URLs already exist. `derivedText` can carry transcripts or video summaries when media processing produces them; do not show invented transcripts or summaries when absent. |
| Tool work | Tool names, arguments, partial/final results, errors, and timestamps support collapsible steps and elapsed time. Plain-language labels can be derived in the client where their meaning is known; preserve inspectable raw detail. |
| Context | Sessions expose total tokens and a context limit when available. Tokens reflect the latest recorded model usage, not a continuously measured live prompt. When an LCM snapshot is available, the ring shows approximate proportions for summaries, older unsummarised messages, the fresh tail, and system/tools/injected memories, scaled to that reported total. |
| Stickers | The existing meme family catalog supports browsing and inserting available stickers. |
| Diaries | List and read endpoints provide dates, titles, excerpts, and content for a shelf. Quoting selected days into a visible composer draft is possible without a new endpoint. |
| Message formatting | Quote patches, inline links, responsive message widths, and media layout are frontend presentation changes. Actual waveforms can be computed from decodable audio in the browser. |

## Backend contracts or product decisions to discuss later

| Design feature | Gap / decision |
| --- | --- |
| `/diary`, `/draw`, `/remember` | These are not registered control commands. Decide whether they insert editable natural-language prompts or run explicit structured actions, and what each action saves. `/new` already exists and resets the selected conversation. |
| “keep in keepsakes” | Existing file endpoints edit the fixed persona files; there is no message/attachment-to-keepsake contract. Decide destination, saved content, attribution, and whether this updates memory or preserves an artifact. |
| “lately / from Fern / yours”; “keeps the ones you use twice” | The catalog has names and URLs, without ownership, usage counts, recency, or automatic collection. Define collection and retention semantics before adding persistence. |
| Playback transcript highlighting | Attachments have no word/segment timing or audio-text alignment. Voice-call normalization also drops upstream transcript timestamps. Define persisted alignment if replay should highlight the spoken passage. |
| Live transcription inside a chat voice bubble | Chat records uploaded audio after recording; the separate voice-call socket can stream text but does not persist a growing chat voice message. Decide draft behavior, send timing, and how final transcript/audio are bound. |
| Link preview cards | Message data has no structured title, description, thumbnail, or favicon metadata. Inline links and domain chips need only client work; fetched rich previews need a metadata contract and fetching policy. |
| “aloud” on an existing reply | The ElevenLabs voice-call WebSocket already accepts TTS text. Reusing it for playback is client integration when configured; persistent generated audio, provider coverage, and replay alignment need a decision. |
| Curated tool narration and provenance | Raw tool results can contain useful detail, but there is no universal schema for “12 files read · 1 kept,” album origins, or friendly step summaries. Render only facts available in that tool's actual result. |

## Frontend work, not missing backend support

Hold-to-record, release-to-send, slide-to-cancel, smooth duration-based sizing, a desktop shelf/mobile sheet, and client-generated waveforms are interaction work. The existing recorder uses click-to-start/stop and attaches a file for review; changing its gesture does not itself require a backend extension. A diary shelf can read existing entries; a persistent structured “bring these days into the talk” reference would be a separate contract from simply quoting them in the draft.

These notes inventory support, not completion of every frontend detail. Other redesign pages remain separate work after chat.

## Upstream check

Inspected the existing `/Users/qearl/pi` reference clone at fetched `upstream/main` commit `4a6ed0194` (latest release in the coding-agent changelog: v0.85.1, 2026-09-05). The current package tree contains experimental `client`, `server`, and `protocol` infrastructure, but no `packages/web-ui` package. The client is transport-neutral and leaves application contracts to its consumer. The v0.85.1 notes explicitly keep the experimental client/server surface source-only; the supported local SDK and stdio RPC remain unchanged. No reusable chat UI or Familiar-specific contract for the deferred features above was found in this check. Continue using Familiar's existing web API for this pass.

Source references: `src/web/{conversation-routes,agent-routes,payloads,types,messages,voice,memes,diary-routes,file-routes}.ts`, `src/conversation/control-commands.ts`, `web/src/lib/useVoiceRecorder.ts`; upstream `packages/client/README.md` and `packages/coding-agent/CHANGELOG.md` at the commit above.
