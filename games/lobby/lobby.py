#!/usr/bin/env python3
import importlib
import json
import os
import shutil
import sys
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path

sys.dont_write_bytecode = True

FAMILIAR_GAMES_ROOT = Path.home() / ".familiar" / "games"
STATE_DIR = FAMILIAR_GAMES_ROOT / ".state"
SAVE_DIR = STATE_DIR / "saves"
LOBBY_SAVE = STATE_DIR / "lobby.json"
CONFIG_SAVE = STATE_DIR / "config.json"
BATCH_LIMIT = 8

GAMES = {
    "fishing": {
        "title": "Fishing",
        "icon": "🎣",
        "desc": "Text fishing simulator.",
        "cost": 15,
        "free": {"help", "h", "status", "s", "shop", "inventory", "inv", "i", "encyclopedia", "enc", "e", "look", "l", "goto"},
        "entry": ["fishing.py"],
        "saves": ["fishing_save.json"],
        "wrapper": "games/lobby/bin/fish",
    },
    "leek": {
        "title": "Leek",
        "icon": "🥬",
        "desc": "Market and trading simulator.",
        "cost": 20,
        "free": {"help", "status", "profile", "portfolio", "market", "行情"},
        "entry": ["leek.py"],
        "saves": ["leek_save.json"],
        "wrapper": "games/lobby/bin/leek",
    },
    "cook": {
        "title": "Cook",
        "icon": "🍳",
        "desc": "Market-to-table cooking simulator.",
        "cost": 10,
        "free": {"help", "帮助", "菜场", "状态", "status"},
        "entry": ["engine.py", "market_engine.py"],
        "saves": ["market_engine_save.json", "market_save.json"],
        "wrapper": "games/lobby/bin/cook",
    },
    "arcade": {
        "title": "Arcade",
        "icon": "🎰",
        "desc": "Casino arcade mini-games.",
        "cost": 5,
        "free": {"help", "look", "chips"},
        "entry": ["arcade.py", "slots.py", "blackjack.py", "roulette.py"],
        "saves": ["arcade_save.json", "slots_save.json", "blackjack_save.json", "roulette_save.json"],
        "wrapper": "games/lobby/bin/arcade",
    },
}

DEFAULT_CONFIG = {
    "version": 1,
    "energy": {
        "max": 100,
        "regen_per_turn": 1,
        "costs": {name: meta["cost"] for name, meta in GAMES.items()},
    },
    "gold": {
        "initial": 0,
        "exchange": {
            "fishing_points_to_gold": 10,
            "leek_profit_to_gold": 1,
            "gold_to_fishing_points": 5,
            "gold_to_leek_cash": 1,
        },
    },
    "session": {
        "enabled": False,
        "daily_max_turns": 300,
        "reset_at_hour": 4,
        "overlimit_message": "🌙 今天玩得够多了（{turns}/{max} 回合）。休息一下，明天再战。",
    },
    "fatigue": {
        "warning_at": 8,
        "max_consecutive_turns": 10,
        "warning_text": "⚠️ lobby: {game} 连续玩了 {turns} 次，快到冷却了。",
        "blocked_text": "⛔ lobby: {game} 疲劳冷却中。先玩点别的或用免费 status/help。",
    },
    "trophies": [
        {"id": "triple_crown", "name": "三修大师", "icon": "👑", "desc": "在三个游戏中各获得至少一个奖杯"},
        {"id": "gold_hoarder", "name": "金币囤积者", "icon": "💰", "desc": "累计获得 1000 金币"},
        {"id": "marathon", "name": "肝帝", "icon": "🏃", "desc": "总回合数超过 5000"},
        {"id": "old_man", "name": "中年老登", "icon": "🧓", "desc": "至少玩过三个游戏"},
    ],
}


def ensure_dirs():
    SAVE_DIR.mkdir(parents=True, exist_ok=True)


def deep_merge(base, override):
    result = deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return deepcopy(default)


def write_json(path, data):
    ensure_dirs()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_config():
    ensure_dirs()
    return deep_merge(DEFAULT_CONFIG, read_json(CONFIG_SAVE, {}))


def save_config(config):
    write_json(CONFIG_SAVE, config)


