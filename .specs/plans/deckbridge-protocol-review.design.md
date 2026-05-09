# DeckBridge Protocol And Review Upgrade Design

## Purpose

DeckBridge should become a clearer, more dependable collaborative deck protocol while improving the owner review workflow that sits on top of that protocol. The product direction is a balanced upgrade: tighten the AnkiHub-inspired sync surface and make suggestions, conflicts, AI assist, media state, and accepted changes feel like one owner loop.

This design uses AnkiHub's public behavior as a useful reference, not as a private API clone target. DeckBridge should expose its own stable, documented contract for add-on clients, web workflows, and future integrations.

## Current Context

DeckBridge already has the foundations this design needs:

- Add-on authentication through `/api/me`, `/api/tokens`, and `/api/anki/login`.
- Add-on deck creation and card sync through `/api/decks/sync/from-anki` and `/api/decks/:deckId/sync/cards`.
- Subscription and delta-style surfaces through `/api/decks/subscriptions` and `/api/decks/:deckId/updates`.
- Media upload targets through `/api/decks/:deckId/media/uploads`.
- Two-way scheduling pullback through `/api/decks/:deckId/sync/scheduling`.
- Suggestion review, bulk decisions, comments, spreadsheet import, and owner-only template editing.
- Optional AI owner assist for review briefs, conflict summaries, diagnostics, quality pulse, and related-card search.
- Anki-template-aware rendering and OpenAPI documentation.

The next step is not to add a separate subsystem. It is to make the protocol and review flow explicit, documented, tested, and visible in the Deck Workbench.

## Design Direction

The chosen direction is **balanced protocol plus review**.

DeckBridge should define a collaborative deck protocol around identity, subscriptions, delta updates, media upload targets, add-on pushes, scheduling pullback, and suggestion diffs. The protocol should remain DeckBridge-native: versioned, documented, camelCase, RFC 7807 for errors, and compatible with existing add-on behavior.

The review layer should sit on the same spine. A local Anki push, a web edit, a spreadsheet row change, a contributor suggestion, and an AI-assisted review brief should all connect to the same owner decision loop. The owner should be able to answer four questions from the workbench:

1. What changed?
2. What needs my decision?
3. What will sync back to Anki?
4. Is the protocol healthy enough to trust this sync?

## Alternatives Considered

### Recommended: DeckBridge Protocol Mode

Probability: `0.89`

Make the existing sync and review endpoints behave like a stable collaborative deck protocol. This gives the add-on, web app, and future clients one contract without overfitting to AnkiHub's private API.

### Owner Review Inbox Upgrade

Probability: `0.85`

Turn suggestions, conflicts, AI briefs, comments, and bulk decisions into one owner triage queue. This is valuable, but it should ride on a clearer protocol contract rather than become a separate dashboard.

### Add-on Sync Reliability Dashboard

Probability: `0.82`

Deepen startup/manual sync visibility with last pull, last push, token health, media state, retry guidance, and specific network error wording. This remains part of the balanced design through the protocol health strip.

### Private API Compatibility Facade

Probability: `0.07`

Add flat aliases like `/api/login/`, `/api/decks/{uuid}/updates`, and `/api/decks/generate-presigned-url`. This could help experiments, but it risks confusing DeckBridge's cleaner public contract and chasing a private upstream.

### AI Study Assistant Parity

Probability: `0.05`

Add `/api/ai/chat` and smart search as premium-style features. Useful later, but less foundational than protocol reliability and owner review quality.

### Full Event-Sourced Sync Ledger

Probability: `0.04`

Store every mutation as an append-only event stream. This is powerful, but too heavy until DeckBridge has clear audit or merge-history pressure.

## Architecture

The backend should keep the current Express `createApp()` shape and repository abstraction. Protocol work belongs at route boundaries, domain helpers, repository methods, and OpenAPI examples. Supabase remains the production persistence layer; local repository behavior remains the development fallback.

The add-on remains the local bridge. It validates credentials, maps a local Anki deck to a DeckBridge deck, pushes card batches, uploads large media through signed targets, pulls scheduling updates, and eventually consumes delta updates. It should stay conservative: push in safe chunks, preserve card content, and avoid overwriting when conflict state is unclear.

The frontend should keep the Deck Workbench as the main owner surface. Protocol health, review queue, unresolved conflicts, recent accepted changes, media state, AI owner assist artifacts, and sync proof should appear as one workflow. This should not become a separate analytics page or an implementation-details dashboard.

The OpenAPI spec is part of the product. It should describe the real sync and review contracts with request and response examples, including error examples that match runtime behavior.

## Protocol Data Flow

The add-on starts by validating identity against `/api/me`. It receives the signed-in user, memberships, and visible decks. The user maps a DeckBridge deck to a local Anki deck and stores the `db_` token locally.

`/api/decks/subscriptions` becomes the startup snapshot for add-on clients. It should return each accessible deck with role, deck metadata, last sync timestamp, pending review count, unresolved conflict count, and protocol capability flags. This lets clients decide whether to push, pull, warn, or guide setup.

