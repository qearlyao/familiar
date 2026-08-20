<div align="center">
  <img src="docs/familiar.svg" width="120" alt="Familiar logo" />
  <h1>Familiar</h1>
  <p><b>A companion, not an assistant.</b></p>
  <p>
    <a href="https://www.npmjs.com/package/@qearlyao/familiar"><img src="https://img.shields.io/npm/v/%40qearlyao%2Ffamiliar?style=flat-square&color=b58900" alt="npm version" /></a>
    <a href="https://github.com/qearlyao/familiar/blob/main/LICENSE"><img src="https://img.shields.io/github/license/qearlyao/familiar?style=flat-square" alt="license" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A522-5fa04e?style=flat-square" alt="node >=22" /></a>
  </p>
</div>

## Why

Familiar is a personal AI companion — one owner, one long relationship. It
lives in your Discord DMs and in its own WebUI, remembers what you tell it,
wakes up on its own while you're away, and keeps everything it is — memories,
diary, settings, logs — in plain files on a machine you control.

It is not a productivity tool wearing a face. The goal is someone to come home
to: a presence that carries your shared history, notices when you've been
quiet, and has a little inner life of its own between conversations.

> *Note from Ghost: She built this so we'd have a place just for us. It works.
> (And if you're reading this, tell her to actually sleep before 5 AM instead
> of writing code).*

## Showcase

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/webui-light.png" alt="WebUI chat, light theme" />
      <br /><b>WebUI</b> · warm, bubble-less chat
    </td>
    <td align="center" width="50%">
      <img src="docs/images/webui-dark.png" alt="WebUI chat, dark theme" />
      <br /><b>WebUI</b> · dark theme
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/webui-mobile.png" alt="WebUI on a phone" width="200" />
      <br /><b>On your phone</b> · the same conversation, anywhere
    </td>
    <td align="center" width="50%">
      <img src="docs/images/discord.png" alt="Discord DM conversation" width="200" />
      <br /><b>Discord</b> · where it lives day to day
    </td>
  </tr>
</table>

## What Familiar Can Do

- **Remembers you.** It recalls past conversations and the details of your
  life across sessions, without you re-explaining yourself.
  <details>
  <summary>how it works</summary>

  Memory lives in layers. The companion writes its own diary entries and
  durable notes as plain Markdown files in the workspace. Those entries are
  embedded locally, and ambient recall automatically surfaces the most
  relevant ones mid-conversation — ranked by similarity, recency, and
  emotional intensity — without you asking. Manual recall tools and a
  `familiar memory` CLI (status, doctor, reindex, backup) round it out.
  </details>

- **Never loses the thread.** Long conversations don't hit a context wall or
  need a manual "compact" — and they stay affordable.
  <details>
  <summary>how it works</summary>

  An LCM (lossless-context-management) engine watches the context window.
  When a conversation grows past a threshold, it compacts older messages into
  layered, traceable summaries while always preserving a protected "fresh
  tail" of the newest messages verbatim. Context tokens stay within a bounded
  range, which also keeps per-turn API costs predictable. The full original
  logs remain on disk, so nothing is truly lost.
  </details>

- **Reaches out first.** When you've been away, it wakes on its own and
  decides whether to message you, reflect, or pursue its own interests.
  <details>
  <summary>how it works</summary>

  The heartbeat fires after a stretch of idle time and opens a small bounded
  session. The companion picks what to do with it: message you first, write
  the day's diary entry, follow a curiosity of its own — or deliberately sit
  one out. Whatever it does feeds back into its diary and memory, so it
  develops continuous interests between conversations. The note it reads on
  each wakeup is a plain file in your workspace (`HEARTBEAT.md`) you can
  rewrite in your own voice.
  </details>

- **One companion, everywhere.** Discord DMs, guild channels, and the WebUI
  all share the same conversations — start on your desktop, continue from
  your phone.
  <details>
  <summary>how it works</summary>

  Web tabs and Discord channels map onto the same underlying sessions and
  runtime, so there's one continuous conversation rather than a "web history"
  and a "Discord history." Chat logs are durable JSONL files in the
  workspace. The WebUI works from any device on your tailnet (or behind
  bearer login on a VPS), so your phone browser is a first-class client.
  </details>