def reset_day(config):
    hour = int(config.get("session", {}).get("reset_at_hour", 4))
    return (datetime.now() - timedelta(hours=hour)).date().isoformat()


def default_state(config):
    energy_max = int(config.get("energy", {}).get("max", 100))
    return {
        "version": 2,
        "gold": int(config.get("gold", {}).get("initial", 0)),
        "energy": energy_max,
        "max_energy": energy_max,
        "active_game": None,
        "total_turns": 0,
        "daily_turns": 0,
        "daily_reset_day": reset_day(config),
        "game_sessions": {},
        "trophies": [],
        "last_status": {},
        "resource_baselines": {},
        "profile": {"currency": 0},
    }


def load_lobby():
    config = load_config()
    state = default_state(config)
    raw = read_json(LOBBY_SAVE, {})
    for key in state:
        if key in raw:
            state[key] = raw[key]
    if "energy" not in raw and "stamina" in raw:
        state["energy"] = raw["stamina"]
    if "total_turns" not in raw and "turns" in raw:
        state["total_turns"] = raw["turns"]
    if "game_sessions" not in raw and isinstance(raw.get("fatigue"), dict):
        state["game_sessions"] = {
            game: {"total_turns": 0, "consecutive_turns": int(info.get("turns", 0))}
            for game, info in raw["fatigue"].items()
            if isinstance(info, dict)
        }
    if "gold" not in raw:
        state["gold"] = int(raw.get("profile", {}).get("currency", state["gold"]))
    state["max_energy"] = int(config.get("energy", {}).get("max", 100))
    try:
        state["energy"] = min(float(state.get("energy", state["max_energy"])), state["max_energy"])
    except Exception:
        state["energy"] = state["max_energy"]
    state.setdefault("profile", {})["currency"] = int(state.get("gold", 0))
    if state.get("daily_reset_day") != reset_day(config):
        state["daily_reset_day"] = reset_day(config)
        state["daily_turns"] = 0
    return state


def save_lobby(state):
    state.setdefault("profile", {})["currency"] = int(state.get("gold", 0))
    write_json(LOBBY_SAVE, state)


def game_dir(game):
    return FAMILIAR_GAMES_ROOT / game


def manifest_games():
    found = {}
    if not FAMILIAR_GAMES_ROOT.exists():
        return found
    for folder in FAMILIAR_GAMES_ROOT.iterdir():
        manifest = folder / "manifest.json"
        if not folder.is_dir() or folder.name.startswith(".") or folder.name in GAMES or not manifest.exists():
            continue
        data = read_json(manifest, {})
        module = data.get("module", "engine")
        shared = data.get("shared", {})
        if not (folder / f"{module}.py").exists():
            continue
        found[folder.name] = {
            "title": data.get("title", folder.name),
            "icon": data.get("icon", "🎲"),
            "desc": data.get("desc", ""),
            "cost": int(shared.get("energy_cost", 10)),
            "free": set(shared.get("free_commands", ["help", "status"])),
            "entry": [f"{module}.py"],
            "saves": shared.get("save_files", []),
            "wrapper": "",
            "module": module,
            "manifest": data,
        }
    return found


def installed_games():
    games = deepcopy(GAMES)
    games.update(manifest_games())
    return games


def game_meta(game):
    return installed_games().get(game)


def import_game_module(game, module):
    path = game_dir(game).resolve()
    if not path.exists():
        raise SystemExit(f"missing game folder: {path}")
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
    meta = game_meta(game) or {}
    return first_word(command) in set(meta.get("free", set()))


def parse_status(text):
    for line in reversed(str(text).splitlines()):
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


def split_batch(text):
    parts = [part.strip() for part in text.replace("\n", ";").split(";") if part.strip()]
    return parts[:BATCH_LIMIT], len(parts) > BATCH_LIMIT


def coerce_result(result):
    if isinstance(result, tuple) and len(result) == 2:
        text, meta = result
        return str(text), meta if isinstance(meta, dict) else {}
    text = str(result)
    status = parse_status(text)
    return text, status if isinstance(status, dict) else {}


def trophies_from(text):
    found = []
    for line in str(text).splitlines():
        stripped = line.strip()
        if "🏆" in stripped and not stripped.startswith("🏆 【") and not stripped.startswith("🏆 winnings"):
            found.append(stripped)
    return found