Local changes push upward through `/api/decks/:deckId/sync/cards`. The request can include card batches, compressed fields, media refs, client metadata, conflict policy, dry-run mode, and `returnState: false` for large decks. The response records sync proof: total scanned, created, updated, skipped, conflicts, media received, dry-run flag, batch state, client version, and timestamp.

Collaborative changes normalize into suggestion diffs. Web edits, spreadsheet imports, and future add-on-originated collaborator edits should produce the same reviewable unit: target card or note, proposed fields, proposed tags, optional media refs, optional template changes, reason, source metadata, and discussion state.

Owner decisions make changes canonical. Accepting a suggestion applies the diff, records activity, updates suggestion status, and marks related AI artifacts stale or resolved. Rejection and revision preserve history without changing canonical cards.

Delta updates pull downward through `/api/decks/:deckId/updates?since=...`. The response should include changed canonical cards, deleted or hidden cards, media refs, template changes, scheduling changes, sync proof metadata, and suggestion status updates since the timestamp.

## Workbench Experience

The Deck Workbench should expose the protocol loop without making the owner read protocol details.

The sync protocol strip shows add-on package status, mapped DeckBridge deck, local Anki deck name, last checked time, last successful sync time, conflict count, and one primary next action. Its states should include not connected, ready to test, dry-run passed, sync healthy, conflicts need review, package missing, token failed, and API unavailable.

The owner review queue should combine pending suggestions, unresolved conflicts, AI review briefs, stale quality findings, and recent accepted or rejected changes. Each item should show the source, affected card, risk, decision action, and whether it will affect the next add-on pull.

The card list and preview should remain the owner's context surface. Selecting a review item should open the affected card with rendered front/back, field-level diff, tags, media refs, comments, and AI assist when enabled.

The workbench should make empty states concrete. No sync yet should open setup. No pending suggestions should show the review queue is clear. Conflicts should block unsafe push actions. Media upload problems should tell the owner whether cards or media need retry.

## Error Handling

DeckBridge should keep RFC 7807 Problem Details as the backend error contract. Every protocol-facing error should include a stable code, human-readable detail, and bounded details object.

The add-on should translate these errors into Anki-friendly recovery messages. Invalid token means reconnect. Missing deck mapping means choose a local deck. Timeout means retry with smaller batches or wait longer. Media target failure means retry media upload before card sync. Conflict detection means review before overwrite. SSL, proxy, VPN, and antivirus failures should receive specific wording because those failures are common in desktop Anki environments.

The frontend should use the same error codes for inline recovery actions. The workbench should never claim sync success when Supabase, media storage, token validation, or add-on communication failed.

## Testing Strategy

Backend API tests should lock the protocol contract:

- `/api/decks/subscriptions` returns deck metadata, role, capability flags, pending review count, conflict count, and last sync state.
- `/api/decks/:deckId/updates?since=...` returns only changes after the cursor timestamp and handles malformed timestamps.
- `/api/decks/:deckId/sync/cards` records sync proof, honors dry-run, handles `returnState: false`, preserves large compressed fields, and reports conflicts.
- `/api/decks/:deckId/media/uploads` validates files and returns storage metadata.
- Suggestion creation, import, decision, and bulk decision all normalize into the same diff model.
- Error responses use RFC 7807 and stable codes.

Add-on Python tests should cover token validation, mapped-deck storage, chunked pushes, compressed oversized fields, media target use, timeout wording, scheduling pull, and delta-update parsing.

Frontend tests should cover protocol strip state derivation, owner queue derivation, review item selection, bulk decisions, conflict blocking, and error recovery actions.

Playwright should smoke the owner path: setup proof, sync state visible, suggestion created, owner decision applied, and accepted change visible in the workbench.

The standard verification gate should remain:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 addons/deckbridge_sync/tests/test_addon.py
npm test
npm run build
npm run package:anki-addon
npm run test:e2e
```

## Scope Boundaries

In scope:

- Tighten and document existing protocol endpoints.
- Add concrete OpenAPI examples for sync, subscriptions, updates, media, suggestions, and errors.
- Improve the Deck Workbench protocol health and owner review experience.
- Normalize suggestion diffs across web edits, CSV imports, and future client-originated edits.
- Improve add-on recovery wording for protocol failures.

Out of scope:

- Cloning AnkiHub's private flat API.
- Adding a broad AI chat assistant.
- Replacing the repository abstraction.
- Introducing a new event-sourced storage model.
- Adding new dependencies without a separate decision.

## Implementation Notes

Keep `conflictPolicy: "detect"` as the safe default. Preserve full card content through sync; transport compression should decode at the API boundary before storage or review. Reuse existing AI owner assist as optional review support, not as a required sync path. Treat OpenAPI, tests, and add-on behavior as the source of truth for the protocol contract.

This design should become a staged implementation plan before code changes begin.
