# DeckBridge Sync Anki Add-on

DeckBridge Sync turns Anki into the local bridge for DeckBridge. It can push the current Anki deck to DeckBridge, pull approved DeckBridge cards into Anki, preview syncs, record conflicts, and run optional timed syncs.

## Configure

In Anki, open `Tools > DeckBridge Sync > Settings`.

- `Platform URL`: the DeckBridge API origin, normally `https://anki-collab.vercel.app`. Use a local URL such as `http://localhost:4175` only when running DeckBridge locally.
- `Email` and `Password`: click `Log in to DeckBridge` to create and save an add-on token from your DeckBridge account.
- `API token`: a DeckBridge add-on token. This is filled automatically after login, or can still be pasted manually.
- `DeckBridge deck ID`: optional on first setup. If blank, the first push creates a DeckBridge workspace from the selected Anki deck and saves the returned deck ID.
- `Local Anki deck`: optional. Pick an Anki deck from the local deck list or leave empty to use the currently selected deck.
- `Conflict policy`: `detect` records conflicts without overwriting DeckBridge cards. `overwrite-platform` updates DeckBridge from Anki.

Connection settings are stored in Anki's collection config under `deckbridge` as `url`, `token`, `email`, `deckMappings`, and `autoSync` values. Passwords are never stored. Existing add-on config is still read as a migration fallback.

The DeckBridge Connect Anki wizard can also open an auto-config link while Anki is running:

`anki://deckbridge?url={platformUrl}&token={token}&deckId={deckId}&localDeck={localDeck}&conflictPolicy={conflictPolicy}`

The add-on validates the token against `/api/me` before saving. If the URL scheme fails or validation is rejected, use Settings to paste the same values manually.
If the link omits `localDeck`, the mapping is saved with a blank local deck and Settings opens so you can pick a deck from Anki's local deck list.

## Features

- One-click token validation against `/api/me`, including the signed-in user and visible DeckBridge decks.
- Login from Anki via `/api/anki/login`, which returns a normal DeckBridge `db_` token for future syncs.
- First push can create a DeckBridge deck from the selected local Anki deck via `/api/decks/sync/from-anki`.
- Push current Anki notes to `/api/decks/:deckId/sync/cards` after the deck exists.
- Pull DeckBridge cards into Anki with missing-note creation.
- Bidirectional sync: push first, then pull only if conflicts are clear.
- Dry-run preview before changing the platform.
- Conflict-safe default mode.
- Optional tag filter, suspended-card inclusion, batch sizing, timeouts, and automatic sync interval.
- DeckBridge tracking tags on pulled notes so future pulls update the same notes.

The add-on uses only Anki's bundled Python and Qt APIs.