def import_saves(game):
    imported = []
    meta = game_meta(game) or {}
    target_dir = SAVE_DIR / game
    target_dir.mkdir(parents=True, exist_ok=True)
    for filename in meta.get("saves", []):
        target = target_dir / filename
        if target.exists():
            continue
        source = game_dir(game) / filename
        if source.exists():
            shutil.copy2(source, target)
            imported.append(f"imported {filename} from {game_dir(game)}")
    return imported


def play_fishing(command):
    import_saves("fishing")
    engine = import_game_module("fishing", "fishing")
    save = SAVE_DIR / "fishing" / "fishing_save.json"
    save.parent.mkdir(parents=True, exist_ok=True)
    engine._SAVE = str(save)
    engine.S = None
    return engine.cmd(command)


def play_leek(command):
    import_saves("leek")
    leek = import_game_module("leek", "leek")
    save = SAVE_DIR / "leek" / "leek_save.json"
    save.parent.mkdir(parents=True, exist_ok=True)
    leek._SAVE_FILE = str(save)
    return leek.cmd(command)


def play_cook(command):
    import_saves("cook")
    engine = import_game_module("cook", "engine")
    save_dir = SAVE_DIR / "cook"
    save_dir.mkdir(parents=True, exist_ok=True)
    engine._SAVE_FILE = str(save_dir / "market_engine_save.json")
    market_engine = import_game_module("cook", "market_engine")
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
    arcade = import_game_module("arcade", "arcade")
    slots = import_game_module("arcade", "slots")
    blackjack = import_game_module("arcade", "blackjack")
    roulette = import_game_module("arcade", "roulette")
    arcade._SAVE = str(save_dir / "arcade_save.json")
    slots._SAVE = str(save_dir / "slots_save.json")
    blackjack._SAVE = str(save_dir / "blackjack_save.json")
    roulette._SAVE = str(save_dir / "roulette_save.json")
    return arcade.cmd(command)


def play_generic(game, command):
    meta = game_meta(game)
    engine = import_game_module(game, meta.get("module", "engine"))
    return engine.cmd(command)


PLAYERS = {
    "fishing": play_fishing,
    "leek": play_leek,
    "cook": play_cook,
    "arcade": play_arcade,
}


def game_ready(game, meta):
    root = game_dir(game)
    return all((root / entry).exists() for entry in meta.get("entry", []))


def format_num(value):
    try:
        value = float(value)
        return str(int(value)) if value.is_integer() else f"{value:.1f}".rstrip("0").rstrip(".")
    except Exception:
        return str(value)


def energy_cost(game, config):
    costs = config.get("energy", {}).get("costs", {})
    meta = game_meta(game) or {}
    return float(costs.get(game, meta.get("cost", 10)))


def restore_energy(state, config):
    regen = float(config.get("energy", {}).get("regen_per_turn", 1))
    state["energy"] = min(float(state.get("energy", 0)) + regen, float(state.get("max_energy", 100)))


def consume_energy(state, amount):
    if float(state.get("energy", 0)) < amount:
        return False
    state["energy"] = max(0, float(state.get("energy", 0)) - amount)
    return True


def switch_game(state, game):
    old = state.get("active_game")
    if old and old != game:
        state.setdefault("game_sessions", {}).setdefault(old, {"total_turns": 0, "consecutive_turns": 0})["consecutive_turns"] = 0
    state["active_game"] = game
    state.setdefault("game_sessions", {}).setdefault(game, {"total_turns": 0, "consecutive_turns": 0})


def daily_over_limit(state, config):
    session = config.get("session", {})
    if not session.get("enabled", False):
        return None
    limit = int(session.get("daily_max_turns", 300))
    turns = int(state.get("daily_turns", 0))
    if turns < limit:
        return None
    return session.get("overlimit_message", "🌙 今天玩够了。").format(turns=turns, max=limit)


