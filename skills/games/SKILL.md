---
name: games
description: Games Lobby for fishing, leek, cook, and arcade. Use when u wanna play games.
---

# Games Lobby

Use the lobby or wrappers. They keep game code in `~/.familiar/games/<game-id>/` and all lobby/game saves in `~/.familiar/games/.state/`.

Do not call game Python modules directly.

## Fast Path

```sh
games/lobby/bin/fish cast 10 stop=rare
games/lobby/bin/leek market
games/lobby/bin/cook 菜场
games/lobby/bin/arcade enter
```

Wrappers are thin shortcuts for:

```sh
python3 games/lobby/lobby.py play <game> "<game command>"
```

## Lobby Commands

```sh
python3 games/lobby/lobby.py help
python3 games/lobby/lobby.py games
python3 games/lobby/lobby.py status
python3 games/lobby/lobby.py trophies
python3 games/lobby/lobby.py config
python3 games/lobby/lobby.py config set energy.costs.fishing 15
python3 games/lobby/lobby.py new_game
```

- `games` lists game IDs, readiness, energy cost, and wrapper path.
- `status` shows shared gold, energy, active game, daily turns, sessions, and trophy count.
- `trophies` shows cross-game trophies plus trophies detected from game output.
- `config` prints lobby config; `config set <path> <value>` persists runtime config under `~/.familiar/games/.state/config.json`.
- `new_game` resets only shared lobby state. It does not delete native game saves.

## Active Game

Use `play <game>` to switch, then send plain game commands:

```sh
python3 games/lobby/lobby.py play leek
python3 games/lobby/lobby.py market
python3 games/lobby/lobby.py "buy nebula 1; wait 1"
```

Batch commands with `;` or newlines. The lobby runs at most 8 commands per call.

Direct play still works and is what wrappers use:

```sh
python3 games/lobby/lobby.py play fishing "cast 10 stop=rare"
python3 games/lobby/lobby.py play cook "菜场"
```

## Anti-Addiction

- Paid game commands consume shared energy.
- Free/status-style commands do not consume energy.
- Energy defaults to `100` max and regenerates by `energy.regen_per_turn` before routed game commands.
- Costs are per game in `energy.costs`.
- Consecutive paid commands warn at `fatigue.warning_at` and block at `fatigue.max_consecutive_turns`.
- Optional daily limits are controlled by `session.enabled`, `session.daily_max_turns`, and `session.reset_at_hour`.

## Shared Progress

- The lobby parses trailing `📊` JSON when games provide it.
- It tracks shared gold from safe positive deltas, currently fishing `pts`, leek `pnl`, and generic `gold`.
- It records game trophy lines and unlocks configured cross-game trophies.