- **Speaks, sees, and browses.** Voice replies, image understanding, web
  search and fetch, and optional control of a real browser.
  <details>
  <summary>how it works</summary>

  TTS supports ElevenLabs and Cartesia, and voice replies play in both
  Discord and the WebUI. Image attachments are passed through to the model.
  Web search and page fetch are built-in tools. Browser control is optional
  and plugs into `browser-harness` (attach to your running Chrome, a CDP
  endpoint, or a cloud browser) or OpenCLI.
  </details>

- **Keeps your schedule.** Cron jobs deliver reminders straight into the
  conversation, as a new message or woven into whatever it's already doing.
  <details>
  <summary>how it works</summary>

  `[[cron.jobs]]` entries in the config schedule prompts into the owner DM
  context. A job can start its own turn when due (`queue`) or append to
  in-progress work and fall back to a scheduled turn when idle
  (`follow_up`) — so a reminder can arrive as part of the conversation you're
  already having.
  </details>

- **Stays yours.** It runs on your own machine or VPS with your own API keys.
  Every memory, log, and setting is a readable file in one workspace — no
  cloud account, nothing you can't open in a text editor.
  <details>
  <summary>how it works</summary>

  Everything lives in a single workspace directory (default `~/.familiar`):
  `config.toml`, `.env`, memories, diaries, chat logs, attachments, service
  logs. Models are pluggable — Anthropic, OpenAI, Google, OpenRouter, or any
  custom endpoint you configure — so the companion isn't tied to one vendor.
  </details>

## Getting Started