def update_gold_from_status(state, game, status, config):
    if not isinstance(status, dict):
        return []
    exchange = config.get("gold", {}).get("exchange", {})
    baselines = state.setdefault("resource_baselines", {})
    notes = []

    def add_from_delta(key, current, divisor):
        if current is None:
            return
        if key not in baselines:
            baselines[key] = current
            return
        delta = current - float(baselines.get(key, current))
        baselines[key] = current
        gained = int(max(0, delta) // max(1, float(divisor)))
        if gained:
            state["gold"] = int(state.get("gold", 0)) + gained
            notes.append(f"💰 lobby: +{gained} gold")

    def number(value):
        try:
            return float(str(value).replace("+", "").replace(",", ""))
        except Exception:
            return None

    if game == "fishing" and "pts" in status:
        add_from_delta("fishing_pts", number(status["pts"]), exchange.get("fishing_points_to_gold", 10))
    elif game == "leek" and "pnl" in status:
        add_from_delta("leek_pnl", number(status["pnl"]), exchange.get("leek_profit_to_gold", 1))
    elif "gold" in status:
        add_from_delta(f"{game}_gold", number(status["gold"]), 1)
    return notes


def trophy_ids(state):
    ids = set()
    for item in state.get("trophies", []):
        if isinstance(item, dict) and item.get("id"):
            ids.add(item["id"])
    return ids


def game_trophy_games(state):
    return {
        item.get("game")
        for item in state.get("trophies", [])
        if isinstance(item, dict) and item.get("game") not in {None, "lobby"} and item.get("text")
    }


def trophy_unlocked(trophy, state):
    tid = trophy.get("id")
    if tid == "triple_crown":
        return len(game_trophy_games(state)) >= 3
    if tid == "gold_hoarder":
        return int(state.get("gold", 0)) >= 1000
    if tid == "marathon":
        return int(state.get("total_turns", 0)) >= 5000
    if tid == "old_man":
        return sum(1 for sess in state.get("game_sessions", {}).values() if sess.get("total_turns", 0) > 0) >= 3
    return False


def check_cross_trophies(state, config):
    notes = []
    earned = trophy_ids(state)
    for trophy in config.get("trophies", []):
        tid = trophy.get("id")
        if tid and tid not in earned and trophy_unlocked(trophy, state):
            text = f"🏆 解锁奖杯：{trophy.get('icon', '')}{trophy.get('name', tid)} — {trophy.get('desc', '')}"
            state.setdefault("trophies", []).append({"game": "lobby", "id": tid, "text": text})
            earned.add(tid)
            notes.append(text)
    return notes


def update_lobby(state, game, paid, text, metadata, config):
    status = metadata if metadata else parse_status(text)
    state.setdefault("last_status", {})[game] = status
    notes = update_gold_from_status(state, game, status, config)
    for trophy in trophies_from(text):
        item = {"game": game, "text": trophy}
        if item not in state.setdefault("trophies", []):
            state["trophies"].append(item)
    if paid:
        state["total_turns"] = int(state.get("total_turns", 0)) + 1
        state["daily_turns"] = int(state.get("daily_turns", 0)) + 1
        sessions = state.setdefault("game_sessions", {})
        for other, info in sessions.items():
            if other != game:
                info["consecutive_turns"] = 0
        info = sessions.setdefault(game, {"total_turns": 0, "consecutive_turns": 0})
        info["total_turns"] = int(info.get("total_turns", 0)) + 1
        info["consecutive_turns"] = int(info.get("consecutive_turns", 0)) + 1
        fatigue = config.get("fatigue", {})
        warn_at = int(fatigue.get("warning_at", 8))
        if info["consecutive_turns"] == warn_at:
            notes.append(fatigue.get("warning_text", "").format(game=game, turns=warn_at))
    notes.extend(check_cross_trophies(state, config))
    return [note for note in notes if note]


def execute_game(game, command):
    if game in PLAYERS:
        return coerce_result(PLAYERS[game](command))
    return coerce_result(play_generic(game, command))


def run_game_command(state, game, command, config):
    if game not in installed_games():
        return f"unknown game: {game}", []
    if not game_ready(game, game_meta(game)):
        return f"missing game files for {game}: {game_dir(game)}", []
    switch_game(state, game)
    paid = not is_free(game, command)
    if paid:
        over = daily_over_limit(state, config)
        if over:
            return over, []
        fatigue = config.get("fatigue", {})
        info = state.setdefault("game_sessions", {}).setdefault(game, {"total_turns": 0, "consecutive_turns": 0})
        if int(info.get("consecutive_turns", 0)) >= int(fatigue.get("max_consecutive_turns", 10)):
            return fatigue.get("blocked_text", "").format(game=game, turns=info.get("consecutive_turns", 0)), []
    restore_energy(state, config)
    if paid and not consume_energy(state, energy_cost(game, config)):
        return f"⛔ lobby: energy empty ({format_num(state.get('energy', 0))}/{format_num(state.get('max_energy', 100))}). Try a free status/help command or rest later.", []
    text, metadata = execute_game(game, command)
    return text, update_lobby(state, game, paid, text, metadata, config)


def cmd_help():
    return "\n".join([
        "🎮 games lobby",
        "  help / status / games / play <game> / trophies / config / new_game",
        "  play <game> switches active game; after that, plain commands route there.",
        "  batch commands with ';' (max 8).",
        "  wrappers: games/lobby/bin/fish, leek, cook, arcade",
    ])


def cmd_status(state):
    active = state.get("active_game") or "-"
    lines = [
        "🎮 【大厅】",
        f"金币：{int(state.get('gold', 0))} 💰",
        f"精力：{format_num(state.get('energy', 0))}/{format_num(state.get('max_energy', 100))} ⚡",
        f"活跃：{active}",
        f"回合：{state.get('total_turns', 0)} ｜ 今日：{state.get('daily_turns', 0)} ｜ 奖杯：{len(state.get('trophies', []))}",
    ]
    for game, info in sorted(state.get("game_sessions", {}).items()):
        lines.append(f"  {game}: {info.get('total_turns', 0)} turns, streak {info.get('consecutive_turns', 0)}")
    return "\n".join(lines)


def cmd_games(state):
    lines = ["game\tstatus\tcost\twrapper"]
    config = load_config()
    for name, meta in installed_games().items():
        status = "ready" if game_ready(name, meta) else "missing"
        active = "*" if name == state.get("active_game") else ""
        wrapper = meta.get("wrapper", "")
        lines.append(f"{active}{name}\t{status}\t{format_num(energy_cost(name, config))}\t{wrapper}")
    return "\n".join(lines)


def cmd_trophies(state, config):
    earned = trophy_ids(state)
    lines = [f"🏆 【奖杯】{len(earned)}/{len(config.get('trophies', []))} cross-game"]
    for trophy in config.get("trophies", []):
        mark = "✅" if trophy.get("id") in earned else "🔒"
        lines.append(f"  {mark} {trophy.get('icon', '')}{trophy.get('name', trophy.get('id'))} — {trophy.get('desc', '')}")
    game_lines = [item["text"] for item in state.get("trophies", []) if isinstance(item, dict) and item.get("game") != "lobby" and item.get("text")]
    if game_lines:
        lines.append("")
        lines.extend(f"  {line}" for line in game_lines)
    return "\n".join(lines)


def parse_value(value):
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    try:
        return json.loads(value)
    except Exception:
        return value


def set_config_path(config, dotted, value):
    target = config
    keys = dotted.split(".")
    for key in keys[:-1]:
        target = target.setdefault(key, {})
    target[keys[-1]] = value


def cmd_config(args):
    config = load_config()
    if not args:
        return json.dumps(config, ensure_ascii=False, indent=2)
    if args[0] == "set" and len(args) >= 3:
        value = parse_value(" ".join(args[2:]))
        set_config_path(config, args[1], value)
        save_config(config)
        return f"⚙️ {args[1]} = {value}"
    return "usage: config or config set <key> <value>"


def cmd_new_game(state, config):
    state.clear()
    state.update(default_state(config))
    return "🔄 共享大厅状态已重置；各游戏自己的存档没有删除。"


def cmd_play(args, state):
    if not args:
        return "usage: play <game>"
    game = args[0].lower()
    if game not in installed_games():
        return f"unknown game: {game}"
    switch_game(state, game)
    meta = game_meta(game)
    return f"🎮 已切换到 {meta.get('icon', '')}{meta.get('title', game)}。{meta.get('desc', '')}"


def state_json(state):
    data = {
        "gold": int(state.get("gold", 0)),
        "energy": f"{format_num(state.get('energy', 0))}/{format_num(state.get('max_energy', 100))}",
        "active": state.get("active_game") or "-",
        "turns": state.get("total_turns", 0),
        "daily": state.get("daily_turns", 0),
        "trophies": len(state.get("trophies", [])),
    }
    return "📊 " + json.dumps(data, ensure_ascii=False)


def route(part, state, config):
    words = part.split()
    if not words:
        return None, []
    root = words[0].lower()
    args = words[1:]
    if root in {"help", "h"}:
        return cmd_help(), []
    if root in {"status", "s"}:
        return cmd_status(state), []
    if root in {"games", "g", "list"}:
        return cmd_games(state), []
    if root == "play":
        return cmd_play(args, state), []
    if root in {"trophies", "tt"}:
        return cmd_trophies(state, config), []
    if root == "config":
        return cmd_config(args), []
    if root == "new_game":
        return cmd_new_game(state, config), []
    active = state.get("active_game")
    if not active:
        return "⚠️ 没有活跃游戏。请先 play <game>，或用 wrapper/direct play。", []
    return run_game_command(state, active, part, config)


def run_text(text):
    state = load_lobby()
    config = load_config()
    outputs = []
    parts, capped = split_batch(text)
    for part in parts:
        out, notes = route(part, state, config)
        if out:
            outputs.append(out)
        outputs.extend(notes)
        save_lobby(state)
    if capped:
        outputs.append(f"⚠️ lobby: batch capped at {BATCH_LIMIT} commands.")
    outputs.append(state_json(state))
    return "\n".join(outputs)


def play_direct(game, command):
    state = load_lobby()
    config = load_config()
    outputs = []
    parts, capped = split_batch(command)
    for part in parts:
        out, notes = run_game_command(state, game, part, config)
        outputs.append(out)
        outputs.extend(notes)
        save_lobby(state)
    if capped:
        outputs.append(f"⚠️ lobby: batch capped at {BATCH_LIMIT} commands.")
    outputs.append(state_json(state))
    print("\n".join(outputs))
    return 0


def migrate(argv):
    if len(argv) != 3 or argv[2] not in installed_games():
        print("usage: lobby.py migrate <game>")
        return 2
    imported = import_saves(argv[2])
    print("\n".join(imported) if imported else f"no matching save files found under {game_dir(argv[2])}")
    return 0


def selfcheck():
    config = deepcopy(DEFAULT_CONFIG)
    state = default_state(config)
    text = "ok\n📊 {\"pts\": 110}"
    assert parse_status(text) == {"pts": 110}
    assert len(split_batch(";".join(str(i) for i in range(10)))[0]) == 8
    old_player = PLAYERS["fishing"]
    old_ready = game_ready
    PLAYERS["fishing"] = lambda command: text
    globals()["game_ready"] = lambda game, meta: True
    try:
        out, _ = run_game_command(state, "fishing", "status", config)
        assert "📊" in out
        before = state["energy"]
        _, _ = run_game_command(state, "fishing", "cast 1", config)
        assert state["energy"] < before
        state["game_sessions"]["fishing"]["consecutive_turns"] = 7
        _, notes = run_game_command(state, "fishing", "cast 1", config)
        assert any("连续玩了 8 次" in note for note in notes)
        state["game_sessions"]["fishing"]["consecutive_turns"] = 10
        out, _ = run_game_command(state, "fishing", "cast 1", config)
        assert "疲劳冷却" in out
        state["game_sessions"]["leek"] = {"total_turns": 1, "consecutive_turns": 0}
        state["game_sessions"]["cook"] = {"total_turns": 1, "consecutive_turns": 0}
        assert check_cross_trophies(state, config)
        cmd_new_game(state, config)
        assert state["total_turns"] == 0 and state["energy"] == config["energy"]["max"]
    finally:
        PLAYERS["fishing"] = old_player
        globals()["game_ready"] = old_ready
    print("ok")


def main(argv):
    if len(argv) < 2:
        print(run_text("help"))
        return 0
    if argv[1] == "selfcheck":
        selfcheck()
        return 0
    if argv[1] == "migrate":
        return migrate(argv)
    if argv[1] == "play" and len(argv) >= 4:
        return play_direct(argv[2], " ".join(argv[3:]))
    print(run_text(" ".join(argv[1:])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
