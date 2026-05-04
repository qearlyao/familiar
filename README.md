# familiar

Minimal Stage 1 daemon for a single-owner Discord DM agent.

## Install

```sh
npm install
npm run build
```

## Initialize A Workspace

```sh
npm run build
node dist/cli.js init /path/to/workspace
```

Edit `/path/to/workspace/config.toml`, then set secrets in `/path/to/workspace/.env`.

## Workspace Env

```sh
cp .env.example ~/.familiar/.env
$EDITOR ~/.familiar/.env
node dist/cli.js run ~/.familiar
```

`familiar run` auto-loads `<workspace>/.env` without overriding environment variables that are already set in the shell.

For Google Vertex models with ADC, put `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` in
`<workspace>/.env`. ADC itself can come from `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`.

## Run

```sh
node dist/cli.js run /path/to/workspace
```

DM the bot from the configured `discord.owner_id`. Guild channels are ignored unless their channel id is listed in
`discord.allowed_channels`.

## Discord Dispatch

`discord.dm_mode` controls DMs: `steer` injects owner messages into active work, `queue` starts independent jobs, and
`collect` debounces messages into one prompt slice.

`discord.channel_mode` defaults to `collect` for guild channels. `discord.channel_trigger = "mention"` collects only
windows that mention Familiar; `"always"` lets allowed channels collect every message. Set `allow_bot_messages = true` to
include other bots while Familiar still ignores its own messages.

## Inspect Payloads

Pretty-print the latest Anthropic request that familiar sent:

```sh
npm run payload:pretty
```

Useful options:

```sh
npm run payload:pretty -- --messages 12
npm run payload:pretty -- --full
npm run payload:pretty -- --date 2026-05-04
npm run payload:pretty -- --model claude-opus-4-7
```

The output shows the model, thinking config, system sections, tools, cache-control locations, and tail messages.
