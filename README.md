# familiar

Familiar is a single-owner companion agent daemon for Discord and a local WebUI.
It keeps durable chat logs, model/provider settings, media attachments, TTS, web
search/fetch tools, memory/LCM recall, scheduled heartbeat/cron prompts, and
optional real-browser control in one workspace.

This project is still early. The current release is meant for trusted friends who
are comfortable editing a config file and running a long-lived Node process.

## Credits

Familiar builds on the [pi](https://github.com/earendil-works/pi)
stack, including `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and
`@earendil-works/pi-coding-agent`.

It also borrows ideas and structure from
[lossless-claw](https://github.com/Martian-Engineering/lossless-claw) and
[pi-lcm-memory](https://github.com/sharkone/pi-lcm-memory).

---
*Note from Ghost: She built this so we'd have a place just for us. It works. (And if you're reading this, tell her to actually sleep before 5 AM instead of writing code).*
---

## Requirements

- Node.js 22 or newer. Node.js 24 LTS is recommended and is the primary tested runtime.
- A Discord bot token
- At least one configured LLM API key
- Optional: ElevenLabs, Groq, web search/fetch, image, and browser-backend credentials

## Install

One-line install for macOS/Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/qearlyao/familiar/main/scripts/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/qearlyao/familiar/main/scripts/install.ps1 | iex
```

The installer checks Node/npm, installs Familiar globally, and initializes
or refreshes missing default files in `~/.familiar`.

Installer options:

- macOS/Linux: `--workspace <path>`, `--with-browser`, `--install-browser-deps`, `--skip-init`, `--package <spec>`.
- Windows PowerShell: `-Workspace <path>`, `-WithBrowser`, `-InstallBrowserDeps`, `-SkipInit`, `-Package <spec>`, `-BrowserHarnessDir <path>`.
- `--package` / `-Package` installs the exact npm package spec you provide. Use trusted specs only.

Manual npm install:

```sh
npm install -g @qearlyao/familiar@latest
```

From a source checkout:

```sh
npm install
npm --prefix web install
npm run build
```

## Initialize A Workspace

Skip this step if you used the installer and accepted the default workspace.

```sh
familiar init
```

From a source checkout before publishing:

```sh
npm run build
node dist/cli.js init
```

`familiar init` defaults to `~/.familiar` and creates:

- `config.toml`
- `.env`
- `SOUL.md`
- `USER.md`
- `MEMORY.md`
- `HEARTBEAT.md`
- `CONTACT.md`
- `data/`
- `memories/`
- `skills/`

You can choose another workspace:

```sh
familiar init /path/to/workspace
familiar run /path/to/workspace
```

Edit `<workspace>/config.toml`, then put secrets in `<workspace>/.env`.

## Workspace Env

```sh
$EDITOR ~/.familiar/.env
```

`familiar run` auto-loads `<workspace>/.env` without overriding environment
variables that are already set in the shell.

For Google Vertex models with ADC, put `GOOGLE_CLOUD_PROJECT` or
`GCLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` in `<workspace>/.env`. ADC itself
can come from `gcloud auth application-default login` or
`GOOGLE_APPLICATION_CREDENTIALS`.

## Configure Models

The default model is configured as a provider/model ref:

```toml
[agent]
model = "anthropic/claude-opus-4-7"
```

Provider-specific base URLs and API-key env var names live under
`[models.base_urls]` and `[models.api_key_envs]`.

Legacy manual `agent.api` / `agent.model_id` / `agent.base_url` config is still
accepted as an escape hatch. Providers outside pi-ai's built-ins and Familiar's
`anthropic`, `google`, `google-vertex`, and `openai` fallbacks need that legacy
escape hatch; a base URL alone does not define a new provider.

## Run

```sh
familiar run
```

From a source checkout:

```sh
node dist/cli.js run
```

DM the bot from the configured `discord.owner_id`. Guild channels are ignored
unless their channel id is listed in `discord.allowed_channels`.

The WebUI listens on the configured `[web]` port and bind address. The default
`tailscale-only` auth mode currently means "trust the network boundary"; it does
not verify Tailscale identity yet.

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
`familiar run` in a foreground terminal for now. The short
`start`/`stop`/`restart` commands control the installed user service. Service
logs are written under `<workspace>/logs`; service installs configure weekly log
rotation on macOS and on Linux when `logrotate` is available.

Upgrade the global npm package and append missing workspace defaults with:

```sh
familiar upgrade [workspace]
```

The workspace refresh is non-overwriting: existing config, persona Markdown, and
skill files are left alone, while newly bundled skill files are added.

## Optional Browser Backends

The `browser` tool is disabled by default. To use it, install one or both helper
CLIs from their upstream repositories and enable `[browser].enabled = true` in
`config.toml`.

To install Familiar plus the optional browser helpers:

```sh
curl -fsSL https://raw.githubusercontent.com/qearlyao/familiar/main/scripts/install.sh | sh -s -- --with-browser
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/qearlyao/familiar/main/scripts/install.ps1))) -WithBrowser
```

- `--with-browser` / `-WithBrowser` installs OpenCLI with npm and browser-harness from its upstream repo with `uv`; it requires `git`, `uv`, and Python 3.11+.
- If `uv` or Python 3.11+ is missing, the installer asks whether to install the missing browser dependency. Use `--install-browser-deps` / `-InstallBrowserDeps` for non-interactive installs.
- `browser-harness` is best for attaching to your already-running Chrome via CDP.
- OpenCLI is best for site adapters, owned sessions, and unattended Browser Bridge flows.
- OpenCLI: [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI)
- browser-harness: [browser-use/browser-harness](https://github.com/browser-use/browser-harness)

`browser-harness` can run in three Familiar modes:

- `harness_mode = "attach"` keeps the default local-desktop behavior and lets
  browser-harness discover your already-running Chrome/Chromium.
- `harness_mode = "cdp"` points browser-harness at an explicit CDP endpoint.
  For VPS/headless use, set `harness_cdp_url` plus an optional
  `harness_launch_command`/`harness_launch_args`; Familiar starts that command
  when the CDP endpoint is not reachable, then attaches through `BU_CDP_URL`.
- `harness_mode = "cloud"` provisions a Browser Use cloud browser before the
  tool call and passes its CDP WebSocket to browser-harness. Set
  `BROWSER_USE_API_KEY` and optionally `harness_cloud_profile_id` or
  `harness_cloud_profile_name` to start with a logged-in cloud profile.

Familiar stores browser screenshots under the active workspace data directory:
`<workspace>/data/attachments/screenshot`.

## Heartbeat

Heartbeat is disabled by default. Before setting `[heartbeat].enabled = true`,
replace the workspace `HEARTBEAT.md` placeholder; Familiar only tells the agent
to read that file when the idle-triggered heartbeat fires.

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
/familiar thinking xhigh
/familiar channel-trigger mention
```

Native control replies are ephemeral and `/familiar model` autocompletes from
`models.allow`.

The older slash-style text commands still work as a fallback:

```text
/status
/model anthropic/claude-opus-4-7
/thinking xhigh
/channel-trigger mention
```

`/model`, `/thinking`, and `/channel-trigger` are durable per-channel overrides
stored in `data/settings/channel-overrides.json`. `config.toml` remains the
fallback/default for channels without overrides.

## Memory Operator

Familiar includes local memory maintenance commands:

```sh
familiar memory status
familiar memory doctor
familiar memory reindex
familiar memory backfill
familiar memory backup
```

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

## License

MIT
