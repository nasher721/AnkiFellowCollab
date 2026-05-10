from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from typing import Any, Dict, Iterable, List, Optional

try:
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
except ImportError:
    class _QtStub:
        class StandardButton:
            Save = 1
            Cancel = 2

        class ButtonRole:
            ActionRole = 1

        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def __getattr__(self, _name: str) -> "_QtStub":
            return self

        def __call__(self, *_args: Any, **_kwargs: Any) -> "_QtStub":
            return self

        def __or__(self, _other: Any) -> int:
            return 0

        def append(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def connect(self, *_args: Any, **_kwargs: Any) -> None:
            pass

    gui_hooks = _QtStub()
    mw = _QtStub()
    QAction = QCheckBox = QComboBox = QDesktopServices = QDialog = QDialogButtonBox = QFormLayout = _QtStub
    QLabel = QLineEdit = QMenu = QPlainTextEdit = QPushButton = QSpinBox = QTimer = QUrl = QVBoxLayout = QWidget = _QtStub

    def showInfo(*_args: Any, **_kwargs: Any) -> None:
        pass

    def tooltip(*_args: Any, **_kwargs: Any) -> None:
        pass


ADDON_NAME = "DeckBridge Sync"
DEFAULT_ADDON_VERSION = "0.2.2"
TRACKING_MODEL = "DeckBridge Sync"
TRACKING_TAG_PREFIX = "deckbridge_card_"
CONFIG_KEY = "deckbridge"
DEFAULT_PLATFORM_URL = "https://anki-collab.vercel.app"
MAX_SYNC_REQUEST_BYTES = 3_500_000
MAX_INLINE_MEDIA_BYTES = 750_000
COMPRESS_FIELD_AFTER_BYTES = 64_000
DEFAULT_TIMEOUT_SECONDS = 120
MIN_REQUEST_TIMEOUT_SECONDS = 5
MIN_SYNC_TIMEOUT_SECONDS = 120
MIN_MEDIA_UPLOAD_TIMEOUT_SECONDS = 120
LEGACY_LOCAL_PLATFORM_URLS = {
    "http://localhost:4175",
    "http://127.0.0.1:4175",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
}
SUPPORTED_CONFLICT_POLICIES = ("detect", "overwrite-platform")
MEDIA_REF_RE = re.compile(
    r"""<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|\[sound:([^\]]+)\]""",
    re.IGNORECASE,
)
_last_autoconfig_error = ""

DEFAULT_CONFIG: Dict[str, Any] = {
    "platform_url": DEFAULT_PLATFORM_URL,
    "api_token": "",
    "deck_id": "",
    "email": "",
    "local_deck": "",
    "conflict_policy": "detect",
    "auto_sync_minutes": 0,
    "timeout_seconds": DEFAULT_TIMEOUT_SECONDS,
    "batch_size": 250,
    "tag_filter": "",
    "include_suspended": True,
    "create_missing_notes": True,
    "pull_overwrites_local": False,
    "pull_scheduling_on_sync": True,
    "updates_checkpoint": "",
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
    "pull_scheduling_on_sync": DEFAULT_CONFIG["pull_scheduling_on_sync"],
    "updateCheckpoints": {},
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
        "timeout_seconds": int(flat.get("timeout_seconds", base_config.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)) or DEFAULT_TIMEOUT_SECONDS),
        "batch_size": int(flat.get("batch_size", base_config.get("batch_size", 250)) or 250),
        "tag_filter": str(flat.get("tag_filter", base_config.get("tag_filter", "")) or "").strip(),
        "include_suspended": bool(flat.get("include_suspended", base_config.get("include_suspended", True))),
        "create_missing_notes": bool(flat.get("create_missing_notes", base_config.get("create_missing_notes", True))),
        "pull_overwrites_local": bool(flat.get("pull_overwrites_local", base_config.get("pull_overwrites_local", False))),
        "pull_scheduling_on_sync": bool(flat.get("pull_scheduling_on_sync", base_config.get("pull_scheduling_on_sync", True))),
        "updateCheckpoints": dict(base_config.get("updateCheckpoints", {}) or {}),
        "sync_on_profile_open": bool(flat.get("sync_on_profile_open", base_config.get("sync_on_profile_open", False))),
        "sync_on_close": bool(flat.get("sync_on_close", base_config.get("sync_on_close", False))),
    }
    updates_checkpoint = str(flat.get("updates_checkpoint", "") or "").strip()
    if deck_id and updates_checkpoint:
        next_config["updateCheckpoints"][deck_id] = updates_checkpoint
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
    deck_id = mapping.get("deckId", stored.get("deck_id", DEFAULT_CONFIG["deck_id"]))
    checkpoints = stored.get("updateCheckpoints") if isinstance(stored.get("updateCheckpoints"), dict) else {}
    return {
        **DEFAULT_CONFIG,
        "platform_url": platform,
        "api_token": stored.get("token", stored.get("api_token", "")),
        "email": stored.get("email", stored.get("email", "")),
        "deck_id": deck_id,
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
        "pull_scheduling_on_sync": stored.get("pull_scheduling_on_sync", DEFAULT_CONFIG["pull_scheduling_on_sync"]),
        "updates_checkpoint": checkpoints.get(deck_id, stored.get("updates_checkpoint", "")),
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


def protocol_recovery_message(
    *,
    method: str = "",
    path: str = "",
    status: Optional[int] = None,
    detail: str = "",
    timeout: Optional[int] = None,
) -> str:
    context = f"{method} {path}".strip()
    lower_detail = str(detail or "").lower()
    if "media" in lower_detail and ("upload" in lower_detail or "target" in lower_detail or "storage" in lower_detail):
        return (
            f"DeckBridge media upload target failed{f' for {context}' if context else ''}: {detail}. "
            "Retry media upload before card sync; cards can reference media only after the signed upload target succeeds."
        )
    if status in (401, 403) or "invalid token" in lower_detail or "unauthorized" in lower_detail:
        return (
            f"DeckBridge API {status or 'auth'}: {detail or 'invalid token'}. "
            "Reconnect DeckBridge from the add-on settings to refresh the API token."
        )
    if "deck mapping" in lower_detail or "deckid" in lower_detail or "deck id" in lower_detail or "no deckbridge deck" in lower_detail:
        return (
            f"{detail or 'No DeckBridge deck mapping is configured.'} "
            "Choose a local Anki deck and mapped DeckBridge deck in settings, then try again."
        )
    if status == 409 or "conflict" in lower_detail:
        return (
            f"DeckBridge detected a conflict while syncing{f' {context}' if context else ''}. "
            "Review conflicts in DeckBridge before switching away from conflictPolicy=detect or overwriting platform cards."
        )
    if status is not None and status >= 500:
        return (
            f"DeckBridge platform error{f' while calling {context}' if context else ''}: {detail or 'Unexpected server error'}. "
            "The platform accepted the request but could not complete it. Retry after a moment; "
            "if it repeats, verify the DeckBridge deployment and database migrations."
        )
    if timeout is not None:
        return (
            f"DeckBridge timed out after {timeout} seconds while waiting for {context}. "
            "The server may still be processing this deck chunk; wait a moment, then try the push again. "
            "If it repeats, use a smaller batch size or increase the timeout in settings."
        )
    if "ssl" in lower_detail or "certificate" in lower_detail or "tls" in lower_detail:
        return (
            f"DeckBridge could not establish a secure HTTPS connection{f' for {context}' if context else ''}: {detail}. "
            "Check SSL inspection, proxy, VPN, antivirus, or system certificate settings, then retry."
        )
    if "proxy" in lower_detail or "vpn" in lower_detail:
        return (
            f"DeckBridge network path failed{f' for {context}' if context else ''}: {detail}. "
            "Check proxy or VPN settings and confirm Anki can reach the DeckBridge URL."
        )
    return (
        f"DeckBridge is unreachable{f' while calling {context}' if context else ''}: {detail}. "
        "Check your internet connection, VPN/proxy/antivirus rules, and the DeckBridge platform URL in settings."
    )


def _http_error_detail(error: urllib.error.HTTPError) -> str:
    detail = error.read().decode("utf-8", errors="replace")
    try:
        parsed = json.loads(detail)
        message = parsed.get("detail") or parsed.get("legacyError") or parsed.get("error", {}).get("message") or detail
    except json.JSONDecodeError:
        message = detail or str(error)
    return str(message)


def request_json(
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    cfg: Optional[Dict[str, Any]] = None,
    include_auth: bool = True,
    timeout_floor: int = MIN_REQUEST_TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    cfg = cfg or config()
    body = json.dumps(payload or {}).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if include_auth and cfg.get("api_token"):
        headers["Authorization"] = f"Bearer {cfg['api_token']}"
    request = urllib.request.Request(platform_url(cfg, path), data=body, headers=headers, method=method)
    timeout = max(int(timeout_floor), int(cfg.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        message = _http_error_detail(error)
        recovery = protocol_recovery_message(method=method, path=path, status=error.code, detail=message)
        if recovery.startswith(f"DeckBridge API {error.code}:"):
            raise RuntimeError(recovery) from error
        raise RuntimeError(f"DeckBridge API {error.code}: {recovery}") from error
    except socket.timeout as error:
        raise RuntimeError(protocol_recovery_message(method=method, path=path, timeout=timeout)) from error
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        detail = str(reason)
        raise RuntimeError(protocol_recovery_message(method=method, path=path, detail=detail)) from error
    except ssl.SSLError as error:
        raise RuntimeError(protocol_recovery_message(method=method, path=path, detail=str(error))) from error


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


def media_refs_from_fields(fields: Dict[str, str]) -> List[str]:
    refs: List[str] = []
    seen = set()
    for value in fields.values():
        for match in MEDIA_REF_RE.finditer(str(value or "")):
            raw = next((group for group in match.groups() if group), "")
            parsed = urllib.parse.urlsplit(raw.strip())
            if parsed.scheme.lower() in ("http", "https", "data"):
                continue
            filename = os.path.basename(urllib.parse.unquote(raw.strip()))
            if filename and filename not in seen:
                refs.append(filename)
                seen.add(filename)
    return refs


def _compressed_field_payload(value: str) -> Optional[Dict[str, Any]]:
    raw = str(value or "").encode("utf-8")
    if len(raw) < COMPRESS_FIELD_AFTER_BYTES:
        return None
    compressed = zlib.compress(raw, 9)
    encoded = base64.b64encode(compressed).decode("ascii")
    if len(encoded) + 240 >= len(raw):
        return None
    return {
        "encoding": "zlib+base64",
        "data": encoded,
        "originalBytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def compress_large_card_fields(card: Dict[str, Any]) -> Dict[str, Any]:
    fields = card.get("fields") or {}
    if not isinstance(fields, dict):
        return card
    next_fields: Dict[str, str] = {}
    compressed_fields: Dict[str, Dict[str, Any]] = {}
    for name, value in fields.items():
        text = str(value or "")
        compressed = _compressed_field_payload(text)
        if compressed:
            next_fields[str(name)] = ""
            compressed_fields[str(name)] = compressed
        else:
            next_fields[str(name)] = text
    if not compressed_fields:
        return card
    return {**card, "fields": next_fields, "compressedFields": compressed_fields}


def media_dir() -> str:
    try:
        return str(mw.col.media.dir())
    except Exception:
        return ""


def local_media_assets(cards: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    assets: Dict[str, Dict[str, Any]] = {}
    try:
        root = media_dir()
    except Exception:
        return assets
    if not root:
        return assets
    for card in cards:
        for ref in card.get("mediaRefs") or []:
            filename = os.path.basename(str(ref or ""))
            if not filename or filename in assets:
                continue
            media_path = os.path.join(root, filename)
            try:
                size_bytes = os.path.getsize(media_path)
            except OSError:
                continue
            mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            try:
                digest = hashlib.sha256()
                with open(media_path, "rb") as media_file:
                    for chunk in iter(lambda: media_file.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError:
                continue
            assets[filename] = {
                "filename": filename,
                "mimeType": mime_type,
                "sha256": digest.hexdigest(),
                "sizeBytes": size_bytes,
                "path": media_path,
            }
    return assets


def upload_media_file(upload_url: str, asset: Dict[str, Any]) -> None:
    with open(str(asset["path"]), "rb") as media_file:
        data = media_file.read()
    request = urllib.request.Request(
        upload_url,
        data=data,
        headers={
            "Content-Type": str(asset.get("mimeType") or "application/octet-stream"),
            "Cache-Control": "max-age=3600",
            "x-upsert": "true",
        },
        method="PUT",
    )
    timeout = max(MIN_MEDIA_UPLOAD_TIMEOUT_SECONDS, int(config().get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
    except urllib.error.HTTPError as error:
        detail = _http_error_detail(error)
        raise RuntimeError(protocol_recovery_message(
            method="PUT",
            path=str(asset.get("filename") or "media upload"),
            status=error.code,
            detail=f"media upload target failed for {asset['filename']}: {detail}",
        )) from error
    except socket.timeout as error:
        raise RuntimeError(protocol_recovery_message(
            method="PUT",
            path=str(asset.get("filename") or "media upload"),
            timeout=timeout,
        )) from error
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        raise RuntimeError(protocol_recovery_message(
            method="PUT",
            path=str(asset.get("filename") or "media upload"),
            detail=f"media upload target failed for {asset['filename']}: {reason}",
        )) from error


def upload_large_media_assets(
    assets: Dict[str, Dict[str, Any]],
    *,
    cfg: Dict[str, Any],
    deck_id: str,
) -> Dict[str, Dict[str, Any]]:
    large_assets = [
        {
            "filename": asset["filename"],
            "mimeType": asset["mimeType"],
            "sha256": asset["sha256"],
            "sizeBytes": asset["sizeBytes"],
        }
        for asset in assets.values()
        if int(asset.get("sizeBytes") or 0) > MAX_INLINE_MEDIA_BYTES
    ]
    if not large_assets or not deck_id:
        return {}
    response = request_json(
        "POST",
        f"/api/decks/{deck_id}/media/uploads",
        {"files": large_assets},
        cfg=cfg,
        timeout_floor=MIN_SYNC_TIMEOUT_SECONDS,
    )
    uploads = response.get("uploads") or []
    uploaded: Dict[str, Dict[str, Any]] = {}
    for upload in uploads:
        filename = str(upload.get("filename") or "")
        asset = assets.get(filename)
        upload_url = str(upload.get("uploadUrl") or "")
        if not asset or not upload_url:
            raise RuntimeError(protocol_recovery_message(
                method="POST",
                path=f"/api/decks/{deck_id}/media/uploads",
                detail=f"media upload target missing for {filename or 'a requested file'}",
            ))
        upload_media_file(upload_url, asset)
        uploaded[filename] = {
            "filename": filename,
            "mimeType": upload.get("mimeType") or asset["mimeType"],
            "sha256": upload.get("sha256") or asset["sha256"],
            "sizeBytes": upload.get("sizeBytes") or asset["sizeBytes"],
            "storageBucket": upload.get("storageBucket") or "",
            "storagePath": upload.get("storagePath") or "",
        }
    return uploaded


def parse_deck_updates_response(response: Dict[str, Any]) -> Dict[str, Any]:
    updates = response.get("updates")
    if updates is None:
        updates = response.get("changes", [])
    if not isinstance(updates, list):
        raise RuntimeError("DeckBridge updates response returned an invalid updates list.")
    checkpoint = (
        response.get("checkpoint")
        or response.get("nextCheckpoint")
        or response.get("cursor")
        or (response.get("syncProof") or {}).get("timestamp")
        or response.get("updatedAt")
        or ""
    )
    return {"updates": updates, "checkpoint": str(checkpoint or "").strip()}


def store_updates_checkpoint(deck_id: str, checkpoint: str) -> None:
    clean_deck_id = str(deck_id or "").strip()
    clean_checkpoint = str(checkpoint or "").strip()
    if not clean_deck_id or not clean_checkpoint:
        return
    stored = _collection_config() or _stored_from_flat(config())
    checkpoints = dict(stored.get("updateCheckpoints", {}) or {})
    checkpoints[clean_deck_id] = clean_checkpoint
    stored["updateCheckpoints"] = checkpoints
    _write_config(stored)


def fetch_deck_updates(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = cfg or config()
    deck_id = str(cfg.get("deck_id", "") or "").strip()
    if not deck_id:
        raise RuntimeError(protocol_recovery_message(detail="No DeckBridge deck mapping is configured."))
    checkpoint = str(cfg.get("updates_checkpoint", "") or "").strip()
    path = f"/api/decks/{deck_id}/updates"
    if checkpoint:
        path += "?" + urllib.parse.urlencode({"since": checkpoint})
    parsed = parse_deck_updates_response(request_json("GET", path, cfg=cfg))
    store_updates_checkpoint(deck_id, parsed["checkpoint"])
    return parsed


def collect_media_payload(
    cards: List[Dict[str, Any]],
    *,
    cfg: Optional[Dict[str, Any]] = None,
    deck_id: str = "",
    dry_run: bool = False,
    upload_large: bool = True,
    include_inline: bool = True,
) -> Dict[str, Dict[str, Any]]:
    payload: Dict[str, Dict[str, Any]] = {}
    assets = local_media_assets(cards)
    for filename, asset in assets.items():
        if not include_inline or int(asset.get("sizeBytes") or 0) > MAX_INLINE_MEDIA_BYTES:
            continue
        try:
            with open(str(asset["path"]), "rb") as media_file:
                data = media_file.read()
        except OSError:
            continue
        payload[filename] = {
            "filename": filename,
            "mimeType": asset["mimeType"],
            "sha256": asset["sha256"],
            "sizeBytes": asset["sizeBytes"],
            "dataBase64": base64.b64encode(data).decode("ascii"),
        }
    if upload_large and not dry_run and cfg and deck_id:
        payload.update(upload_large_media_assets(assets, cfg=cfg, deck_id=deck_id))
    return payload


def _card_ord(card: Any, fallback: int = 0) -> int:
    try:
        return max(0, int(getattr(card, "ord", fallback) or 0))
    except Exception:
        return fallback


def _template_for_ord(templates: List[Any], ord_value: int) -> Dict[str, Any]:
    if templates and 0 <= ord_value < len(templates) and isinstance(templates[ord_value], dict):
        return templates[ord_value]
    if templates and isinstance(templates[0], dict):
        return templates[0]
    return {}


def _card_state(card: Any, fallback: Dict[str, Any]) -> Dict[str, Any]:
    due = getattr(card, "due", fallback.get("due"))
    queue = getattr(card, "queue", None)
    if queue is None:
        return fallback
    if queue < 0:
        state = "Suspended"
    elif queue == 0:
        state = "New"
    elif queue in (1, 3):
        state = "Learning"
    else:
        state = "Review"
    return {"due": due, "state": state, "suspended": queue < 0}


def _rendered_card_html(card: Optional[Any], side: str) -> str:
    if card is None:
        return ""
    renderer = getattr(card, "question", None) if side == "front" else getattr(card, "answer", None)
    if not callable(renderer):
        return ""
    try:
        return str(renderer() or "")
    except Exception:
        return ""


def _note_to_card(note: Any, card: Optional[Any], ord_value: int, fallback_state: Dict[str, Any]) -> Dict[str, Any]:
    model = note.note_type()
    templates = model.get("tmpls") or []
    template = _template_for_ord(templates, ord_value)
    field_names = list(note.keys())
    state = _card_state(card, fallback_state) if card is not None else fallback_state
    fields = {name: str(note[name]) for name in field_names}
    return {
        "id": f"anki-{note.id}-{ord_value}",
        "ankiNoteId": int(note.id),
        "type": model.get("name", "Basic"),
        "modelName": model.get("name", "Basic"),
        "fieldOrder": field_names,
        "fields": fields,
        "tags": list(note.tags),
        "due": state["due"],
        "state": state["state"],
        "suspended": state["suspended"],
        "mediaRefs": media_refs_from_fields(fields),
        "modifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(getattr(note, "mod", time.time()))),
        "modifiedBy": "Anki",
        "sourceDeckName": active_local_deck(),
        "sourceDeckPath": active_local_deck(),
        "templateFront": str(template.get("qfmt") or ""),
        "templateBack": str(template.get("afmt") or ""),
        "modelCss": str(model.get("css") or ""),
        "renderedFront": _rendered_card_html(card, "front"),
        "renderedBack": _rendered_card_html(card, "back"),
        "clozeOrd": ord_value,
    }


def note_to_cards(note: Any) -> List[Dict[str, Any]]:
    fallback_state = note_state(note)
    cards = list(note.cards())
    if not cards:
        return [_note_to_card(note, None, 0, fallback_state)]
    return [_note_to_card(note, card, _card_ord(card, index), fallback_state) for index, card in enumerate(cards)]


def note_to_card(note: Any) -> Dict[str, Any]:
    return note_to_cards(note)[0]


def collect_cards() -> List[Dict[str, Any]]:
    note_ids = mw.col.find_notes(note_query())
    cards: List[Dict[str, Any]] = []
    for note_id in note_ids:
        cards.extend(note_to_cards(mw.col.get_note(note_id)))
    return cards


def sync_payload(
    *,
    dry_run: bool = False,
    cards: Optional[List[Dict[str, Any]]] = None,
    batch: Optional[Dict[str, Any]] = None,
    media: Optional[Dict[str, Dict[str, str]]] = None,
) -> Dict[str, Any]:
    cfg = config()
    deck_name = active_local_deck()
    payload = {
        "cards": [compress_large_card_fields(card) for card in (collect_cards() if cards is None else cards)],
        "deckName": deck_name,
        "deckPath": deck_name,
        "dryRun": dry_run,
        "allowCreate": True,
        "conflictPolicy": cfg.get("conflict_policy", "detect"),
        "returnState": False,
        "source": ADDON_NAME,
        "client": {
            "name": ADDON_NAME,
            "version": ADDON_VERSION,
            "fingerprint": socket.gethostname(),
        },
    }
    payload["media"] = collect_media_payload(payload["cards"]) if media is None else media
    if batch:
        payload["batch"] = batch
    return payload


def _payload_size(payload: Dict[str, Any]) -> int:
    return len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))


def _configured_batch_size(cfg: Dict[str, Any]) -> int:
    try:
        return max(1, int(cfg.get("batch_size") or DEFAULT_CONFIG["batch_size"]))
    except Exception:
        return DEFAULT_CONFIG["batch_size"]


def sync_payload_chunks(
    cards: List[Dict[str, Any]],
    *,
    dry_run: bool,
    cfg: Dict[str, Any],
    media: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    if not cards:
        raise RuntimeError("No Anki notes matched the selected deck/filter.")

    max_cards = _configured_batch_size(cfg)
    media = media if media is not None else collect_media_payload(
        cards,
        cfg=cfg,
        deck_id=str(cfg.get("deck_id", "") or "").strip(),
        dry_run=dry_run,
    )

    def media_for(chunk: List[Dict[str, Any]]) -> Dict[str, Dict[str, str]]:
        refs = {ref for card in chunk for ref in (card.get("mediaRefs") or [])}
        return {filename: asset for filename, asset in media.items() if filename in refs}

    chunks: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    for card in cards:
        trial = current + [card]
        trial_payload = sync_payload(dry_run=dry_run, cards=trial, media=media_for(trial))
        if current and (len(trial) > max_cards or _payload_size(trial_payload) > MAX_SYNC_REQUEST_BYTES):
            chunks.append(current)
            current = [card]
            single_payload = sync_payload(dry_run=dry_run, cards=current, media=media_for(current))
            if _payload_size(single_payload) > MAX_SYNC_REQUEST_BYTES:
                raise RuntimeError(
                    "A single Anki note is too large for DeckBridge's hosted API. "
                    "Shorten very large fields or exclude that note with a tag filter."
                )
            continue
        if not current and _payload_size(trial_payload) > MAX_SYNC_REQUEST_BYTES:
            raise RuntimeError(
                "A single Anki note is too large for DeckBridge's hosted API. "
                "Shorten very large fields or exclude that note with a tag filter."
            )
        current = trial
    if current:
        chunks.append(current)

    if len(chunks) == 1:
        return [sync_payload(dry_run=dry_run, cards=chunks[0], media=media_for(chunks[0]))]

    batch_id = f"{int(time.time())}-{safe_tag(socket.gethostname())}-{len(cards)}"
    return [
        sync_payload(
            dry_run=dry_run,
            cards=chunk,
            media=media_for(chunk),
            batch={
                "id": batch_id,
                "index": index,
                "total": len(chunks),
                "totalCards": len(cards),
            },
        )
        for index, chunk in enumerate(chunks)
    ]


def combine_sync_responses(responses: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not responses:
        return {"result": {"stats": {"total": 0, "created": 0, "updated": 0, "skipped": 0, "conflicts": 0, "dryRun": False}, "conflicts": []}}
    combined = dict(responses[-1])
    stats = {"total": 0, "created": 0, "updated": 0, "skipped": 0, "conflicts": 0, "dryRun": False}
    conflicts: List[Dict[str, Any]] = []
    for response in responses:
        result = response.get("result", {})
        response_stats = result.get("stats", {})
        for key in ("total", "created", "updated", "skipped", "conflicts"):
            stats[key] += int(response_stats.get(key, 0) or 0)
        stats["dryRun"] = bool(response_stats.get("dryRun", stats["dryRun"]))
        conflicts.extend(result.get("conflicts", []) or [])
    result = dict(combined.get("result", {}))
    result["stats"] = stats
    result["conflicts"] = conflicts
    combined["result"] = result
    if "deck" in responses[0]:
        deck = dict(responses[0].get("deck", {}))
        deck["cardCount"] = stats["total"]
        combined["deck"] = deck
    return combined


def _visible_deck_ids(me: Dict[str, Any]) -> set[str]:
    return {str(deck.get("id")) for deck in me.get("decks", []) if deck.get("id")}


def create_platform_deck_from_anki(cfg: Optional[Dict[str, Any]] = None, cards: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    cfg = cfg or config()
    source_cards = cards or collect_cards()
    payloads = sync_payload_chunks(source_cards, dry_run=False, cfg=cfg)
    created = request_json(
        "POST",
        "/api/decks/sync/from-anki",
        payloads[0],
        cfg=cfg,
        timeout_floor=MIN_SYNC_TIMEOUT_SECONDS,
    )
    new_deck_id = str((created.get("deck") or {}).get("id") or created.get("state", {}).get("activeDeckId") or "").strip()
    if not new_deck_id:
        raise RuntimeError("DeckBridge created a deck but did not return its deck ID.")
    next_config = {**cfg, "deck_id": new_deck_id, "local_deck": active_local_deck()}
    save_config(next_config)
    responses = [created]
    for payload in payloads[1:]:
        responses.append(request_json(
            "POST",
            f"/api/decks/{new_deck_id}/sync/cards",
            payload,
            cfg=next_config,
            timeout_floor=MIN_SYNC_TIMEOUT_SECONDS,
        ))
    large_media = collect_media_payload(
        source_cards,
        cfg=next_config,
        deck_id=new_deck_id,
        dry_run=False,
        upload_large=True,
        include_inline=False,
    )
    if large_media:
        for payload in sync_payload_chunks(source_cards, dry_run=False, cfg=next_config, media=large_media):
            request_json(
                "POST",
                f"/api/decks/{new_deck_id}/sync/cards",
                payload,
                cfg=next_config,
                timeout_floor=MIN_SYNC_TIMEOUT_SECONDS,
            )
    return combine_sync_responses(responses)


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
    cards = collect_cards()
    if not dry_run:
        me = validate_token(cfg)
        if not deck_id or deck_id not in _visible_deck_ids(me):
            return create_platform_deck_from_anki(cfg, cards)
    elif not deck_id:
        raise RuntimeError(protocol_recovery_message(detail="No DeckBridge deck mapping is configured."))
    responses = [
        request_json(
            "POST",
            f"/api/decks/{cfg['deck_id']}/sync/cards",
            payload,
            timeout_floor=MIN_SYNC_TIMEOUT_SECONDS,
        )
        for payload in sync_payload_chunks(cards, dry_run=dry_run, cfg=cfg)
    ]
    return combine_sync_responses(responses)


def _parse_due_date(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        due = datetime.fromisoformat(text)
        return due if due.tzinfo else due.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _scheduler_today() -> int:
    try:
        return int(getattr(mw.col.sched, "today", 0) or 0)
    except Exception:
        return 0


def _due_offset_days(next_due: Any) -> int:
    due = _parse_due_date(next_due)
    if due is None:
        return 0
    now = datetime.now(timezone.utc)
    return max(0, int((due.date() - now.date()).days))


def _update_card(card: Any) -> None:
    if hasattr(mw.col, "update_card"):
        mw.col.update_card(card)
        return
    if hasattr(card, "flush"):
        card.flush()


def apply_scheduling_update(update: Dict[str, Any]) -> str:
    note = find_tracked_note({"id": update.get("cardId"), "ankiNoteId": update.get("ankiNoteId")})
    if note is None:
        return "skipped"
    interval = max(1, int(float(update.get("intervalDays") or 1)))
    ease = max(1300, int(float(update.get("easeFactor") or 2.5) * 1000))
    repetitions = max(0, int(update.get("repetitions") or 0))
    due = _scheduler_today() + _due_offset_days(update.get("nextDue"))
    changed = 0
    for card in note.cards():
        if getattr(card, "queue", 0) < 0:
            continue
        card.ivl = interval
        card.factor = ease
        card.reps = max(int(getattr(card, "reps", 0) or 0), repetitions)
        card.due = due
        card.queue = 2
        card.type = 2
        _update_card(card)
        changed += 1
    return "updated" if changed else "skipped"


def pull_scheduling_from_platform() -> Dict[str, int]:
    cfg = config()
    deck_id = str(cfg.get("deck_id", "") or "").strip()
    if not deck_id:
        return {"updated": 0, "skipped": 0}
    response = request_json("GET", f"/api/decks/{deck_id}/sync/scheduling", cfg=cfg)
    stats = {"updated": 0, "skipped": 0}
    for update in response.get("updates", []) or []:
        action = apply_scheduling_update(update)
        stats[action] = stats.get(action, 0) + 1
    if stats["updated"]:
        mw.col.save()
        mw.reset()
    return stats


def sync_scheduling_if_enabled() -> Dict[str, int]:
    if not config().get("pull_scheduling_on_sync", True):
        return {"updated": 0, "skipped": 0}
    return pull_scheduling_from_platform()


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
    scheduling = payload.get("scheduling")
    if scheduling:
        message += f"\nSRS scheduling updated: {scheduling.get('updated', 0)}"
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
    def task() -> None:
        pushed = post_cards(dry_run=False)
        pushed["scheduling"] = sync_scheduling_if_enabled()
        show_result("Anki deck synced to DeckBridge.", pushed)

    run_guarded("Push", task)


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
        scheduling = sync_scheduling_if_enabled()
        pulled = pull_from_platform()
        showInfo(
            "Bidirectional sync complete.\n\n"
            f"Platform push updated {pushed.get('result', {}).get('stats', {}).get('updated', 0)} card(s).\n"
            f"SRS scheduling updated {scheduling['updated']} Anki card(s).\n"
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
        self.pull_scheduling_on_sync = QCheckBox()
        self.pull_scheduling_on_sync.setChecked(bool(cfg["pull_scheduling_on_sync"]))
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
        sync_form.addRow("Pull web SRS scheduling on sync", self.pull_scheduling_on_sync)
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
            "pull_scheduling_on_sync": self.pull_scheduling_on_sync.isChecked(),
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
