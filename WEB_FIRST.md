# Web-first refactor — prep

Goal: lift the must-connect-to-Discord launch requirement so the app boots and
runs on the WebUI alone, with Discord as an optional adapter. **The session model
is unchanged** — the WebUI's single default session *is* the owner's Discord DM
channel. We're not making the web independent of Discord's identity; we're making
it operate autonomously when Discord is offline, while staying seamlessly in sync
when Discord is connected.

This doc is engineering prep (coupling map + resolved model). The detailed plan
happens in plan mode when we start.

---

## Resolved model

The WebUI always operates on the **owner DM channel identity**
(`discord-dm-<dmChannelId>`). That identity, plus the bot user id, are the only
two live-Discord values baked into a runtime today:

- DM channel id — from `client.users.createDM(ownerId)`
  ([discord.ts:282](src/discord.ts#L282)); a snowflake Discord assigns, *not*
  derivable from `ownerId` offline. Stable forever.
- bot user id — `client.user.id` ([discord.ts:243](src/discord.ts#L243)). Stable
  forever.

**Persist both on the first successful Discord connect.** Then:

- **Discord connected** → behaves exactly as today; connect refreshes + persists
  the two values. `getWebSessions` lists the DM session **plus** `allowedChannels`
  group channels.
- **Discord absent / unreachable** → the runtime manager loads the *persisted* DM
  key and serves the web on the same runtime + chat log, sourcing
  `botUserId`/`ownerId` from config + persistence (no live client).
  `getWebSessions` returns just the one DM session — group channels don't appear.
- **Reconnect** → Discord resolves the same DM channel id → same
  `discord-dm-<id>` key → **same runtime and same chat log, automatically**, because
  the key is identical. Autonomous, but connectivity maintained.

### Seeding assumption (decided: option a)

The **first boot must have a working Discord token** to seed
`{ botUserId, dmChannelKey }`. A fresh install with no token and no prior connect
is explicitly **not supported** — it has no DM identity to serve. (This matches
real usage: Discord is configured and normally connected; outages are the case we
care about, not never-having-Discord.) No synthetic `web-local` fallback.

---

## The one load-bearing change: extract runtime ownership out of the Discord daemon

Today the Discord daemon **owns the runtime registry** and the web daemon borrows
from it; runtime creation also reaches for the live `client`. Coupling points
(verified):

1. **Hard launch gate** — [config.ts:253](src/config.ts#L253):
   `token: readString(process.env.DISCORD_TOKEN, "DISCORD_TOKEN")` throws if the
   token is missing, so `loadConfig` itself fails. → `token?: string`.
2. **Boot order** — [cli.ts:174-177](src/cli.ts#L174-L177): `startDiscordDaemon`
   is always awaited and connects; `startWebDaemon(config, agent, discordDaemon,
   …)` takes the discord daemon as a required argument. → start Discord only when
   a token exists; always start web on the shared manager.
3. **Web borrows runtime access from Discord** — web.ts uses
   `discordDaemon.getRuntimeForWebChannel` ([web.ts:289,298](src/web.ts#L289)),
   `.getWebSessions` ([web.ts:295,526](src/web.ts#L295)), `.runPromptForWeb`
   ([web.ts:378](src/web.ts#L378)). → these move to the manager.
4. **The sole runtime factory reaches for the live client** —
   [discord.ts:235-256](src/discord.ts#L235-L256) `getRuntimeForChannel` uses
   `client.user.id` and builds from a `DiscordChatChannel`. → manager mints from a
   channelKey + config-sourced ids, no live client required.

**The change:** pull the runtime registry into a standalone **runtime manager**
that owns the `runtimes` Map, `getRuntimeForChannel`, `getRuntimeForWebChannel`,
`getWebSessions`, and the memory subscribe/unsubscribe wiring; is created in
`cli.ts` regardless of Discord; and is passed to both `startDiscordDaemon` (token
present only) and `startWebDaemon`. Discord becomes a pure adapter that attaches
to the shared manager when present.

---

## Deferred simplify items that ride along (do them here, not before)

- **#48 — runtimes Map eviction + 2 sub-bugs.** The new manager owns lifecycle.
  Fold in: eviction MUST route through `runtime.disconnect()` (the only chat-log
  `.lock` release), and the connect-failure rollback's discarded
  memory-unsubscribe handle ([discord.ts:~245](src/discord.ts#L245)) must be
  captured + called.
- **#61 — `handleApi` 270-line switch → route table.** web.ts is reworked to drop
  the discord-daemon dependency anyway; decompose in the same pass.
- **#36c — config-registry `require*` readers → consolidate onto
  `src/config/readers.ts`.**
- **readJsonBody → 400 on malformed body** ([web/http.ts](src/web/http.ts)).
- **#8 — paginated history rebuilds the full transcript**
  ([web.ts:383-434](src/web.ts#L383-L434)).

---

## Kickoff

This is a plan-mode effort. Sequence when we start:
1. Persist `{ botUserId, dmChannelKey }` on successful connect (extend existing
   saved state).
2. `token?: string` + config gate lift.
3. Extract the runtime manager (absorbs #48).
4. Rewire cli.ts boot (Discord conditional) and web.ts (consume manager, absorbs
   #61 / readJsonBody / #8).
5. #36c on the config surface.
