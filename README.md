# DeckBridge

DeckBridge is an Anki deck collaboration workspace. It lets a study group import an `.apkg`, browse cards in a web app, submit suggested edits, let the deck owner triage those suggestions, record local-bridge Anki conflicts, and export the approved deck.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:5174/`.

The API bridge runs on `http://localhost:4175/` and stores local MVP data in `.deckbridge/`.

## Production mode

DeckBridge now has a shared-web production path for Vercel + Supabase:

1. Link a Supabase project with `supabase link --project-ref <project-ref>`.
2. Apply the database and private export bucket migration with `supabase db push`.
3. Set production environment variables:

```bash
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_EXPORTS_BUCKET=deckbridge-exports
SUPABASE_MEDIA_BUCKET=deckbridge-media
DECKBRIDGE_REPOSITORY=supabase
```

4. Build and start the app:

```bash
npm run build
npm start
```

When Supabase variables are present, the server uses Supabase Auth plus deck membership roles. Without those variables, development uses the local JSON repository so tests and local demos remain deterministic.

To migrate existing local `.deckbridge/state.json` data into Supabase:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run migrate:state
```

## API

- `GET /api/me` returns the current user and deck memberships.
- `GET /api/decks` returns decks visible to the current user.
- `GET /api/decks/:deckId` returns a deck-scoped workspace state.
- `POST /api/decks/upload` imports an `.apkg`; the uploader becomes owner.
- `POST /api/decks/:deckId/suggestions` creates a suggestion for editors/owners.
- `POST /api/suggestions/:id/decision` accepts/rejects/requests revision for owners.
- `POST /api/decks/:deckId/export` returns a signed/local download descriptor.
- `POST /api/decks/:deckId/sync/conflicts` records conflicts found by a per-user local bridge.
- `POST /api/decks/:deckId/sync/cards` lets the Anki add-on push local note snapshots into DeckBridge with either conflict detection or platform overwrite mode.
- `POST /api/decks/:deckId/media/uploads` creates signed upload URLs for large Anki media files; the add-on uploads bytes to storage and sends small media metadata through the card sync API.

## Anki Integration

DeckBridge production sync uses the bundled per-user Anki add-on as a local bridge. The hosted server never calls a user's `localhost:8765`; the add-on calls DeckBridge with the user's authenticated API token and reports note snapshots plus conflicts. Upload and export work without AnkiConnect.

In local development, the legacy `/api/anki/*` routes still call AnkiConnect at `http://localhost:8765` for compatibility.

The add-on lives in `addons/deckbridge_sync` and provides:

- Settings for platform URL, token, deck ID, local deck, conflict policy, timeouts, tag filtering, missing-note creation, and optional auto-sync.
- Test connection, dry-run preview, push to DeckBridge, pull from DeckBridge, and bidirectional sync menu actions inside Anki.
- Conflict-safe default behavior via `conflictPolicy: "detect"`; users can opt into `overwrite-platform` when they want Anki to win.
- DeckBridge tracking tags on pulled notes so future pulls update the same Anki notes.

Package it for installation with:

```bash
npm run package:anki-addon
```

The generated file is `dist/deckbridge-sync.ankiaddon`.

The platform also uses:

- `parse-deck <deck.apkg>` for import.
- `create-deck <deck.json> <deck.apkg>` for export.
- AnkiConnect `findNotes`, `notesInfo`, `updateNoteFields`, and `addTags` for local Anki sync.

## Verify

```bash
npm test
npm run test:api
npm run build
```

The included tests cover deck normalization, owner-approved suggestions, dashboard summaries, export JSON generation, authenticated route access, membership enforcement, upload/export routing, and conflict recording.

`npm run test:e2e` runs the Playwright smoke test against a running dev server.
