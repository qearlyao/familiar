---
name: games
description: Games Lobby for fishing, leek, cook, and arcade. Use when u wanna play games.
---

# Games Lobby

Use the wrapper commands first. They call the lobby CLI for you and keep saves routed through `games/.state/`.

Only use `python3 games/lobby/lobby.py play <game> "<command>"` when a wrapper is missing or when debugging the lobby itself. Do not call game Python modules directly.

## Commands

```sh
python3 games/lobby/lobby.py list
python3 games/lobby/lobby.py status
python3 games/lobby/lobby.py play fishing "cast 10 stop=rare"
python3 games/lobby/lobby.py play leek "market"
python3 games/lobby/lobby.py play cook "菜场"
python3 games/lobby/lobby.py play arcade "enter"
```

- `list` shows lobby game IDs, readiness, and wrapper paths.
- `status` shows shared lobby state: stamina, fatigue streaks, trophies, and latest parsed game status.
- `play <game> "<command>"` sends one raw command string to that game adapter; wrappers do the same thing with less typing.

## Wrappers

```sh
games/lobby/bin/fish cast 10 stop=rare
games/lobby/bin/leek market
games/lobby/bin/cook 菜场
games/lobby/bin/arcade enter
```

## Anti-addiction

- Paid commands cost 1 stamina. Free/status-style commands do not.
- After 8 consecutive paid turns in one game, the lobby warns.
- At 10 consecutive paid turns, that game cools down; play another game to clear the streak.

## Boundaries

- Saves are automatic after each command. Do not manually call save functions.
- Saves live under `games/.state/`; do not write saves into game repos.

## Migration

The lobby auto-imports matching save files from `~/.familiar/games/<game>` on first use when no lobby save exists.

Manual import:

```sh
python3 games/lobby/lobby.py migrate fishing
python3 games/lobby/lobby.py migrate leek
python3 games/lobby/lobby.py migrate cook
python3 games/lobby/lobby.py migrate arcade
```