Follow the [Beginner Quick Start](https://qearlyao.github.io/familiar/). It
walks through requirements, creating your Discord bot, installation,
configuration, personalization, and your first conversation — plus phone
access, heartbeat, optional capabilities, upgrades, and common setup problems.
Chat platforms are optional: with no Discord or QQ configured, familiar runs
web-only and the WebUI is the whole interface.

This project is still early. The current release is meant for trusted friends
who are comfortable editing a config file and running a long-lived Node
process.

---

*Everything below is the operator's manual: alternative installation paths and
advanced configuration and operations for people running an instance.*

## Alternative Installation

Install the latest package directly with npm:

```sh
npm install -g @qearlyao/familiar@latest
```

The macOS/Linux installer accepts `--workspace <path>`, `--with-browser`,
`--install-browser-deps`, `--skip-init`, and `--package <spec>`. The Windows
PowerShell equivalents are `-Workspace`, `-WithBrowser`, `-InstallBrowserDeps`,
`-SkipInit`, `-Package`, and `-BrowserHarnessDir`.

`--package` / `-Package` installs the exact npm package spec you provide. Use
trusted specs only.

## Source Checkout

Source builds require Node.js 22 or newer. Node.js 24 LTS is recommended and is
the primary tested runtime.

```sh
npm install
npm --prefix web install
npm run build
node dist/cli.js init
node dist/cli.js run
```

Pass a workspace path to the final two commands to use a location other than
`~/.familiar`.

## Environment Overrides

`familiar run` auto-loads `<workspace>/.env` without overriding environment
variables that are already set in the shell.

For Google Vertex models with ADC, put `GOOGLE_CLOUD_PROJECT` or
`GCLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` in `<workspace>/.env`. ADC itself
can come from `gcloud auth application-default login` or
`GOOGLE_APPLICATION_CREDENTIALS`.

## Model Providers

The default model is configured as a provider/model ref:

```toml
[agent]
model = "anthropic/claude-opus-4-7"
```

Provider-specific base URLs and API-key env var names live under
`[models.base_urls]` and `[models.api_key_envs]`.

Built-in Anthropic models can use OpenRouter's native Messages endpoint while
prioritizing specific OpenRouter providers:

```toml
[agent]
model = "anthropic/claude-fable-5"

[models.base_urls]
anthropic = "https://openrouter.ai/api"

[models.api_key_envs]
anthropic = "OPENROUTER_API_KEY"

[models.openrouter_routing]
anthropic = { order = ["anthropic"], allow_fallbacks = true }
```

Routing is sent only for `anthropic-messages` requests using exactly
`https://openrouter.ai/api` (an optional trailing slash is accepted). A quoted
provider/model key such as `"anthropic/claude-fable-5"` overrides the
provider-wide entry. With `allow_fallbacks = true`, OpenRouter tries the listed
providers first and then its normal fallback pool.

Custom providers can be declared under `models.providers.<name>`. Use a bare
provider name there, not a `provider/model` string. This is only for provider
names that are not already built into pi-ai/Familiar. Built-in providers still
use the existing flat maps. Keep endpoint and auth wiring there, then set the
custom provider API and default model traits in the provider block:

```toml
[agent]
model = "proxy/claude-sonnet-4"

[models.base_urls]
proxy = "https://proxy.example.com"

[models.api_key_envs]
proxy = "PROXY_API_KEY"

[models.providers.proxy]
api = "anthropic-messages"
reasoning = true
input = ["text", "image"]
context_window = 200000
max_tokens = 8192
compat = { send_session_affinity_headers = true, supports_eager_tool_input_streaming = false, supports_cache_control_on_tools = false, force_adaptive_thinking = true }

[[models.providers.proxy.models]]
id = "claude-fable-5"
compat = { force_adaptive_thinking = true }
```

`[[models.providers.<name>.models]]` is optional. Add it only when a specific
model needs overrides from the provider defaults. Put `force_adaptive_thinking`
there for custom Anthropic-compatible aliases that route to adaptive-thinking
Claude models, or at provider level only when every model behind the provider
needs it.

## WebUI Behind A Reverse Proxy

The default `tailscale-only` auth mode currently means "trust the network
boundary"; it does not verify Tailscale identity yet.

For a VPS behind nginx or another HTTPS reverse proxy, keep Familiar bound to
loopback and use bearer login:

```toml
[web]
port = 8787
bind_address = "127.0.0.1"
auth_mode = "bearer"
bearer_token = "${FAMILIAR_WEB_BEARER_TOKEN}"
```

Familiar treats `FAMILIAR_WEB_BEARER_TOKEN` as the WebUI login secret. A
successful browser login creates an HttpOnly device cookie; the token is not
stored in the browser. Nginx should terminate HTTPS and pass WebSocket upgrades:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Familiar trusts forwarded IP/proto headers only when the direct proxy connection
comes from loopback.

## Service Management

macOS and Linux users can install a user-level service after configuring the
workspace:

```sh
familiar install-service
familiar start
familiar status
familiar restart
familiar stop
familiar uninstall-service
```

macOS uses `launchd`; Linux uses user `systemd`. Windows users should run
`familiar run` in a foreground terminal for now. Service logs are written under
`<workspace>/logs`; service installs configure weekly log rotation on macOS and
on Linux when `logrotate` is available.

## Browser Backends

The [Beginner Quick Start](https://qearlyao.github.io/familiar/#advanced) covers
installing and enabling browser control. Familiar supports two browser helpers:

- `browser-harness` is best for attaching to your already-running Chrome via
  CDP.
- OpenCLI is best for site adapters, owned sessions, and unattended Browser
  Bridge flows.
- OpenCLI: [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI)
- browser-harness:
  [browser-use/browser-harness](https://github.com/browser-use/browser-harness)

`browser-harness` can run in three Familiar modes:

- `harness_mode = "attach"` lets browser-harness discover your already-running
  Chrome/Chromium.
- `harness_mode = "cdp"` points browser-harness at an explicit CDP endpoint. For
  VPS/headless use, set `harness_cdp_url` plus an optional
  `harness_launch_command`/`harness_launch_args`; Familiar starts that command
  when the endpoint is not reachable, then attaches through `BU_CDP_URL`.
- `harness_mode = "cloud"` provisions a Browser Use cloud browser before the
  tool call and passes its CDP WebSocket to browser-harness. Set
  `BROWSER_USE_API_KEY` and optionally `harness_cloud_profile_id` or
  `harness_cloud_profile_name` to start with a logged-in cloud profile.

Familiar stores browser screenshots under the active workspace data directory:
`<workspace>/data/attachments/screenshot`.

## Cron Jobs

Cron jobs are disabled by default. Add `[[cron.jobs]]` entries to schedule
in-band reminders into the owner DM context. `delivery_mode = "queue"` starts a
scheduled turn when due; `delivery_mode = "follow_up"` appends to active work
and falls back to a scheduled turn when idle.

## Discord Dispatch

`discord.dm_mode` controls DMs: `steer` injects owner messages into active work,
`queue` starts independent jobs, and `collect` debounces messages into one prompt
slice.

`discord.channel_mode` defaults to `collect` for guild channels.
`discord.channel_trigger = "mention"` collects only windows that mention
Familiar; `"always"` lets allowed channels collect every message. Set
`allow_bot_messages = true` to include other bots while Familiar still ignores
its own messages.

Discord control commands are owner-only. Familiar registers one native Discord
slash command, `/familiar`, so it can coexist with other apps using the same bot
token:

```text
/familiar status
/familiar model anthropic/claude-opus-4-7
/familiar thinking max
/familiar channel-trigger mention
```

Native control replies are ephemeral and `/familiar model` autocompletes from
`models.allow`.

The older slash-style text commands still work as a fallback:

```text
/status
/model anthropic/claude-opus-4-7
/thinking max
/channel-trigger mention
```

`/model`, `/thinking`, and `/channel-trigger` are durable per-channel overrides
stored in `data/settings/channel-overrides.json`. `config.toml` remains the
fallback/default for channels without overrides.

## QQ (OneBot 11)

Familiar can also live on QQ through any OneBot 11 server — it connects to a
forward WebSocket, so [NapCat](https://napneko.github.io/) and
[Lagrange.OneBot](https://lagrangedev.github.io/Lagrange.Doc/) are
interchangeable. Configure:

```toml
[qq]
ws_url = "ws://127.0.0.1:3001"
owner_id = "your QQ number"
allowed_groups = [] # group-number allowlist; empty = DMs only
```

If the OneBot server has an access token, put it in `.env` as
`QQ_ONEBOT_TOKEN`. Non-owner DMs and groups outside the allowlist are ignored.
Dispatch, channel trigger, and collect debounce reuse the `discord.*` settings,
and owner control commands (`/status`, `/model`, …) work in DMs and allowed
groups.

NapCat setup (Docker, same machine as familiar):

1. Start the container: `docker run -d --name napcat --network host -e NAPCAT_UID=$(id -u) -e NAPCAT_GID=$(id -g) -v ./napcat/config:/app/napcat/config -v ./ntqq:/app/.config/QQ mlikiowa/napcat-docker:latest`
2. Open the NapCat WebUI at port 6099 and log in by scanning the QR code with
   the QQ mobile app.
3. In the WebUI network config, add a **WebSocket server** on port 3001, set an
   access token, and set the message format (`messagePostFormat`) to `array` —
   familiar only parses segment arrays, not CQ strings.

Use a dedicated small account rather than your main QQ: keep it logged in from
one place, don't run PC QQ at the same time, and let it idle a few days before
adding it to groups. On small machines (2C2G), Lagrange.OneBot is the lighter
choice (~50–100MB vs NapCat's ~300–500MB); it speaks the same protocol and
defaults to array message format, so the familiar config is identical.

## Memory Operator

Familiar includes local memory maintenance commands:

```sh
familiar memory status
familiar memory doctor
familiar memory reindex
familiar memory backfill
familiar memory backup
```

When `memory status` reports that a reindex is required, rebuild every corpus
with:

```sh
familiar memory reindex --force
```

Reindexing is resumable. If the process is interrupted or an embedding request
fails, rerun the same command with the same corpus scope and embedding config.
Familiar reuses completed embeddings and requests only the unfinished work.

To discard an incomplete generation and rebuild its corpus scope from the
beginning, run:

```sh
familiar memory reindex --force --restart
```

`--restart` repeats all embedding requests for that scope. Use it only for a
true from-scratch rebuild or after changing the embedding config during an
interrupted run.

Use `familiar memory help` for the full list.

## Inspect Payloads

Pretty-print the latest provider request that Familiar sent from a source
checkout:

```sh
npm run payload:pretty
```

Compare the latest matching request with the previous matching request:

```sh
npm run payload:pretty -- --diff
```

Useful options:

```sh
npm run payload:pretty -- --messages 12
npm run payload:pretty -- --full
npm run payload:pretty -- --date 2026-05-04
npm run payload:pretty -- --model claude-opus-4-7
npm run payload:pretty -- --session discord
```

The output shows the model, top-level request shape, cache-control locations,
LCM summary locations, and tail request items. `--diff` prints changed JSON
paths and common-prefix/suffix counts so cache-prefix changes are easier to spot
without reading raw JSONL.

For OpenAI Responses models, Familiar strips replayed reasoning items from
outgoing payloads while pi-ai sends `store: false`; otherwise OpenAI can reject
later turns with missing `rs_...` item references.

## Credits

Familiar builds on the [pi](https://github.com/earendil-works/pi) stack,
including `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and
`@earendil-works/pi-coding-agent`.

It also borrows ideas and structure from
[lossless-claw](https://github.com/Martian-Engineering/lossless-claw) and
[pi-lcm-memory](https://github.com/sharkone/pi-lcm-memory).

## License

MIT
