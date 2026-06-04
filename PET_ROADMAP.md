# Familiar Desk Pet Roadmap

Familiar's pet system should be a companion product surface, not just a
desktop status indicator. Agent activity is one input. User commands, ambient
scheduling, pet state, and a small social feed are equally first-class.

Reference clone:

- OpenPets: `/Users/qearl/openpets` at `cba81b7`

## Direction

- Language: TypeScript.
- Runtime owner: Familiar.
- First external target: OpenPets local IPC/client.
- Asset path: OpenPets-compatible pet packs generated with pet-forge-style
  SVG/APNG/spritesheet workflows.
- Clawd on Desk role: feature and state-mapping reference, not an embedded code
  base.

The core should stay renderer-agnostic. Familiar owns pet state, commands, feed
events, and agent/user semantics. OpenPets, WebUI, MCP, or a future native shell
are adapters.

OpenPets should be enough for the first visible desktop product loop if we
author the pet's animation pack deliberately. Familiar can keep semantic actions
such as feed, pat, play, and sleep while the OpenPets adapter maps them onto the
current OpenPets reaction/animation slots.

```text
user commands        agent commands        agent lifecycle        scheduler
      |                    |                      |                    |
      v                    v                      v                    v
                         pet command bus
                                |
                                v
                         pet domain engine
             - state snapshot
             - command rules
             - cooldowns
             - mood/needs
             - event feed
                                |
                                v
                         renderer adapters
             - OpenPets local IPC
             - Familiar WebUI pet panel
             - future desktop shell
             - optional Clawd-compatible bridge
```

## Product Model

The pet has a durable identity and lightweight needs. It can be acted on by the
owner, the agent, or the system.

Core actors:

- `user`: direct WebUI, Discord, or slash-command actions.
- `agent`: Familiar choosing to interact with the pet through an explicit tool
  or internal command.
- `system`: ambient timers, startup/shutdown, reminders, scheduled events.

Core commands:

- `pet.status`: inspect current mood, needs, active renderer, and recent feed.
- `pet.feed`: feed the pet with a named or default item.
- `pet.pat`: short affection interaction.
- `pet.play`: playful interaction with an optional toy/activity.
- `pet.say`: short safe speech bubble or feed post.
- `pet.react`: set a transient reaction.
- `pet.activity`: passive agent lifecycle signal such as thinking, editing,
  testing, waiting, success, or error.

Core feed items:

- actor
- command
- short display text
- optional reaction
- timestamp
- private metadata for provenance and dedupe

The feed should be append-only. The current pet state is a projection over the
feed plus bounded state fields.

## Initial State Shape

Keep v0 small and legible.

```ts
type PetActor = "user" | "agent" | "system";

type PetNeed = {
  hunger: number;
  energy: number;
  affection: number;
  play: number;
};

type PetMood = "idle" | "happy" | "curious" | "sleepy" | "focused" | "waiting" | "upset";

type PetCommand =
  | { type: "status"; actor: PetActor }
  | { type: "feed"; actor: PetActor; item?: string }
  | { type: "pat"; actor: PetActor }
  | { type: "play"; actor: PetActor; toy?: string }
  | { type: "say"; actor: PetActor; text: string }
  | { type: "react"; actor: PetActor; reaction: string }
  | { type: "activity"; actor: "system"; activity: PetActivity };

type PetActivity = "thinking" | "editing" | "running" | "testing" | "waiting" | "success" | "error";
```

Do not expose raw state mutation. Every change should flow through a command so
the feed, renderer, and persistence stay consistent.

## Renderer Contract

Familiar should define a small adapter interface and map richer pet semantics
down to each renderer's capability.

```ts
type PetRenderer = {
  status(): Promise<PetRendererStatus>;
  react(reaction: PetReaction, options?: { message?: string }): Promise<void>;
};
```

OpenPets maps cleanly to this first adapter:

- `status` -> `client.status()`
- `react` -> `client.react(...)`
- `say` -> `client.say(...)`
- selected pet window -> `acquireLease(...)` plus heartbeat/release

OpenPets reactions are narrower than Familiar's product state. Keep a local
mapping layer instead of making Familiar's state vocabulary match OpenPets
exactly.

Example mapping:

- `feed` -> a reaction slot whose authored animation is eating
- `pat` -> a reaction slot whose authored animation is happy/affectionate
- `play` -> a reaction slot whose authored animation is playing
- `sleep`/low energy -> idle or waiting slot authored as sleeping/dozing
- agent thinking -> `thinking`
- edit/write tool -> `editing`
- shell command -> `running`
- test-like shell command -> `testing`
- permission/blocked/waiting state -> `waiting`
- turn success -> `success`
- tool/session error -> `error`

## Animation Strategy

Treat OpenPets as the desktop animation host, not merely a generic status
indicator.

OpenPets' current imported pet shape is intentionally small: a local pet folder
or zip provides `pet.json` plus a `spritesheet.webp`. The desktop app then maps
its fixed reaction vocabulary onto sprite states. That is enough for v0 if we
author the sprite rows with Familiar's product actions in mind.

Required Familiar pet animations:

