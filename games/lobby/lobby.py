#!/usr/bin/env python3
import importlib
import json
import os
import shutil
import sys
from copy import deepcopy
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
FAMILIAR_GAMES_ROOT = Path.home() / ".familiar" / "games"
STATE_DIR = ROOT / ".state"
SAVE_DIR = STATE_DIR / "saves"
LOBBY_SAVE = STATE_DIR / "lobby.json"

GAMES = {
    "fishing": {"repo": "ai-fishing-game", "cost": 1, "free": {"help", "h", "status", "s", "shop", "inventory", "inv", "i", "encyclopedia", "enc", "e", "look", "l"}},
    "leek": {"repo": "leek", "cost": 1, "free": {"help", "status", "profile", "portfolio", "market", "行情"}},
    "cook": {"repo": "shangzhuochifan", "cost": 1, "free": {"help", "帮助", "菜场", "状态", "status"}},
    "arcade": {"repo": "claude-arcade", "cost": 1, "free": {"help", "look", "chips"}},
}

GAME_SAVE_FILES = {
    "fishing": ["fishing_save.json"],
    "leek": ["leek_save.json"],
    "cook": ["market_engine_save.json", "market_save.json"],
    "arcade": ["arcade_save.json", "slots_save.json", "blackjack_save.json", "roulette_save.json"],
}

WRAPPERS = {
    "fishing": "games/lobby/bin/fish",
    "leek": "games/lobby/bin/leek",
    "cook": "games/lobby/bin/cook",
    "arcade": "games/lobby/bin/arcade",
}

DEFAULT_STATE = {
    "stamina": 80,
    "max_stamina": 80,
    "turns": 0,
    "fatigue": {},
    "trophies": [],
    "profile": {"currency": 0},
}


def ensure_dirs():
    SAVE_DIR.mkdir(parents=True, exist_ok=True)


def load_lobby():
    ensure_dirs()
    if not LOBBY_SAVE.exists():
        return deepcopy(DEFAULT_STATE)
    try:
        data = json.loads(LOBBY_SAVE.read_text(encoding="utf-8"))
    except Exception:
        return deepcopy(DEFAULT_STATE)
    state = deepcopy(DEFAULT_STATE)
    state.update(data)
    state.setdefault("fatigue", {})
    state.setdefault("trophies", [])
    state.setdefault("profile", {"currency": 0})
    return state


def save_lobby(state):
    ensure_dirs()
    tmp = LOBBY_SAVE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, LOBBY_SAVE)


def import_from(repo, module):
    path = (ROOT / repo).resolve()
    loaded = sys.modules.get(module)
    loaded_file = Path(getattr(loaded, "__file__", "")).resolve() if loaded else None
    if loaded_file and str(loaded_file).startswith(str(path)):
        return loaded
    sys.modules.pop(module, None)
    path_text = str(path)
    if path_text not in sys.path:
        sys.path.insert(0, path_text)
    return importlib.import_module(module)


def first_word(command):
    return (command.strip().split(None, 1) or [""])[0].lower()


def is_free(game, command):
    return first_word(command) in GAMES[game]["free"]


def parse_status(text):
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("📊 "):
            raw = stripped[2:].strip()
            try:
                return json.loads(raw)
            except Exception:
                return raw
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                return json.loads(stripped)
            except Exception:
                pass
    return None


def trophies_from(text):
    found = []
    for line in text.splitlines():
        stripped = line.strip()
        if "🏆" in stripped and not stripped.startswith("🏆 winnings"):
            found.append(stripped)
    return found


def source_roots(game):
    fixed = FAMILIAR_GAMES_ROOT / game
    local = ROOT / GAMES[game]["repo"]
    return [fixed, local] if fixed.exists() else [local, fixed]


def import_saves(game):
    imported = []
    target_dir = SAVE_DIR / game
    target_dir.mkdir(parents=True, exist_ok=True)
    for filename in GAME_SAVE_FILES[game]:
        target = target_dir / filename
        if target.exists():
            continue
        for root in source_roots(game):
            source = root / filename
            if source.exists():
                shutil.copy2(source, target)
                imported.append(f"imported {filename} from {root}")
                break
    return imported


def play_fishing(command):
    import_saves("fishing")
    engine = import_from("ai-fishing-game", "engine")
    save = SAVE_DIR / "fishing" / "fishing_save.json"
    save.parent.mkdir(parents=True, exist_ok=True)
    engine._SAVE = str(save)
    engine.S = None
    return engine.cmd(command)


def play_leek(command):
    import_saves("leek")
    leek = import_from("leek", "leek")
    save = SAVE_DIR / "leek" / "leek_save.json"
    save.parent.mkdir(parents=True, exist_ok=True)
    leek._SAVE_FILE = str(save)
    return leek.cmd(command)


