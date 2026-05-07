# Guided Setup Into Deck Workbench Design

## Purpose

Improve DeckBridge for a small study group owner by making the first successful session clear and confidence-building: connect Anki, prove the bridge can sync, then land in a useful browser-based deck workbench.

This spec focuses on the first improvement pass across:

- A: painless Anki onboarding and sync proof.
- B: immediate post-sync utility through card browsing, editing, study entry, and owner review cues.

Platform discovery, marketplace behavior, advanced analytics, custom roles, and broad collaboration expansion are out of scope for this pass.

## Target User

The primary user is the owner of a small study group deck. They are responsible for importing or syncing the deck, keeping Anki and DeckBridge aligned, reviewing collaborator changes, and making the deck useful for the group.

The design should optimize for this owner completing one successful session:

1. Open DeckBridge.
2. Connect or confirm the Anki bridge.
3. Map a local Anki deck to a DeckBridge deck.
4. Run a dry-run or first sync.
5. See proof of what happened.
6. Continue into the deck workbench.

## Product Shape

DeckBridge should feel like a guided owner workspace rather than a set of disconnected tabs. The main path is:

1. Workspace home.
2. Guided setup wizard when Anki is not fully connected.
3. Verified sync result.
4. Deck workbench as the normal post-setup landing surface.

The app should always answer the owner's next-action question:

- Does Anki still need setup?
- Is the add-on package available?
- Is the credential created and tested?
- Is a local deck mapped to this DeckBridge deck?
- Has the first dry-run or sync succeeded?
- Are there conflicts to resolve?
- Are there suggestions to review?
- Is the deck ready to browse, edit, study, share, or export?

## Component Design

### Setup Wizard

`ConnectAnkiWizard` remains the owner-facing setup flow, but it should behave like a state machine with completion evidence at each step.

The wizard has four core stages:

1. Download: show add-on package/version availability and a direct download action.
2. Authorize: create and validate a DeckBridge add-on credential.
3. Map: select the DeckBridge target deck, enter or select the local Anki deck, and choose conflict policy.
4. Prove sync: run a dry-run or first sync and show the result.

Manual token copy remains available as a fallback, but the primary path should be autoconfig or guided connection. The wizard should not end with "now go figure it out in Anki"; it should end with a verifiable result from the bridge workflow.

### Sync Health Strip

After setup, the Deck Workbench shows a compact sync health strip. It is always visible but should not dominate the page.

The strip shows:

- Add-on package/version status.
- Current mapped DeckBridge deck.
- Local Anki deck name when known.
- Last checked and last synced time.
- Conflict count.
- One primary next action.

Supported states:

- Not connected.
- Ready to test.
- Dry-run passed.
- Sync healthy.
- Conflicts need review.
- Package missing.
- Token failed.
- API unavailable.

### Deck Workbench

The Deck Workbench is the default post-setup surface. It should combine existing useful surfaces into one coherent owner workspace:

- Searchable, filterable, paginated card list.
- Selected card preview.
- Quick edit or suggestion flow.
- Study launch for approved cards.
- Pending suggestion queue entry point.
- Conflict resolution entry point.
- Export and share actions where appropriate.

The workbench should make the card and owner attention states feel connected. A user should not need to guess whether cards, suggestions, conflicts, study, and sync are separate products.

### Owner Attention Panel

The workbench should include a compact owner attention area, either as a right-side panel on desktop or a top summary block on smaller screens.

It lists priority actions:

- Pending suggestions.
- Unresolved sync conflicts.
- Cards changed in the last sync.
- Deck visibility/share status.
- Study readiness.
- Sync action needed.

This panel is not a second dashboard. It is a short queue of owner decisions.

### Empty and Verification States

Every major state should provide a useful next action:

- No deck yet: import, create, or connect from Anki.
- No sync yet: open guided setup.
- Package missing: build or redeploy add-on package.
- Token invalid: generate a new connection credential.
- No mapped local deck: choose or enter one.
- No conflicts: show healthy sync status.
- No pending suggestions: show review queue is clear.
- No studyable cards: explain whether approval, import, or sync is needed.

## Data Flow

The design should extend the current architecture rather than introduce a parallel path.

- React owns the setup and workbench UI.
- Express exposes setup, token, add-on, sync, and deck APIs.
- The repository abstraction continues to support local development and Supabase production.
- Supabase remains the production persistence layer.
- The Anki add-on remains the local bridge that pushes card snapshots to DeckBridge.

The first-sync proof should flow through the existing sync contract:

`POST /api/decks/:deckId/sync/cards`

The result should include enough information for the wizard, sync strip, and owner attention panel:

- Total cards scanned.
- Cards created.
- Cards updated.
- Conflicts detected.
- Whether this was a dry-run.
- Sync timestamp.
- Client/source metadata.

## Error Handling

Errors should be grouped by what the owner can do next:

- Package missing: build or redeploy the add-on package.
- Token invalid: generate a new connection credential.
- Anki not configured: open add-on settings or use autoconfig.
- Local deck missing: reselect the local deck mapping.
- Sync conflict: review differences before overwriting.
- API unavailable: retry when DeckBridge is reachable.
- Supabase unavailable: show that hosted persistence is unavailable and avoid pretending the sync succeeded.

Errors should be short, specific, and tied to recovery actions. Long explanations belong in secondary details.

## Testing Strategy

The implementation plan should include targeted coverage for the owner path:

- API tests for token creation, add-on version/download behavior, and sync result contracts.
- Unit tests for setup state derivation and next-action selection.
- Add-on tests for config storage, autoconfig handling, dry-run behavior, and token validation.
- Playwright coverage from connect wizard through first sync proof into the deck workbench.
- Build verification with `npm test`, `npm run test:api`, and `npm run build`.

## Scope Boundaries

In scope:

- Improve the guided setup path.
- Add first-sync proof.
- Promote the Deck Workbench as the post-setup landing surface.
- Add compact sync health and owner attention cues.
- Improve empty, error, and verification states for A+B flows.

Out of scope:

- Public deck marketplace expansion.
- Custom organization roles.
- Advanced analytics dashboards.
- Email notification systems.
- Large dependency additions or a new UI framework.
- Replacing the existing repository abstraction.

## Open Implementation Notes

- Keep `conflictPolicy: "detect"` as the safe default.
- Reuse existing API, repository, add-on, and UI patterns before adding new abstractions.
- If `src/App.tsx` remains the integration point, extract only the pieces needed to keep the setup/workbench work understandable and testable.
- The wizard and workbench should share derived setup/sync state so the user sees continuity after leaving setup.
