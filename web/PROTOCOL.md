# Familiar Web Channel — Wire Protocol

This spec defines the contract between the Familiar frontend (`web/`) and the
backend side-door that serves it. Goal: let frontend and backend be built in
parallel against a stable shape.

**Status:** draft. Stage 3, Sprint 1. Owned by Claude (frontend) and Codex (backend).

## Transport

- **HTTP** for one-shot operations (auth handshake, history fetch, control commands).
- **WebSocket** for the live message stream (deltas, status, completion).

Frontend opens one persistent WS per session. Reconnects with last-seen event id.

Base URL is the side-door root. All paths below are relative to it.

## Auth

The side-door supports three auth modes, switchable via backend config:

| Mode             | Frontend behavior                                                  |
| ---------------- | ------------------------------------------------------------------ |
| `tailscale-only` | No auth header. Backend trusts source IP (Tailscale interface).    |
| `bearer`         | `Authorization: Bearer <token>` from local secret, persisted in `localStorage`. |
| `public-2fa`     | Bearer + TOTP exchange yields `Cookie: familiar_session=<id>` (~12h). |

The frontend reads `GET /api/web/auth/mode` on first load to learn which mode
is active and adapts its login UI. (Login UI not implemented in v0; we assume
`tailscale-only` for first integration.)

## Message Shape (canonical)

This is what the frontend expects to render and what history endpoints return.

```ts
type Role = "user" | "assistant" | "system";

interface Message {
  id: string;             // server-assigned, stable across reconnects
  role: Role;
  who: string;            // display name; "Familiar" / "you" / channel system label
  text: string;           // final visible message body
  thinking?: string;      // assistant only — raw reasoning, may be empty
  thinkingMs?: number;    // assistant only — wall-clock time spent in thinking phase
  ts: number;             // unix ms, server-assigned
}
```

Notes:
- `thinking` is opaque text; the frontend renders it as a plain paragraph in a
  collapsible block. Backend should pass it through verbatim from the provider
  (Anthropic `thinking` content blocks, OpenAI Responses `reasoning` deltas, etc.)
  with no editorial reformatting.
- `thinkingMs` is wall-clock between first thinking delta and last thinking
  delta (or first text delta, whichever comes first). The backend computes it.

## HTTP Endpoints

### `GET /api/web/auth/mode`

Returns auth mode + minimal hints needed for login UI.

```json
{ "mode": "tailscale-only" | "bearer" | "public-2fa" }
```

### `GET /api/web/history?limit=50&before=<msgId>`

Returns recent web-channel messages, newest last. Used on cold load and after
reconnect-with-gap.

```json
{ "messages": [Message, ...], "hasMore": true }
```

### `POST /api/web/send`

Submit a user message. Returns immediately with the assigned message id; the
assistant response arrives over the WebSocket.

Request:
```json
{ "text": "...", "clientId": "uuid-from-frontend" }
```

Response:
```json
{ "id": "server-id", "ts": 1730000000000 }
```

`clientId` lets the frontend reconcile its optimistic local message with the
canonical server one.

### `POST /api/web/control`

Send a control command (model, thinking, stop, new, etc.). Mirrors Discord
`/familiar` subcommands.

Request:
```json
{ "command": "model" | "thinking" | "stop" | "new" | "status", "args": { ... } }
```

Response:
```json
{ "ok": true, "message": "..." }
```

## WebSocket: `/api/web/stream`

Bidirectional. Frontend subscribes; backend pushes events.

### Connection

On open, frontend sends:
```json
{ "type": "hello", "lastEventId": "evt_..." | null }
```

Backend replays any missed events since `lastEventId`, then enters live mode.

### Events (server → client)

All events have shape:
```ts
{ type: string; eventId: string; ts: number; ... }
```

#### `message_started`

A new message is being composed. Frontend creates a placeholder.

```json
{
  "type": "message_started",
  "eventId": "evt_...",
  "ts": 1730000000000,
  "messageId": "msg_...",
  "role": "assistant" | "user",
  "who": "Familiar"
}
```

#### `delta`

Streaming content. `part` distinguishes thinking from final text. Frontend
appends to the appropriate buffer.

```json
{
  "type": "delta",
  "eventId": "evt_...",
  "ts": 1730000000000,
  "messageId": "msg_...",
  "part": "thinking" | "text",
  "content": "incremental string"
}
```

The frontend may ignore `part: "thinking"` deltas in v0 if the thinking UI
isn't ready, but the backend should always emit them. (For Stage 3 v0 the
frontend renders them — see `ThinkingBlock`.)

#### `message_completed`

Finalizes a message. Carries authoritative final values.

```json
{
  "type": "message_completed",
  "eventId": "evt_...",
  "ts": 1730000000000,
  "messageId": "msg_...",
  "thinkingMs": 12000,
  "usage": {
    "input": 1234,
    "output": 567,
    "cacheRead": 1000,
    "cacheWrite": 234,
    "cost": 0.0042
  }
}
```

`text` and `thinking` are not repeated here; the frontend reconstructs them
from accumulated deltas. The completion event is a "freeze and finalize"
signal.

#### `status`

Out-of-band status the frontend may surface (typing indicator, model switch,
queue depth, etc.). Optional in v0.

```json
{
  "type": "status",
  "eventId": "evt_...",
  "ts": 1730000000000,
  "kind": "thinking" | "tool" | "idle" | "queued",
  "detail": "..."
}
```

#### `error`

Recoverable error; not necessarily a connection break.

```json
{
  "type": "error",
  "eventId": "evt_...",
  "ts": 1730000000000,
  "code": "rate_limited" | "tool_failed" | "abort" | "unknown",
  "message": "human-readable explanation"
}
```

### Events (client → server)

In addition to `hello`:

#### `abort`

Stop the in-flight assistant turn.

```json
{ "type": "abort", "messageId": "msg_..." }
```

## Reconnect Semantics

- Frontend persists `lastEventId` per session.
- On reconnect, sends `hello` with that id; backend replays events newer than that id.
- If backend has rotated past that id (e.g. long disconnect), it sends a single
  `replay_window_lost` event; frontend then fetches `/api/web/history` and
  resumes live.

## Out of Scope for Stage 3 v0

- Multi-channel switching (frontend only knows the `web` channel).
- Image/audio attachments on either direction.
- Streaming token-level usage updates (only final usage on `message_completed`).
- Per-user auth (single owner; `public-2fa` is owner+TOTP, not multi-account).

## Frontend Conformance Notes

The frontend currently mocks send/reply locally in `Chat.tsx` via `mockReply`.
The integration point is a single `useChat()`-shaped hook that will replace the
mock state with `WebSocket` driven state. Until backend is up, the frontend
ships with mocking; flipping to live is a one-file change.
