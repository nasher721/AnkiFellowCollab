from __future__ import annotations

import json
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
ADDON_VERSION = "0.2.0"
TRACKING_MODEL = "DeckBridge Sync"
TRACKING_TAG_PREFIX = "deckbridge_card_"

DEFAULT_CONFIG: Dict[str, Any] = {
    "platform_url": "http://localhost:4175",
    "api_token": "",
    "deck_id": "deck-demo-zanki",
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

_timer: Optional[QTimer] = None
_sync_running = False


def config() -> Dict[str, Any]:
    stored = mw.addonManager.getConfig(__name__) or {}
    return {**DEFAULT_CONFIG, **stored}


def save_config(next_config: Dict[str, Any]) -> None:
    mw.addonManager.writeConfig(__name__, {**DEFAULT_CONFIG, **next_config})
    configure_timer()


def apply_autoconfig(url_string: str) -> bool:
    """
    Parse an anki://deckbridge?url=...&token=...&deckId=... URL and apply it
    as the add-on config. Returns True if the config was applied, False on error.
    Called from the URL scheme handler registered below.
    """
    try:
        parsed = urllib.parse.urlparse(url_string)
        if parsed.scheme != "anki" or parsed.netloc != "deckbridge":
            return False
        params = urllib.parse.parse_qs(parsed.query)
        platform = params.get("url", [""])[0].strip()
        token = params.get("token", [""])[0].strip()
        deck_id = params.get("deckId", [""])[0].strip()
        if not platform or not token:
            return False
        next_config = config()
        next_config["platform_url"] = platform
        next_config["api_token"] = token
        if deck_id:
            next_config["deck_id"] = deck_id
        save_config(next_config)
        return True
    except Exception:
        return False


def platform_url(cfg: Dict[str, Any], path: str) -> str:
    return f"{str(cfg['platform_url']).rstrip('/')}{path}"


def request_json(method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = config()
    body = json.dumps(payload or {}).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if cfg.get("api_token"):
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
    return {
        "cards": collect_cards(),
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


def post_cards(*, dry_run: bool = False) -> Dict[str, Any]:
    cfg = config()
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
        me = request_json("GET", "/api/me")
        decks = request_json("GET", "/api/decks")
        showInfo(
            f"Connected as {me.get('user', {}).get('name', 'DeckBridge user')}.\n"
            f"Visible decks: {len(decks.get('decks', []))}",
            title=ADDON_NAME,
        )

    run_guarded("Connection test", task)


def preview_push() -> None:
    run_guarded("Preview", lambda: show_result("Dry-run push preview complete.", post_cards(dry_run=True)))


def push_to_platform() -> None:
    run_guarded("Push", lambda: show_result("Anki cards pushed to DeckBridge.", post_cards(dry_run=False)))


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

        self.api_token = QLineEdit(str(cfg["api_token"]))
        self.api_token.setEchoMode(QLineEdit.EchoMode.Password)
        self.api_token.setPlaceholderText("db_…  (generate in DeckBridge → Connect Anki)")

        self.deck_id = QLineEdit(str(cfg["deck_id"]))
        self.deck_id.setPlaceholderText("deck-id from DeckBridge")

        self.local_deck = QLineEdit(str(cfg["local_deck"]))
        self.local_deck.setPlaceholderText("My Anki Deck (leave blank to use active deck)")

        test_btn = QPushButton("Test connection")
        test_btn.clicked.connect(self._test_connection)

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

        conn_form = QFormLayout()
        conn_form.addRow(setup_label)
        conn_form.addRow("Platform URL", self.platform_url)
        conn_form.addRow("API token", self.api_token)
        conn_form.addRow("DeckBridge deck ID", self.deck_id)
        conn_form.addRow("Local Anki deck", self.local_deck)
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
            mw.addonManager.writeConfig(__name__, {**DEFAULT_CONFIG, **self.values()})
            me = request_json("GET", "/api/me")
            decks = request_json("GET", "/api/decks")
            showInfo(
                f"Connected as {me.get('user', {}).get('name', 'DeckBridge user')}.\n"
                f"Visible decks: {len(decks.get('decks', []))}",
                title=ADDON_NAME,
            )
        except Exception as error:
            showInfo(str(error), title=f"{ADDON_NAME}: Connection failed")
        finally:
            mw.addonManager.writeConfig(__name__, original)

    def values(self) -> Dict[str, Any]:
        return {
            "platform_url": self.platform_url.text().strip(),
            "api_token": self.api_token.text().strip(),
            "deck_id": self.deck_id.text().strip(),
            "local_deck": self.local_deck.text().strip(),
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
        save_config(dialog.values())
        tooltip("DeckBridge Sync settings saved")


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
        ("Push Anki deck to DeckBridge", push_to_platform),
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
            "DeckBridge Sync configured successfully!\n\n"
            "Platform URL and token have been saved. "
            "Use Tools → DeckBridge Sync → Test connection to verify.",
            title=ADDON_NAME,
        )
    else:
        showInfo(
            "Could not apply auto-config link. Please configure manually via Settings.",
            title=ADDON_NAME,
        )


# Register URL scheme if supported by this Anki version
try:
    from aqt import addons
    if hasattr(addons, "AddonManager") and hasattr(mw.addonManager, "registerUrlHandler"):
        mw.addonManager.registerUrlHandler("deckbridge", _handle_url_scheme)
except Exception:
    pass