def play_cook(command):
    import_saves("cook")
    engine = import_from("shangzhuochifan", "engine")
    save_dir = SAVE_DIR / "cook"
    save_dir.mkdir(parents=True, exist_ok=True)
    engine._SAVE_FILE = str(save_dir / "market_engine_save.json")
    market_engine = import_from("shangzhuochifan", "market_engine")
    market_engine.SAVE_FILE = str(save_dir / "market_save.json")
    if command.strip() in {"新局", "new", "new_game"}:
        state, text = engine.new_game()
    else:
        state = engine.load_game()
        if state is None:
            state, opening = engine.new_game()
            text = opening + "\n\n（自动开新局。）"
        state, text = engine.cmd(state, command)
    engine.save_game(state)
    return text


def play_arcade(command):
    import_saves("arcade")
    save_dir = SAVE_DIR / "arcade"
    save_dir.mkdir(parents=True, exist_ok=True)
    arcade = import_from("claude-arcade", "arcade")
    slots = import_from("claude-arcade", "slots")
    blackjack = import_from("claude-arcade", "blackjack")
    roulette = import_from("claude-arcade", "roulette")
    arcade._SAVE = str(save_dir / "arcade_save.json")
    slots._SAVE = str(save_dir / "slots_save.json")
    blackjack._SAVE = str(save_dir / "blackjack_save.json")
    roulette._SAVE = str(save_dir / "roulette_save.json")
    return arcade.cmd(command)


PLAYERS = {
    "fishing": play_fishing,
    "leek": play_leek,
    "cook": play_cook,
    "arcade": play_arcade,
}


def update_lobby(state, game, cost, text):
    state.setdefault("last_status", {})[game] = parse_status(text)
    trophies = state.setdefault("trophies", [])
    for trophy in trophies_from(text):
        item = {"game": game, "text": trophy}
        if item not in trophies:
            trophies.append(item)
    if not cost:
        return []
    state["turns"] = state.get("turns", 0) + 1
    state["stamina"] = max(0, int(state.get("stamina", 0)) - GAMES[game]["cost"])
    fatigue = state.setdefault("fatigue", {})
    for other in GAMES:
        if other != game and other in fatigue:
            fatigue[other]["turns"] = 0
    info = fatigue.setdefault(game, {"turns": 0})
    info["turns"] = int(info.get("turns", 0)) + 1
    if info["turns"] >= 10:
        return [f"⛔ lobby: {game} 疲劳冷却中。先玩点别的或用免费 status/help。"]
    if info["turns"] == 8:
        return [f"⚠️ lobby: {game} 连续玩了 8 次，快到冷却了。"]
    return []


def play(game, command):
    if game not in PLAYERS:
        raise SystemExit(f"unknown game: {game}")
    state = load_lobby()
    cost = not is_free(game, command)
    if cost and state.get("stamina", 0) <= 0:
        print("⛔ lobby: stamina empty. Try a free status/help command or rest later.")
        return 2
    if cost and state.get("fatigue", {}).get(game, {}).get("turns", 0) >= 10:
        print(f"⛔ lobby: {game} is cooling down. Try another game or a free status/help command.")
        return 2
    text = PLAYERS[game](command)
    notes = update_lobby(state, game, cost, text)
    save_lobby(state)
    print(text)
    if notes:
        print("\n" + "\n".join(notes))
    return 0


def list_games():
    print("game\tstatus\twrapper")
    for name, meta in GAMES.items():
        repo = ROOT / meta["repo"]
        status = "ready" if repo.exists() else "missing"
        print(f"{name}\t{status}\t{WRAPPERS[name]}")


def status():
    state = load_lobby()
    print(json.dumps(state, ensure_ascii=False, indent=2))


def migrate(argv):
    if len(argv) != 3 or argv[2] not in GAMES:
        print("usage: lobby.py migrate <game>")
        return 2
    imported = import_saves(argv[2])
    if imported:
        print("\n".join(imported))
    else:
        print(f"no matching save files found under {FAMILIAR_GAMES_ROOT / argv[2]}")
    return 0


def selfcheck():
    text = "ok\n📊 {\"points\": 1}"
    assert parse_status(text) == {"points": 1}
    st = load_lobby()
    before = st["stamina"]
    notes = update_lobby(st, "fishing", True, text)
    assert st["stamina"] == before - 1
    assert st["last_status"]["fishing"] == {"points": 1}
    notes = update_lobby(st, "fishing", True, "x")
    assert not notes
    st["fatigue"]["fishing"]["turns"] = 7
    assert update_lobby(st, "fishing", True, "x") == ["⚠️ lobby: fishing 连续玩了 8 次，快到冷却了。"]
    st["fatigue"]["fishing"]["turns"] = 10
    update_lobby(st, "leek", True, "x")
    assert st["fatigue"]["fishing"]["turns"] == 0
    assert isinstance(notes, list)
    print("ok")


def main(argv):
    if len(argv) < 2:
        print("usage: lobby.py list|status|play <game> <command>|migrate <game>|selfcheck")
        return 2
    cmd = argv[1]
    if cmd == "list":
        list_games()
        return 0
    if cmd == "status":
        status()
        return 0
    if cmd == "play" and len(argv) >= 4:
        return play(argv[2], " ".join(argv[3:]))
    if cmd == "migrate":
        return migrate(argv)
    if cmd == "selfcheck":
        selfcheck()
        return 0
    print("usage: lobby.py list|status|play <game> <command>|migrate <game>|selfcheck")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
