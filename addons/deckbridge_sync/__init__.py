from __future__ import annotations

import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional

from aqt import gui_hooks, mw
from aqt.qt import (
    QAction,
    QCheckBox,
    QComboBox,
    QDesktopServices,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QTimer,
    QUrl,
    QVBoxLayout,
    QWidget,
)
from aqt.utils import showInfo, tooltip


ADDON_NAME = "DeckBridge Sync"
DEFAULT_ADDON_VERSION = "0.2.0"
TRACKING_MODEL = "DeckBridge Sync"
TRACKING_TAG_PREFIX = "deckbridge_card_"
CONFIG_KEY = "deckbridge"
DEFAULT_PLATFORM_URL = "https://anki-collab.vercel.app"
LEGACY_LOCAL_PLATFORM_URLS = {
    "http://localhost:4175",
    "http://127.0.0.1:4175",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
}
SUPPORTED_CONFLICT_POLICIES = ("detect", "overwrite-platform")
_last_autoconfig_error = ""

DEFAULT_CONFIG: Dict[str, Any] = {
    "platform_url": DEFAULT_PLATFORM_URL,
    "api_token": "",
    "deck_id": "",
    "email": "",
    "local_deck": "",
    "conflict_policy": "detect",
    "auto_sync_minutes": 0,
    "timeout_seconds": 30,
    "batch_size": 250,
    "tag_filter": "",
    "include_suspended": True,
    "create_missing_notes": True,
    "pull_overwrites_local": False,
    "sync_on_profile_open": False,
    "sync_on_close": False,
}

DEFAULT_STORED_CONFIG: Dict[str, Any] = {
    "url": DEFAULT_CONFIG["platform_url"],
    "token": "",
    "email": DEFAULT_CONFIG["email"],
    "deckMappings": [],
    "autoSync": False,
    "auto_sync_minutes": DEFAULT_CONFIG["auto_sync_minutes"],
    "timeout_seconds": DEFAULT_CONFIG["timeout_seconds"],
    "batch_size": DEFAULT_CONFIG["batch_size"],
    "tag_filter": DEFAULT_CONFIG["tag_filter"],
    "include_suspended": DEFAULT_CONFIG["include_suspended"],
    "create_missing_notes": DEFAULT_CONFIG["create_missing_notes"],
    "pull_overwrites_local": DEFAULT_CONFIG["pull_overwrites_local"],
    "sync_on_profile_open": DEFAULT_CONFIG["sync_on_profile_open"],
    "sync_on_close": DEFAULT_CONFIG["sync_on_close"],
}

_timer: Optional[QTimer] = None
_sync_running = False


def addon_manifest() -> Dict[str, Any]:
    try:
        manifest_path = os.path.join(os.path.dirname(__file__), "manifest.json")
        with open(manifest_path, "r", encoding="utf-8") as manifest_file:
            manifest = json.load(manifest_file)
        return manifest if isinstance(manifest, dict) else {}
    except Exception:
        return {}


def addon_version() -> str:
    return str(addon_manifest().get("version") or DEFAULT_ADDON_VERSION)


ADDON_VERSION = addon_version()


def _collection_config() -> Dict[str, Any]:
    try:
        stored = mw.col.conf.get(CONFIG_KEY, {})
        return stored if isinstance(stored, dict) else {}
    except Exception:
        return {}


def _legacy_addon_config() -> Dict[str, Any]:
    try:
        stored = mw.addonManager.getConfig(__name__) or {}
        return stored if isinstance(stored, dict) else {}
    except Exception:
        return {}


def _first_mapping(stored: Dict[str, Any]) -> Dict[str, Any]:
    mappings = stored.get("deckMappings")
    if isinstance(mappings, list) and mappings and isinstance(mappings[0], dict):
        return mappings[0]
    return {}


def normalize_platform_url(value: str) -> str:
    raw = str(value or "").strip()
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise RuntimeError("DeckBridge platform URL must be a valid http(s) URL.")
    if parsed.username or parsed.password:
        raise RuntimeError("DeckBridge platform URL must not include credentials.")
    if parsed.query or parsed.fragment:
        raise RuntimeError("DeckBridge platform URL must not include query parameters or fragments.")
    try:
        port = parsed.port
    except ValueError as error:
        raise RuntimeError("DeckBridge platform URL includes an invalid port.") from error

    host = parsed.hostname or ""
    if not host:
        raise RuntimeError("DeckBridge platform URL must include a host.")
    host = host.lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{port}" if port is not None else host
    path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((parsed.scheme.lower(), netloc, path, "", ""))


