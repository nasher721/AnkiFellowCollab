# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DeckBridge** is an Anki deck collaboration workspace. Users import `.apkg` files, browse cards in a React web app, submit suggested edits, triage suggestions as the deck owner, and export approved decks. It supports both a local-only development mode and a full production stack on Vercel + Supabase.

## Commands

```bash
# Install dependencies
npm install

# Development (starts both Vite on :5174 and Express API on :4175 concurrently)
npm run dev

# Run unit tests (Node built-in test runner against server/*.test.mjs)
npm test

# Run API integration tests (supertest against server/*.api.test.mjs)
npm run test:api

# Run a single test file
node --test server/domain.test.mjs

# Run E2E tests (Playwright; requires no server running — it starts one)
npm run test:e2e

# Production build (TypeScript check + Vite bundle)
npm run build

# Production server
npm start

# Package the Anki add-on → dist/deckbridge-sync.ankiaddon
npm run package:anki-addon

# Migrate local .deckbridge/state.json to Supabase
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run migrate:state
```

## Architecture

### Dual-repository pattern

The server selects a repository implementation at startup based on environment variables (`server/repositories/index.mjs`):

- **Local repository** (`server/repositories/localRepository.mjs`): Reads/writes a single JSON file at `.deckbridge/state.json`. Seeded automatically from `domain.mjs:createSeedState()` on first run. Used for local dev and tests — no external services required.
- **Supabase repository** (`server/repositories/supabaseRepository.mjs`): Uses Supabase Postgres. Activated when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set, or when `DECKBRIDGE_REPOSITORY=supabase`.

Tests always run against the local repository. The repository interface is the contract both implementations share.

### Auth modes

`server/auth.mjs` supports two modes:

- **Production** (Supabase present + `NODE_ENV=production`): Validates Bearer tokens — first checks for a `db_`-prefixed API token in the `api_tokens` table, then falls back to Supabase JWTs.
- **Development** (no Supabase): Accepts `x-deckbridge-user-id`, `x-deckbridge-user-email`, `x-deckbridge-user-name` headers, defaulting to a hardcoded dev user (`dylan.smith@example.com`). Never requires authentication.

### RBAC

`server/rbac.mjs` exports middleware (`requireOwner`, `requireEditor`, `requireReviewer`, `requireContributor`) that gate routes by deck membership role. Roles from least to most privileged: `viewer → contributor → reviewer → editor → owner`. When Supabase is absent (local mode), all RBAC middleware passes through without enforcement.

### Domain logic

All business logic lives in `server/domain.mjs`:

- `normalizeParsedDeck` / `normalizeSuggestionInput` / `normalizeAddonSyncInput` — input validation and normalization
- `mergeAddonCards` — conflict-aware card merge with `detect` (no overwrite) vs `overwrite-platform` policies
- `applySuggestion` — applies an accepted suggestion's field/tag changes to the card in place
- `summarizeDeck` — computes card count, tag count, pending suggestions for list views
- `createSeedState` — generates the demo dataset used in local dev

### Express server

`server/app.mjs` wires up all routes and exports `createApp(options)`. The entry point `server/index.mjs` calls it. For Vercel, `api/index.mjs` re-exports the same app as a serverless function.

Key route groups:
- `GET /api/me`, `GET /api/decks`, `GET /api/decks/:id` — read workspace state
- `POST /api/decks/upload` — multer file upload → `parseApkg` → normalize → save; uploader becomes owner
- `POST /api/decks/:id/suggestions` — creates a suggestion (contributor+)
- `POST /api/suggestions/:id/decision` — accept/reject/revision (owner/editor)
- `POST /api/decks/:id/export` — generates/signs an export file
- `POST /api/decks/:id/sync/cards` — Anki add-on push endpoint; runs `mergeAddonCards`
- `POST /api/decks/:id/sync/conflicts` — records conflicts detected by the local add-on
- `GET /api/decks/:deckId/cards` — cursor-based card pagination
- `POST /api/decks/:deckId/cards/:cardId/versions` — create card version
- `POST /api/decks/:deckId/cards/:cardId/rollback` — rollback to version
- `POST /api/decks/:deckId/cards/similar` — semantic similarity search
- Legacy `GET|POST /api/anki/*` — proxies to AnkiConnect at `http://localhost:8765` for local dev

### Frontend

React 19 SPA built with Vite. Key source files:

| File | Purpose |
|---|---|
| `src/App.tsx` | Root component; holds all app state, routing between views |
| `src/api.ts` | Typed fetch wrapper; sets Bearer token from Supabase session |
| `src/types.ts` | All shared TypeScript types (Deck, Card, Suggestion, etc.) |
| `src/sm2.ts` | Client-side SM-2 spaced-repetition; progress stored in `localStorage` and synced to server |
| `src/useRealtime.ts` | Supabase Realtime hook; subscribes to `suggestions`, `comments`, and `cards` table changes for a deck |

Views: `StudyView`, `CardEditor`, `DiscoverView`, `AnalyticsDashboard`, `TemplateGallery`, `ConflictResolution`, `SuggestionDiscussion`, `ConnectAnkiWizard`, `ActivityTimeline`, `NotificationsBell`.

Hooks:
- `useDeckOperations` — deck operations hook
- `useReviewQueue` — review queue hook
- `useSyncState` — sync state hook

The Vite dev server proxies `/api` and `/downloads` to `http://localhost:4175`.

### Supabase schema

Two migrations define the schema:

- `20260506210000_collaboration.sql` — core tables: `profiles`, `decks`, `deck_members`, `suggestions`, `comments`, `reactions`, `notifications`; RLS policies; expanded membership roles (`owner`, `editor`, `reviewer`, `contributor`, `viewer`)
- `20260506220000_platform.sql` — platform features: deck `visibility`, `fork_of`, `download_count`; `deck_stars`, `templates`, `study_progress` tables

### Anki add-on

Lives in `addons/deckbridge_sync/`. The add-on calls DeckBridge's API (not AnkiConnect) using a user API token. It pushes note snapshots and receives conflict reports back. The hosted server never initiates connections to `localhost:8765`. The conflict policy (`detect` vs `overwrite-platform`) is configured in the add-on settings.

## Environment Variables

Copy `.env.example` and fill in values for production. For local dev, no `.env` is needed.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (server-side) |
| `SUPABASE_ANON_KEY` | Supabase anon key (server-side) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side auth + RBAC) |
| `VITE_SUPABASE_URL` | Supabase URL exposed to the frontend build |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key exposed to the frontend build |
| `SUPABASE_EXPORTS_BUCKET` | Storage bucket name for exported `.apkg` files |
| `DECKBRIDGE_REPOSITORY` | `supabase`, `local`, or `auto` (default) |
| `DECKBRIDGE_DATA_DIR` | Override path for local JSON store (default: `.deckbridge/`) |

## Testing Notes

- Unit tests (`npm test`) use Node's built-in `node:test` runner — no Jest or Vitest.
- API tests (`npm run test:api`) use `supertest` against the Express app directly, with `DECKBRIDGE_REPOSITORY=local` implicitly (no Supabase env vars set in test environment).
- E2E tests (`npm run test:e2e`) spin up the full dev server with a fresh temp directory (`mktemp`) and empty Supabase vars to force local mode.
- To run a single test file: `node --test server/<filename>.test.mjs`
