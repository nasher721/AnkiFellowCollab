# DeckBridge Sync Anki Add-on

DeckBridge Sync turns Anki into the local bridge for DeckBridge. It can push the current Anki deck to DeckBridge, pull approved DeckBridge cards into Anki, preview syncs, record conflicts, and run optional timed syncs.

## Configure

In Anki, open `Tools > DeckBridge Sync > Settings`.

- `Platform URL`: the DeckBridge API origin, for example `https://your-app.vercel.app` or `http://localhost:4175`.
- `API token`: a Supabase access token in production. Leave empty for local development.
- `DeckBridge deck ID`: the platform deck ID to sync.
- `Local Anki deck`: optional. Leave empty to use the currently selected deck.
- `Conflict policy`: `detect` records conflicts without overwriting DeckBridge cards. `overwrite-platform` updates DeckBridge from Anki.

## Features

- One-click connection test against `/api/me`.
- Push current Anki notes to `/api/decks/:deckId/sync/cards`.
- Pull DeckBridge cards into Anki with missing-note creation.
- Bidirectional sync: push first, then pull only if conflicts are clear.
- Dry-run preview before changing the platform.
- Conflict-safe default mode.
- Optional tag filter, suspended-card inclusion, batch sizing, timeouts, and automatic sync interval.
- DeckBridge tracking tags on pulled notes so future pulls update the same notes.

The add-on uses only Anki's bundled Python and Qt APIs.