def normalize_api_token(value: str) -> str:
    token = str(value or "").strip()
    if not token:
        raise RuntimeError("DeckBridge API token is required.")
    if not token.startswith("db_"):
        raise RuntimeError("DeckBridge API token must start with db_.")
    return token


def _stored_from_flat(flat: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    base_config = {**DEFAULT_STORED_CONFIG, **(base or {})}
    mapping = _first_mapping(base_config)
    local_deck = str(flat.get("local_deck", mapping.get("localDeck", "")) or "").strip()
    deck_id = str(flat.get("deck_id", mapping.get("deckId", DEFAULT_CONFIG["deck_id"])) or "").strip()
    conflict_policy = str(flat.get("conflict_policy", mapping.get("conflictPolicy", "detect")) or "detect")
    if conflict_policy not in SUPPORTED_CONFLICT_POLICIES:
        conflict_policy = "detect"

    next_config = {
        **base_config,
        "url": normalize_platform_url(str(flat.get("platform_url", flat.get("url", base_config.get("url", DEFAULT_CONFIG["platform_url"]))) or "")),
        "token": str(flat.get("api_token", flat.get("token", base_config.get("token", ""))) or "").strip(),
        "email": str(flat.get("email", base_config.get("email", "")) or "").strip(),
        "autoSync": bool(flat.get("autoSync", base_config.get("autoSync", False))),
        "auto_sync_minutes": int(flat.get("auto_sync_minutes", base_config.get("auto_sync_minutes", 0)) or 0),
        "timeout_seconds": int(flat.get("timeout_seconds", base_config.get("timeout_seconds", 30)) or 30),
        "batch_size": int(flat.get("batch_size", base_config.get("batch_size", 250)) or 250),
        "tag_filter": str(flat.get("tag_filter", base_config.get("tag_filter", "")) or "").strip(),
        "include_suspended": bool(flat.get("include_suspended", base_config.get("include_suspended", True))),
        "create_missing_notes": bool(flat.get("create_missing_notes", base_config.get("create_missing_notes", True))),
        "pull_overwrites_local": bool(flat.get("pull_overwrites_local", base_config.get("pull_overwrites_local", False))),
        "sync_on_profile_open": bool(flat.get("sync_on_profile_open", base_config.get("sync_on_profile_open", False))),
        "sync_on_close": bool(flat.get("sync_on_close", base_config.get("sync_on_close", False))),
    }
    next_config["deckMappings"] = [{
        "localDeck": local_deck,
        "deckId": deck_id,
        "conflictPolicy": conflict_policy,
    }]
    return next_config


def _validated_stored_from_flat(flat: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    stored = _stored_from_flat(flat, base)
    token = str(stored.get("token", "") or "").strip()
    if token:
        stored["token"] = normalize_api_token(token)
    return stored


def _flat_from_stored(stored: Dict[str, Any]) -> Dict[str, Any]:
    mapping = _first_mapping(stored)
    auto_sync_minutes = int(stored.get("auto_sync_minutes", DEFAULT_CONFIG["auto_sync_minutes"]) or 0)
    platform = stored.get("url", stored.get("platform_url", DEFAULT_CONFIG["platform_url"]))
    if str(platform or "").strip().rstrip("/") in LEGACY_LOCAL_PLATFORM_URLS:
        platform = DEFAULT_PLATFORM_URL
    return {
        **DEFAULT_CONFIG,
        "platform_url": platform,
        "api_token": stored.get("token", stored.get("api_token", "")),
        "email": stored.get("email", stored.get("email", "")),
        "deck_id": mapping.get("deckId", stored.get("deck_id", DEFAULT_CONFIG["deck_id"])),
        "local_deck": mapping.get("localDeck", stored.get("local_deck", "")),
        "conflict_policy": mapping.get("conflictPolicy", stored.get("conflict_policy", "detect")),
        "auto_sync_minutes": auto_sync_minutes,
        "autoSync": bool(stored.get("autoSync", auto_sync_minutes > 0)),
        "timeout_seconds": stored.get("timeout_seconds", DEFAULT_CONFIG["timeout_seconds"]),
        "batch_size": stored.get("batch_size", DEFAULT_CONFIG["batch_size"]),
        "tag_filter": stored.get("tag_filter", DEFAULT_CONFIG["tag_filter"]),
        "include_suspended": stored.get("include_suspended", DEFAULT_CONFIG["include_suspended"]),
        "create_missing_notes": stored.get("create_missing_notes", DEFAULT_CONFIG["create_missing_notes"]),
        "pull_overwrites_local": stored.get("pull_overwrites_local", DEFAULT_CONFIG["pull_overwrites_local"]),
        "sync_on_profile_open": stored.get("sync_on_profile_open", DEFAULT_CONFIG["sync_on_profile_open"]),
        "sync_on_close": stored.get("sync_on_close", DEFAULT_CONFIG["sync_on_close"]),
    }


def config() -> Dict[str, Any]:
    stored = _collection_config()
    if stored:
        return _flat_from_stored(stored)
    legacy = _legacy_addon_config()
    if legacy:
        return _flat_from_stored(_stored_from_flat({**DEFAULT_CONFIG, **legacy}))
    return DEFAULT_CONFIG.copy()


def _write_config(stored: Dict[str, Any]) -> None:
    mw.col.conf[CONFIG_KEY] = stored
    try:
        mw.col.set_config(CONFIG_KEY, stored)
    except Exception:
        pass


def save_config(next_config: Dict[str, Any]) -> None:
    stored = _validated_stored_from_flat({**config(), **next_config}, _collection_config())
    _write_config(stored)
    configure_timer()


def _single_query_value(params: Dict[str, List[str]], name: str, *, required: bool = True) -> str:
    values = params.get(name, [])
    if len(values) > 1:
        raise RuntimeError(f"DeckBridge auto-config link has multiple {name} values.")
    value = values[0].strip() if values else ""
    if required and not value:
        raise RuntimeError(f"DeckBridge auto-config link is missing {name}.")
    return value


def _autoconfig_values(url_string: str) -> Dict[str, str]:
    parsed = urllib.parse.urlparse(str(url_string or ""))
    if parsed.scheme.lower() != "anki" or parsed.netloc.lower() != "deckbridge":
        raise RuntimeError("DeckBridge auto-config link must start with anki://deckbridge.")
    params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    platform = _single_query_value(params, "url")
    token = _single_query_value(params, "token")
    deck_id = _single_query_value(params, "deckId")
    local_deck = _single_query_value(params, "localDeck", required=False)
    if not local_deck:
        local_deck = _single_query_value(params, "localDeckName", required=False)
    conflict_policy = _single_query_value(params, "conflictPolicy", required=False) or "detect"
    if conflict_policy not in SUPPORTED_CONFLICT_POLICIES:
        raise RuntimeError("DeckBridge auto-config link has an invalid conflictPolicy.")
    return {
        "platform_url": normalize_platform_url(platform),
        "api_token": normalize_api_token(token),
        "deck_id": deck_id,
        "local_deck": local_deck,
        "conflict_policy": conflict_policy,
    }


def last_autoconfig_error() -> str:
    return _last_autoconfig_error


def apply_autoconfig(url_string: str) -> bool:
    """
    Parse an anki://deckbridge?url=...&token=...&deckId=... URL and apply it
    as the add-on config. Returns True if the config was applied, False on error.
    Called from the URL scheme handler registered below.
    """
    global _last_autoconfig_error
    _last_autoconfig_error = ""
    try:
        values = _autoconfig_values(url_string)
        next_config = config()
        next_config["platform_url"] = values["platform_url"]
        next_config["api_token"] = values["api_token"]
        next_config["deck_id"] = values["deck_id"]
        next_config["local_deck"] = values["local_deck"]
        next_config["conflict_policy"] = values["conflict_policy"]
        validate_token(next_config)
        save_config(next_config)
        return True
    except Exception as error:
        _last_autoconfig_error = str(error)
        return False


def platform_url(cfg: Dict[str, Any], path: str) -> str:
    return f"{normalize_platform_url(str(cfg['platform_url']))}{path}"


def request_json(
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    cfg: Optional[Dict[str, Any]] = None,
    include_auth: bool = True,
) -> Dict[str, Any]:
    cfg = cfg or config()
    body = json.dumps(payload or {}).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if include_auth and cfg.get("api_token"):
        headers["Authorization"] = f"Bearer {cfg['api_token']}"
    request = urllib.request.Request(platform_url(cfg, path), data=body, headers=headers, method=method)
    timeout = max(5, int(cfg.get("timeout_seconds") or 30))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
            message = parsed.get("legacyError") or parsed.get("error", {}).get("message") or detail
        except json.JSONDecodeError:
            message = detail or str(error)
        raise RuntimeError(f"DeckBridge API {error.code}: {message}") from error
    except (urllib.error.URLError, socket.timeout) as error:
        raise RuntimeError(f"DeckBridge is unreachable: {error}") from error


def validate_token(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    active_config = {**(cfg or config())}
    active_config["platform_url"] = normalize_platform_url(str(active_config.get("platform_url", "")))
    active_config["api_token"] = normalize_api_token(str(active_config.get("api_token", "")))
    result = request_json("GET", "/api/me", cfg=active_config)
    user = result.get("user") or {}
    if not user.get("email") and not user.get("name"):
        raise RuntimeError("DeckBridge token validation returned no user.")
    decks = result.get("decks", [])
    if decks is not None and not isinstance(decks, list):
        raise RuntimeError("DeckBridge token validation returned an invalid deck list.")
    return result


def login_to_account(platform: str, email: str, password: str) -> Dict[str, Any]:
    active_config = {**config(), "platform_url": normalize_platform_url(platform), "api_token": ""}
    clean_email = str(email or "").strip()
    if not clean_email:
        raise RuntimeError("DeckBridge email is required.")
    if not password:
        raise RuntimeError("DeckBridge password is required.")
    result = request_json(
        "POST",
        "/api/anki/login",
        {"email": clean_email, "password": password},
        cfg=active_config,
        include_auth=False,
    )
    token = result.get("token") or {}
    raw_token = token.get("token") or token.get("raw")
    if not raw_token:
        raise RuntimeError("DeckBridge login did not return an add-on token.")
    result["api_token"] = normalize_api_token(raw_token)
    result["email"] = clean_email
    return result


def validated_connection_config(next_config: Dict[str, Any]) -> Dict[str, Any]:
    candidate = {**config(), **next_config}
    candidate["platform_url"] = normalize_platform_url(str(candidate.get("platform_url", "")))
    candidate["api_token"] = normalize_api_token(str(candidate.get("api_token", "")))
    validate_token(candidate)
    return candidate


def local_deck_names() -> List[str]:
    try:
        if hasattr(mw.col.decks, "all_names_and_ids"):
            return sorted(str(deck.name) for deck in mw.col.decks.all_names_and_ids())
        if hasattr(mw.col.decks, "allNames"):
            return sorted(str(name) for name in mw.col.decks.allNames())
    except Exception:
        pass
    return []


def active_local_deck() -> str:
    cfg = config()
    if cfg.get("local_deck"):
        return str(cfg["local_deck"])
    current = mw.col.decks.current()
    return str(current.get("name") or "Default")


def safe_tag(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", value)[:180]


def tracking_tag(card_id: str) -> str:
    return f"{TRACKING_TAG_PREFIX}{safe_tag(card_id)}"


def note_query() -> str:
    cfg = config()
    parts = [f'deck:"{active_local_deck()}"']
    if cfg.get("tag_filter"):
        parts.append(f'tag:"{cfg["tag_filter"]}"')
    if not cfg.get("include_suspended", True):
        parts.append("-is:suspended")
    return " ".join(parts)


def note_state(note: Any) -> Dict[str, Any]:
    cards = note.cards()
    due_values = [card.due for card in cards if getattr(card, "due", None) is not None]
    suspended = bool(cards) and all(card.queue < 0 for card in cards)
    if suspended:
        state = "Suspended"
    elif any(card.queue == 0 for card in cards):
        state = "New"
    elif any(card.queue in (1, 3) for card in cards):
        state = "Learning"
    elif cards:
        state = "Review"
    else:
        state = "Anki"
    return {"due": min(due_values) if due_values else None, "state": state, "suspended": suspended}


def note_to_card(note: Any) -> Dict[str, Any]:
    model = note.note_type()
    field_names = list(note.keys())
    state = note_state(note)
    return {
        "id": f"anki-{note.id}",
        "ankiNoteId": int(note.id),
        "type": model.get("name", "Basic"),
        "modelName": model.get("name", "Basic"),
        "fieldOrder": field_names,
        "fields": {name: str(note[name]) for name in field_names},
        "tags": list(note.tags),
        "due": state["due"],
        "state": state["state"],
        "suspended": state["suspended"],
        "modifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(getattr(note, "mod", time.time()))),
        "modifiedBy": "Anki",
        "sourceDeckName": active_local_deck(),
        "sourceDeckPath": active_local_deck(),
    }


def collect_cards() -> List[Dict[str, Any]]:
    note_ids = mw.col.find_notes(note_query())
    return [note_to_card(mw.col.get_note(note_id)) for note_id in note_ids]


def sync_payload(*, dry_run: bool = False) -> Dict[str, Any]:
    cfg = config()
    deck_name = active_local_deck()
    return {
        "cards": collect_cards(),
        "deckName": deck_name,
        "deckPath": deck_name,
        "dryRun": dry_run,
        "allowCreate": True,
        "conflictPolicy": cfg.get("conflict_policy", "detect"),
        "source": ADDON_NAME,
        "client": {
            "name": ADDON_NAME,
            "version": ADDON_VERSION,
            "fingerprint": socket.gethostname(),
        },
    }


def _visible_deck_ids(me: Dict[str, Any]) -> set[str]:
    return {str(deck.get("id")) for deck in me.get("decks", []) if deck.get("id")}


def create_platform_deck_from_anki(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or config()
    created = request_json("POST", "/api/decks/sync/from-anki", sync_payload(dry_run=False), cfg=cfg)
    new_deck_id = str((created.get("deck") or {}).get("id") or created.get("state", {}).get("activeDeckId") or "").strip()
    if not new_deck_id:
        raise RuntimeError("DeckBridge created a deck but did not return its deck ID.")
    save_config({**cfg, "deck_id": new_deck_id, "local_deck": active_local_deck()})
    return created


def ensure_platform_deck() -> Dict[str, Any]:
    cfg = config()
    me = validate_token(cfg)
    deck_id = str(cfg.get("deck_id", "") or "").strip()
    if deck_id and deck_id in _visible_deck_ids(me):
        return cfg
    create_platform_deck_from_anki(cfg)
    return config()


def post_cards(*, dry_run: bool = False) -> Dict[str, Any]:
    cfg = config()
    deck_id = str(cfg.get("deck_id", "") or "").strip()
    if not dry_run:
        me = validate_token(cfg)
        if not deck_id or deck_id not in _visible_deck_ids(me):
            return create_platform_deck_from_anki(cfg)
    elif not deck_id:
        raise RuntimeError("No DeckBridge deck is selected yet. Use Push Anki deck to DeckBridge to create one from Anki first.")
    return request_json("POST", f"/api/decks/{cfg['deck_id']}/sync/cards", sync_payload(dry_run=dry_run))


def ensure_deck(name: str) -> int:
    deck_id = mw.col.decks.id(name)
    mw.col.decks.select(deck_id)
    return deck_id


def ensure_tracking_model(field_names: Iterable[str]) -> Dict[str, Any]:
    models = mw.col.models
    model = models.by_name(TRACKING_MODEL)
    if model is None:
        model = models.new(TRACKING_MODEL)
        models.addField(model, models.new_field("Front"))
        models.addField(model, models.new_field("Back"))
        template = models.new_template("Card 1")
        template["qfmt"] = "{{Front}}"
        template["afmt"] = "{{FrontSide}}<hr id=answer>{{Back}}"
        models.addTemplate(model, template)
        models.add(model)

    existing = {field["name"] for field in model["flds"]}
    for name in field_names:
        if name not in existing:
            models.addField(model, models.new_field(name))
            existing.add(name)
    models.save(model)
    return model


def find_tracked_note(card: Dict[str, Any]) -> Optional[Any]:
    note_id = card.get("ankiNoteId")
    if note_id:
        try:
            return mw.col.get_note(int(note_id))
        except Exception:
            pass
    query = f'tag:{tracking_tag(str(card["id"]))}'
    found = mw.col.find_notes(query)
    return mw.col.get_note(found[0]) if found else None


def assign_fields(note: Any, fields: Dict[str, str]) -> None:
    for name in note.keys():
        if name in fields:
            note[name] = str(fields[name])
    if "Front" in note and "Front" not in fields:
        note["Front"] = next(iter(fields.values()), "")
    if "Back" in note and "Back" not in fields:
        values = list(fields.values())
        note["Back"] = values[1] if len(values) > 1 else ""


def upsert_platform_card(card: Dict[str, Any]) -> str:
    cfg = config()
    fields = {str(key): str(value) for key, value in (card.get("fields") or {}).items()}
    note = find_tracked_note(card)
    if note and not cfg.get("pull_overwrites_local", False):
        return "skipped"

    if note is None:
        if not cfg.get("create_missing_notes", True):
            return "skipped"
        model = ensure_tracking_model(fields.keys())
        note = mw.col.new_note(model)
        ensure_deck(active_local_deck())
    else:
        ensure_tracking_model(set(note.keys()) | set(fields.keys()))

    assign_fields(note, fields)
    tags = set(card.get("tags") or [])
    tags.add(tracking_tag(str(card["id"])))
    tags.add("DeckBridge")
    note.tags = sorted(tags)
    if note.id:
        mw.col.update_note(note)
        return "updated"
    mw.col.add_note(note, mw.col.decks.id(active_local_deck()))
    return "created"


def pull_from_platform() -> Dict[str, int]:
    cfg = config()
    state = request_json("GET", f"/api/decks/{cfg['deck_id']}")
    decks = state.get("decks") or []
    if not decks:
        raise RuntimeError("DeckBridge returned no deck")
    deck = decks[0]
    if not config().get("local_deck"):
        next_config = config()
        next_config["local_deck"] = deck.get("name") or active_local_deck()
        save_config(next_config)
    ensure_deck(active_local_deck())
    stats = {"created": 0, "updated": 0, "skipped": 0}
    for card in deck.get("cards", []):
        action = upsert_platform_card(card)
        stats[action] += 1
    mw.col.save()
    mw.reset()
    return stats


def show_result(prefix: str, payload: Dict[str, Any]) -> None:
    result = payload.get("result", payload)
    stats = result.get("stats", {})
    conflicts = result.get("conflicts", [])
    message = (
        f"{prefix}\n\n"
        f"Total: {stats.get('total', 0)}\n"
        f"Created: {stats.get('created', 0)}\n"
        f"Updated: {stats.get('updated', 0)}\n"
        f"Skipped: {stats.get('skipped', 0)}\n"
        f"Conflicts: {stats.get('conflicts', len(conflicts))}"
    )
    if conflicts:
        message += "\n\nConflicts were recorded in DeckBridge for review."
    showInfo(message, title=ADDON_NAME)


def run_guarded(label: str, callback: Any) -> None:
    global _sync_running
    if _sync_running:
        tooltip("DeckBridge sync is already running")
        return
    _sync_running = True
    try:
        callback()
    except Exception as error:
        showInfo(str(error), title=f"{ADDON_NAME}: {label} failed")
    finally:
        _sync_running = False


def test_connection() -> None:
    def task() -> None:
        me = validate_token()
        user = me.get("user", {})
        decks = me.get("decks", [])
        showInfo(
            f"Connected as {user.get('email') or user.get('name') or 'DeckBridge user'}.\n"
            f"Visible decks: {len(decks)}",
            title=ADDON_NAME,
        )

    run_guarded("Connection test", task)


def preview_push() -> None:
    run_guarded("Preview", lambda: show_result("Dry-run push preview complete.", post_cards(dry_run=True)))


def push_to_platform() -> None:
    run_guarded("Push", lambda: show_result("Anki deck synced to DeckBridge.", post_cards(dry_run=False)))


def pull_to_anki() -> None:
    def task() -> None:
        stats = pull_from_platform()
        showInfo(
            f"Pull complete.\n\nCreated: {stats['created']}\nUpdated: {stats['updated']}\nSkipped: {stats['skipped']}",
            title=ADDON_NAME,
        )

    run_guarded("Pull", task)


def bidirectional_sync() -> None:
    def task() -> None:
        pushed = post_cards(dry_run=False)
        conflicts = pushed.get("result", {}).get("stats", {}).get("conflicts", 0)
        if conflicts:
            show_result("Push recorded conflicts. Pull was skipped.", pushed)
            return
        pulled = pull_from_platform()
        showInfo(
            "Bidirectional sync complete.\n\n"
            f"Platform push updated {pushed.get('result', {}).get('stats', {}).get('updated', 0)} card(s).\n"
            f"Anki pull created {pulled['created']} and updated {pulled['updated']} note(s).",
            title=ADDON_NAME,
        )

    run_guarded("Bidirectional sync", task)


class SettingsDialog(QDialog):
    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowTitle(f"{ADDON_NAME} Settings")
        self.setMinimumWidth(480)
        cfg = config()

        # --- Setup section header ---
        setup_label = QLabel("<b>Connection</b>")

        self.platform_url = QLineEdit(str(cfg["platform_url"]))
        self.platform_url.setPlaceholderText("https://your-deckbridge.vercel.app")

        self.email = QLineEdit(str(cfg.get("email", "")))
        self.email.setPlaceholderText("you@example.com")

        self.password = QLineEdit("")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.password.setPlaceholderText("DeckBridge password")

        self.api_token = QLineEdit(str(cfg["api_token"]))
        self.api_token.setEchoMode(QLineEdit.EchoMode.Password)
        self.api_token.setPlaceholderText("Created automatically after login")

        self.deck_id = QLineEdit(str(cfg["deck_id"]))
        self.deck_id.setPlaceholderText("deck-id from DeckBridge")

        self.local_deck = QComboBox()
        self.local_deck.setEditable(True)
        self.local_deck.addItem("")
        self.local_deck.addItems(local_deck_names())
        self.local_deck.setCurrentText(str(cfg["local_deck"]))
        self.local_deck.setPlaceholderText("My Anki Deck (leave blank to use active deck)")

        test_btn = QPushButton("Test connection")
        test_btn.clicked.connect(self._test_connection)
        login_btn = QPushButton("Log in to DeckBridge")
        login_btn.clicked.connect(self._login)

        # --- Sync section ---
        sync_label = QLabel("<b>Sync options</b>")

        self.conflict_policy = QComboBox()
        self.conflict_policy.addItems(["detect", "overwrite-platform"])
        self.conflict_policy.setCurrentText(str(cfg["conflict_policy"]))
        self.auto_sync_minutes = QSpinBox()
        self.auto_sync_minutes.setRange(0, 1440)
        self.auto_sync_minutes.setValue(int(cfg["auto_sync_minutes"]))
        self.timeout_seconds = QSpinBox()
        self.timeout_seconds.setRange(5, 300)
        self.timeout_seconds.setValue(int(cfg["timeout_seconds"]))
        self.batch_size = QSpinBox()
        self.batch_size.setRange(25, 5000)
        self.batch_size.setValue(int(cfg["batch_size"]))
        self.tag_filter = QLineEdit(str(cfg["tag_filter"]))
        self.include_suspended = QCheckBox()
        self.include_suspended.setChecked(bool(cfg["include_suspended"]))
        self.create_missing_notes = QCheckBox()
        self.create_missing_notes.setChecked(bool(cfg["create_missing_notes"]))
        self.pull_overwrites_local = QCheckBox()
        self.pull_overwrites_local.setChecked(bool(cfg["pull_overwrites_local"]))
        self.sync_on_profile_open = QCheckBox()
        self.sync_on_profile_open.setChecked(bool(cfg["sync_on_profile_open"]))
        self.sync_on_close = QCheckBox()
        self.sync_on_close.setChecked(bool(cfg["sync_on_close"]))
        self.pull_after_save = QCheckBox()
        self.pull_after_save.setChecked(False)

        conn_form = QFormLayout()
        conn_form.addRow(setup_label)
        conn_form.addRow("Platform URL", self.platform_url)
        conn_form.addRow("Email", self.email)
        conn_form.addRow("Password", self.password)
        conn_form.addRow("API token", self.api_token)
        conn_form.addRow("DeckBridge deck ID", self.deck_id)
        conn_form.addRow("Local Anki deck", self.local_deck)
        conn_form.addRow("", login_btn)
        conn_form.addRow("", test_btn)

        sync_form = QFormLayout()
        sync_form.addRow(sync_label)
        sync_form.addRow("Conflict policy", self.conflict_policy)
        sync_form.addRow("Auto-sync minutes (0 = off)", self.auto_sync_minutes)
        sync_form.addRow("Timeout seconds", self.timeout_seconds)
        sync_form.addRow("Batch size", self.batch_size)
        sync_form.addRow("Only sync Anki tag", self.tag_filter)
        sync_form.addRow("Include suspended cards", self.include_suspended)
        sync_form.addRow("Create missing Anki notes on pull", self.create_missing_notes)
        sync_form.addRow("Pull overwrites local notes", self.pull_overwrites_local)
        sync_form.addRow("Pull from DeckBridge after saving", self.pull_after_save)
        sync_form.addRow("Sync on profile open", self.sync_on_profile_open)
        sync_form.addRow("Sync before profile close", self.sync_on_close)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout()
        layout.addLayout(conn_form)
        layout.addLayout(sync_form)
        layout.addWidget(buttons)
        self.setLayout(layout)

    def _test_connection(self) -> None:
        """Temporarily apply form values and test the connection."""
        original = config()
        try:
            me = validate_token({**original, **self.values()})
            user = me.get("user", {})
            decks = me.get("decks", [])
            showInfo(
                f"Connected as {user.get('email') or user.get('name') or 'DeckBridge user'}.\n"
                f"Visible decks: {len(decks)}",
                title=ADDON_NAME,
            )
        except Exception as error:
            showInfo(str(error), title=f"{ADDON_NAME}: Connection failed")

    def _login(self) -> None:
        try:
            result = login_to_account(
                self.platform_url.text().strip(),
                self.email.text().strip(),
                self.password.text(),
            )
            self.api_token.setText(result["api_token"])
            decks = result.get("decks") or []
            if decks and not self.deck_id.text().strip():
                self.deck_id.setText(str(decks[0].get("id") or ""))
            self.password.clear()
            showInfo(
                f"Logged in as {self.email.text().strip()}.\n"
                f"Visible DeckBridge decks: {len(decks)}.\n\n"
                "Use Push Anki deck to DeckBridge to create a workspace from this Anki deck if none exists.",
                title=ADDON_NAME,
            )
        except Exception as error:
            showInfo(str(error), title=f"{ADDON_NAME}: Login failed")

    def values(self) -> Dict[str, Any]:
        return {
            "platform_url": self.platform_url.text().strip(),
            "api_token": self.api_token.text().strip(),
            "email": self.email.text().strip(),
            "deck_id": self.deck_id.text().strip(),
            "local_deck": self.local_deck.currentText().strip(),
            "conflict_policy": self.conflict_policy.currentText(),
            "auto_sync_minutes": self.auto_sync_minutes.value(),
            "timeout_seconds": self.timeout_seconds.value(),
            "batch_size": self.batch_size.value(),
            "tag_filter": self.tag_filter.text().strip(),
            "include_suspended": self.include_suspended.isChecked(),
            "create_missing_notes": self.create_missing_notes.isChecked(),
            "pull_overwrites_local": self.pull_overwrites_local.isChecked(),
            "sync_on_profile_open": self.sync_on_profile_open.isChecked(),
            "sync_on_close": self.sync_on_close.isChecked(),
        }


def open_settings() -> None:
    dialog = SettingsDialog(mw)
    if dialog.exec():
        try:
            save_config(validated_connection_config(dialog.values()))
            tooltip("DeckBridge Sync settings saved")
            if dialog.pull_after_save.isChecked():
                QTimer.singleShot(0, pull_to_anki)
        except Exception as error:
            showInfo(str(error), title=f"{ADDON_NAME}: Settings not saved")


def configure_timer() -> None:
    global _timer
    cfg = config()
    minutes = int(cfg.get("auto_sync_minutes") or 0)
    if _timer is not None:
        _timer.stop()
        _timer.deleteLater()
        _timer = None
    if minutes <= 0:
        return
    _timer = QTimer(mw)
    _timer.setInterval(minutes * 60 * 1000)
    _timer.timeout.connect(bidirectional_sync)
    _timer.start()


def add_menu() -> None:
    menu = QMenu(ADDON_NAME, mw)
    actions = [
        ("Test connection", test_connection),
        ("Preview push to DeckBridge", preview_push),
        ("Push/create Anki deck in DeckBridge", push_to_platform),
        ("Pull DeckBridge deck into Anki", pull_to_anki),
        ("Bidirectional sync", bidirectional_sync),
        ("Settings", open_settings),
    ]
    for label, callback in actions:
        action = QAction(label, mw)
        action.triggered.connect(callback)
        menu.addAction(action)
    mw.form.menuTools.addMenu(menu)


def on_profile_open() -> None:
    configure_timer()
    if config().get("sync_on_profile_open"):
        bidirectional_sync()


def on_profile_will_close() -> None:
    if config().get("sync_on_close"):
        bidirectional_sync()


gui_hooks.profile_did_open.append(on_profile_open)
gui_hooks.profile_will_close.append(on_profile_will_close)
add_menu()


# --- anki://deckbridge auto-config URL scheme handler ---

def _handle_url_scheme(url: str) -> None:
    """Called by Anki when the add-on's URL scheme is triggered."""
    if apply_autoconfig(url):
        showInfo(
            "DeckBridge Sync configuration saved.\n\n"
            "Settings will open next so you can choose the Local Anki deck.",
            title=ADDON_NAME,
        )
        QTimer.singleShot(0, open_settings)
    else:
        detail = last_autoconfig_error()
        message = "Could not apply auto-config link. Please configure manually via Settings."
        if detail:
            message += f"\n\nReason: {detail}"
        showInfo(
            message,
            title=ADDON_NAME,
        )


# Register URL scheme if supported by this Anki version
try:
    from aqt import addons
    if hasattr(addons, "AddonManager") and hasattr(mw.addonManager, "registerUrlHandler"):
        mw.addonManager.registerUrlHandler("deckbridge", _handle_url_scheme)
except Exception:
    pass
