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

### Two distinct "no live Discord" scenarios (clarified 2026-05-31)

These are NOT the same and must be handled distinctly:

| Scenario | Frequency | Token | Behavior |
|---|---|---|---|
| Normal | common | present, connects | exactly as today |
| **Unreachable at boot** | **common** | present; identity already cached | **boot anyway**: web + heartbeat on the cached DM identity; the Discord connection is retried in the background; on connect, attach handlers + add group channels to the session list |
| No token at boot | rare | absent | run web + heartbeat on cached identity; never attempt Discord |

The common failure is **valid token but Discord/network unreachable**, not
"never had a token." Today `withReadyClient(token)` ([discord.ts:166](src/discord.ts#L166))
*blocks boot on a successful connection*, so an unreachable Discord currently
takes the whole app down (web included). The fix: the live connection becomes
**optional and non-blocking at boot**.

Both no-live-Discord scenarios converge on one runtime behavior — run on the
cached DM identity with no live client — differing only in whether a connection
is ever attempted/retried. So the design is unified: **the shared units (runtime
manager, agent-work serializer, scheduler) live in cli.ts and run regardless of
Discord; the Discord adapter attaches when/if it connects.**

### Seeding assumption (decided: option a)

The **first-ever boot must have a working Discord token that connects** to seed
`{ botUserId, dmChannelId }`. A fresh install that has never connected has no DM
identity to serve and is explicitly **not supported** — no synthetic `web-local`
fallback. After the cache exists, neither an unreachable Discord nor an
absent token blocks boot.

### Decisions (2026-05-31)

- **Agent-work serializer → shared unit (1A).** The single global queue
  (`enqueueAgentWork` + `activeAgentOwner` + the prompt wrappers) that serializes
  every agent turn across Discord/web/heartbeat/cron moves to a cli.ts-created
  unit passed to both the web daemon and the Discord adapter. Preserves global
  single-threading exactly.
- **Scheduler extracted; heartbeat survives without a live client (2B).** The
  heartbeat/cron timers move out of the Discord daemon so the agency core keeps
  firing on the cached DM identity when Discord is unreachable or untokened.

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

## Sequence

Three shared units must end up created in cli.ts and run regardless of Discord:
the **runtime manager** (done, 3a — still daemon-created), the **agent-work
serializer** (the single global queue), and the **scheduler** (heartbeat + cron).

Key seam (verified): heartbeat ([discord.ts:426](src/discord.ts#L426)) and cron
([discord.ts:536](src/discord.ts#L536)) each *deliver* to Discord
(`client.rest` + channel send — Discord-coupled) AND *record* via
`runtime.noteOutbound` (chat-log → how the WebUI sees the message —
delivery-agnostic). So Discord coupling in the scheduler is **only at delivery**.
Delivery becomes an injected sink that no-ops when there is no live client.

- ✅ **Step 1** — owner-identity cache (`6f30484`).
- ✅ **3a** — runtime registry → `runtime-manager.ts`, botUserId injected (`ddd85cb`).
- ✅ **3b-1** — agent-work serializer → `agent-work-queue.ts` (`11af2f1`).
- ✅ **3b-2** — scheduler runner + injected delivery sink → `scheduler-runner.ts` (`ab2c648`).
- ✅ **3b-3** — shared `createAgentCore()` hoisted to cli.ts; web + config-registry
  depend on `AgentCore` not `DiscordDaemon`; daemon attaches live-client glue via
  `attachDiscord()` (`7ac9067`).
- ✅ **3c** — the single behavior change: web/scheduler boot on cached identity,
  Discord is an optional background-connect adapter (`e027bd5`, see below).
- ✅ **#48 (leaks)** — runtime manager now pairs the memory-subscription release
  with `runtime.disconnect()` in one `release()`; connect rollback + disconnectAll
  no longer leak (`24624a0`). **Eviction trigger deferred** (low severity; chose
  "ship leak fixes, defer trigger" 2026-05-31) — release is centralized so adding
  it later is isolated.
- ✅ **readJsonBody** — malformed body → 400, oversized → 413 via `HttpError` the
  dispatcher honors; reader takes the structural `AsyncIterable` it consumes and is
  now unit-tested (`68dbe3b`).
- ❌ **#36c — declined (not a real consolidation).** config-registry's `require*`
  validators coerce (`Number(value)`, for string-encoded WebUI override values) and
  have no fallback; readers.ts `read*` is non-coercing + fallback-on-undefined (for
  config.toml). Different contracts — merging would change config.toml parsing or
  drop override coercion. They stay co-located with their only consumer.
- ⬜ remaining web-surface items (larger, backend — Codex candidates):
  - **#61** — `handleApi` ~270-line switch → route table.
  - **#8** — paginated history rebuilds the full transcript ([web.ts:383-434](src/web.ts#L383-L434)).

  Deferred from 3c's `/simplify` pass: extract an inner `createConnectedSession(client)`
  factory in discord.ts to retire the `requireClient()` guards smeared across the
  daemon body (needs handler-ref hoisting for `stop()`).

---

## 3c — design (resolved)

The `/simplify` altitude review on 3b-3 set the shape: the `attachDiscord()`
bundle conflates two lifetimes. 3c splits it along the real axis —
**identity/session source (always present) vs live delivery (optional)**.

### The linchpin
The owner DM `ChatChannelRef` is `{ service: "discord", scope: "dm", channelId:
dmChannelId }` (channelName/threadId are undefined for a DM). It is fully
reconstructible from the cached `owner-identity.json` (`{ botUserId, dmChannelId }`)
with NO live client. Its `chatChannelKey` is `discord-dm-<id>` — identical to the
live path — so a web-only runtime and the later reconnected Discord adapter land
on the **same runtime + same chat log**. That identity-equality IS the
continuity guarantee.

### Changes
1. **`config.discord.token` becomes optional.** [config.ts:253](src/config.ts#L253)
   `readString(...)` → an optional read (`token?: string`); the rest of
   `config.discord` stays. (Token absent ⇒ run web-only; token present but
   unreachable ⇒ see #4.)
2. **Split the core's `attachDiscord` bundle into two seams:**
   - **Session/identity source** — always set at core construction in cli.ts.
     - *No cache yet* (first-ever boot): the source is empty until Discord seeds
       it; this is the unsupported "never-connected, no token" case — fail clear.
     - *Cache present*: build the default session from `loadOwnerIdentity` →
       the DM ref above. `botUserId` comes from the cache; `getWebSessions`
       returns just the one DM session; `resolveDefaultSession` mints the DM
       runtime via the runtime manager — all client-free.
   - **Live delivery sink** — optional; only attached when a client connects.
     When absent, scheduler/web turns still run and `noteOutbound` still records
     to the chat log (the WebUI sees everything); the Discord *send* is simply
     skipped. (No-op sink returns empty messageIds.)
   When Discord connects, it *upgrades* the source (adds group channels, refreshes
   identity) and attaches the live delivery sink.
3. **`getRuntimeForWebChannel` already lives in the core** (3b-3 simplify fix) and
   needs only `getWebSessions` — so it works unchanged on the client-free source.
4. **Non-blocking background connect.** cli.ts no longer `await`s
   `withReadyClient` before starting web. When a token is present, the Discord
   connect runs in the background with retry; on success it attaches the live
   delivery sink + upgrades the session source. Boot completes (web up, scheduler
   running on cached identity) regardless of whether/when Discord connects. The
   common "valid token, Discord unreachable at boot" case now boots fine.

### Ride-along
- **#48 eviction** folds into the runtime manager here (lifecycle is now its own).
- Web-surface items (#61 route table, readJsonBody→400, #8 history) can follow
  separately — not required for 3c.