- idle/awake
- eating
- affectionate/patted
- playing
- thinking/focused
- working/editing
- testing/waiting
- success/celebration
- error/upset
- sleeping/dozing

Implementation rule:

- Familiar state names stay semantic: `feed`, `pat`, `play`, `sleep`,
  `thinking`, `editing`, `testing`, `success`, `error`.
- The OpenPets adapter maps those semantic states onto whichever OpenPets
  reaction slots the selected pack uses for the right visual.
- The pack manifest or Familiar config should hold that mapping. Do not bake
  renderer-specific reaction names into the pet domain model.

If OpenPets later exposes custom named reactions, the adapter can become a
direct semantic mapping. Until then, authored animation packs plus local mapping
are sufficient.

## Storage

Store pet data under the workspace, not in global app state.

Proposed files:

```text
data/pet/
  state.json
  feed.jsonl
```

Rules:

- `feed.jsonl` is append-only and records every accepted command.
- `state.json` is the compact current projection.
- A command write is not complete until both the feed append and state snapshot
  update succeed.
- If the renderer call fails, persist the command result as accepted but mark
  delivery as failed in metadata.
- Never store unsafe speech text from untrusted sources without validation.

## Agent Tool Surface

Expose one compact tool or command family, not many unrelated tools.

Model-facing shape:

- `action`: `status | feed | pat | play | say | react`
- `text`: short text for `say`, optional item/toy labels for other actions
- `reason`: optional private reason, not shown to the user

The agent should use this when interaction with the pet is part of the
conversation, not for every routine lifecycle state. Passive lifecycle signals
come from runtime events.

Safety:

- `say` must be short, single-line, and filtered for code, paths, URLs, logs,
  and secrets.
- The pet must not approve tools, bypass permissions, or alter agent execution.
- Do not let renderer availability affect agent execution.

## WebUI Surface

Start with a small pet panel, not a full game UI.

Minimum:

- Current mood/reaction.
- Need bars or compact status chips.
- Recent feed.
- Buttons for feed, pat, play.
- Optional text input for a short message.
- Renderer connection indicator.

The panel can live beside chat later, but the core should not depend on WebUI.

## Discord Surface

Discord should get slash-style commands or message commands only after the core
is stable.

Minimum command family:

- `/pet status`
- `/pet feed [item]`
- `/pet pat`
- `/pet play [toy]`

Keep final responses short and avoid dumping full feed history.

## Phases

### Phase 0: Reference And Contract

- Keep `/Users/qearl/openpets` as the local reference clone.
- Decide the Familiar-owned TypeScript command/state/feed contract.
- Add tests for command validation, state projection, and reaction mapping.

### Phase 1: Local Core

- Add `src/pet/` with command types, validators, state projection, and feed
  persistence.
- Add a no-op renderer for tests and environments without desktop support.
- Add runtime hooks that emit passive `pet.activity` events from agent lifecycle
  and tool execution.

### Phase 2: OpenPets Adapter

- Add an optional OpenPets renderer adapter using `@open-pets/client`.
- Keep short timeouts and best-effort delivery.
- Add lease support only if a selected non-default pet is configured.
- Add operator status output for renderer availability.
- Add configurable semantic-to-reaction mapping for Familiar pet packs.

### Phase 3: Familiar Pet Pack

- Build or adapt one OpenPets-compatible Familiar pet pack.
- Include authored animations for eating, playing, affection, sleep, and normal
  agent activity states.
- Verify that feed, pat, play, sleep, and agent lifecycle events are visible on
  the desktop through OpenPets without forking it.

### Phase 4: User And Agent Commands

- Add WebUI pet panel controls.
- Add one agent-facing `pet` tool or equivalent internal command.
- Add Discord commands after the WebUI flow proves the command contract.

### Phase 5: Asset And Pet-Pack Expansion

- Use pet-forge conventions to create or adapt Familiar-specific SVG/APNG pet
  assets.
- Keep assets separate from command/state logic.
- Add pet selection only after at least two usable packs exist.

### Phase 6: Deeper Companion Behavior

- Add ambient events: hunger drift, sleep/wake, affection decay, playful nudges.
- Let the agent reference recent pet feed context when relevant.
- Add memory integration only for durable pet/user preferences, not every feed
  event.

### Phase 7: Desktop Shell Decision

Revisit a native shell only after the product loop is proven.

Options:

- Continue using OpenPets as the desktop surface.
- Build a Familiar Electron shell if JavaScript desktop ownership matters most.
- Build a Tauri shell if small binaries and Rust-native desktop control become
  worth the extra toolchain cost.

## Open Questions

- Should the pet have one global state per workspace, one per channel, or one
  shared pet with per-channel feed provenance?
- Should agent-initiated pet commands require explicit user opt-in?
- Should the WebUI panel be always visible, drawer-based, or a separate tab?
- How much of the feed should be visible to the agent during normal turns?
- Should pet state decay while Familiar is stopped, or only while running?

## Non-Goals For v0

- No pet economy.
- No multi-user ownership model.
- No renderer-specific state in the core model.
- No direct dependency on Clawd internals.
- No custom desktop shell before OpenPets-compatible animation packs prove
  insufficient.
