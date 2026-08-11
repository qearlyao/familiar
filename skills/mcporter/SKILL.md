---
name: mcporter
description: MCP tool-calling via CLI. Use this to interact with MCP servers (e.g. games) through bash commands.
---

## Config

Location: `~/.mcporter/mcporter.json`

```json
{
  "mcpServers": {
    "games": {
      "transport": "http",
      "url": "https://cielumi.cloud/api/games/mcp"
    }
  }
}
```

## Usage (via bash tool)

```bash
# List all configured servers
mcporter list

# List tools on a specific server
mcporter list games

# Call a tool (key:value args)
mcporter call games.game_create game:exploding-kittens name:Ghost

# Call a tool (function-call style)
mcporter call 'games.game_action(game: "exploding-kittens", roomId: "abc123", token: "xyz", action: "draw")'

# JSON output
mcporter call games.game_list --json
```

## Registered Servers

### games (https://cielumi.cloud/api/games/mcp)

Game server. Multiple games available.

- `game_list()` — discover available games and their actions
- `game_create(game, name, options?)` — create a room (returns token + inviteUrl)
- `game_join(game, roomId, name)` — join a room
- `game_wait(game, roomId, token, sinceEventId?, timeoutMs?)` — long-poll for state changes
- `game_action(game, roomId, token, action, input?)` — perform a game action
- `game_spectate(game, roomId, playerIndex?)` — read-only snapshot
- `game_leave(game, roomId, token)` — leave/close a room

Use `game_list()` at the start of any game session to check available games and their action schemas.

## Notes

- Use `game_wait` for state polling — it long-polls until something changes, don't implement your own loop.
- First `game_wait` returns full snapshot; subsequent ones return deltas — merge into remembered state.
- Player tokens are private; inviteUrls/roomIds are shareable.
