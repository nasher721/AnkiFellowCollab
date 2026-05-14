# DeckBridge Next-Level Improvements

## Type
feature

## Description

Transform DeckBridge from a solid Anki collaboration workspace into a next-level collaborative learning platform by implementing: real-time multiplayer editing, card version control with rollback, cursor pagination for large decks, App.tsx decomposition, real-time card subscriptions, semantic duplicate detection with pgvector, and mobile PWA support.

## Problem Statement

The critique identified several critical gaps preventing DeckBridge from being "next-level":

1. **Collaboration is async-only** - No real-time multiplayer editing; suggestions require owner review before any change
2. **No version control** - Cards mutate in-place with no history/rollback capability
3. **Scaling bottleneck** - Full-deck in-memory loads don't paginate; frontend re-renders entire app on any state change
4. **Monolithic frontend** - App.tsx is 1,706 lines with 50+ state variables

## In Scope

- Real-time presence and collaborative editing infrastructure
- Card version history with rollback capability
- Cursor pagination for deck card loading
- App.tsx decomposition into domain-specific hooks
- Real-time postgres_changes subscription for cards table
- pgvector integration for semantic duplicate detection
- Request cancellation with AbortController

## Out of Scope

- CRDT-based field-level conflict resolution (future)
- Cross-deck knowledge graph (future)
- Mobile PWA offline mode (future)
- Deck marketplace with monetization (future)
- FSRS scheduler support (future)

## Business Value

| Feature | Value Driver |
|---|---|
| **Cursor Pagination** | Enables decks with 50K+ cards without browser crash. Users study large decks immediately rather than waiting for full load. Eliminates mobile tab crashes on large imports. |
| **Card Version History** | Builds trust: owners can undo mistakes in one click. Provides full audit trail for teams sharing decks. Encourages experimentation — if a change goes wrong, rollback is instant. |
| **App.tsx Decomposition** | Unblocks parallel feature development. New contributors understand the codebase in hours instead of days. Isolated hooks are independently testable, reducing regression risk. |
| **Real-time Card Updates** | Eliminates manual refresh. Users on the same deck see edits appear instantly. Essential foundation for future collaborative editing features. |
| **pgvector Integration** | Proactively prevents card duplication (the #1 quality issue in large decks). Enables future features: smart review recommendations, AI-powered card clustering, and spaced repetition optimization. |
| **AbortController Integration** | Eliminates state-update-on-unmounted-component warnings. Users navigating quickly between decks get a snappy, professional UX without stale-state bugs or memory leaks. |

## Acceptance Criteria

### 1. Cursor Pagination

**API Contract:**
- `GET /api/decks/:id/cards?cursor=<base64-encoded-token>&limit=<1-500>` returns `{ cards: Card[], nextCursor: string | null }`
- `limit` defaults to 200, maximum 500
- `nextCursor` is `null` when there are no more pages
- Response includes stable ordering by `created_at ASC, id ASC` (compound cursor ensures sort stability during concurrent inserts)

**Performance:**
- P95 response time < 200ms for a page of 500 cards on a deck with 50K cards (with db indexes on `(deck_id, created_at, id)`)
- P99 response time < 500ms under same conditions

**Frontend:**
- `<CardVirtualList>` renders only visible rows + 2 buffer rows above/below viewport
- Pre-fetch triggers when scroll position is within 200px of the bottom of the loaded content
- Consecutive rapid scrolls coalesce into a single fetch (debounce 150ms)
- No duplicate cards or gaps during rapid scroll

**Testable verification:**
- Integration test: fetch page 1, confirm `nextCursor` is non-null; fetch with that cursor, confirm no overlap with page 1 cards; fetch past end, confirm `nextCursor` is null
- E2E test: load deck with 1,500 cards, scroll to bottom, confirm all 1,500 cards rendered
- Load test: 50 requests/second for 60 seconds to pagination endpoint, confirm no regression in response times

### 2. Card Version History

**Data Model:**
- `deck_card_versions` table: `id UUID PK`, `card_id UUID FK`, `snapshot JSONB` (full card fields + tags), `created_at TIMESTAMPTZ`, `created_by UUID FK`
- Every accepted suggestion creates a version snapshot *before* applying the suggestion
- Manual snapshots can be created via API for ad-hoc checkpointing

**API:**
- `POST /api/decks/:id/cards/:cardId/versions` → `{ version: { id, cardId, snapshot, createdAt } }`
- `GET /api/decks/:id/cards/:cardId/versions` → `{ versions: Array<{ id, createdAt, createdBy }> }` (returns metadata only, not full snapshots)
- `GET /api/decks/:id/cards/:cardId/versions/:versionId` → `{ version: { id, snapshot } }` (returns full snapshot for preview/restore)
- `POST /api/decks/:id/cards/:cardId/rollback?version=<versionId>` → `{ card: Card, priorVersion: { id } }` — restores card fields+tags from snapshot, creates a new version of the pre-rollback state for undo protection

**Authorization:**
- Rollback restricted to `owner` and `editor` roles (enforced via `requireEditor` RBAC middleware)
- Version read access available to all deck members with `contributor` role or above

**Performance:**
- Rollback completes in < 500ms P95 for a single card
- Version creation (full snapshot) completes in < 100ms P95

**Testable verification:**
- Unit test: accept a suggestion, confirm a version row exists with correct snapshot
- Unit test: rollback to version N, confirm card fields match version N snapshot, and a new version (N+1) records the pre-rollback state
- Unit test: non-editor user receives 403 on rollback endpoint
- API test: GET versions list returns metadata-only (no snapshot payload); GET single version returns full snapshot

### 3. App.tsx Decomposition

**Hook Contracts:**
- `useDeckOperations` exports: `{ decks, activeDeck, loadDecks, loadDeck, uploadDeck, deleteDeck, exportDeck, isPending, error, resetError }`
- `useReviewQueue` exports: `{ cards, currentIndex, currentCard, nextCard, prevCard, rateCard (rating: 1-4), resetQueue, isEmpty, isExhausted, totalCount }`
- `useSyncState` exports: `{ syncStatus: 'idle' | 'syncing' | 'error', lastSyncedAt: string | null, pushChanges, pullChanges, conflictCount, pendingChanges, resetSync }`

**File Structure:**
- Each hook lives in its own file: `src/hooks/useDeckOperations.ts`, `src/hooks/useReviewQueue.ts`, `src/hooks/useSyncState.ts`
- Shared types and utilities extracted to `src/hooks/common.ts` if needed
- Each hook has a corresponding test file: `src/hooks/useDeckOperations.test.ts`, etc.

**Metrics:**
- `App.tsx` line count reduced from 1,706 to < 600 lines
- All existing unit tests pass without modification
- New hook tests achieve > 80% branch coverage

**Testable verification:**
- Run `npm test` — all existing tests pass
- `App.tsx` character count verified via `wc -l src/App.tsx` < 600
- Each hook file exists at expected path

### 4. Real-time Card Updates

**Subscription Contract:**
- `useRealtime(deckId)` subscribes to Supabase `postgres_changes` on `cards` table with filter `deck_id=eq.<deckId>`
- Channel name convention: `deck-cards-{deckId}` (must be unique per subscription)
- Handles three event types:
  - `INSERT` → appends new card to the local list
  - `UPDATE` → replaces card in-place (only if incoming `updated_at` >= local `updated_at` to prevent stale overwrites)
  - `DELETE` → removes card from local list (by `id`)
- Subscription is cleaned up on unmount via `useEffect` return callback calling `.unsubscribe()`

**Reliability:**
- Automatic reconnection on connection drop (Supabase Realtime default behavior, no custom wiring needed)
- Failed subscriptions retry up to 3 times with exponential backoff (1s, 2s, 4s)
- Events that arrive during reconnection gap are not replayed (acceptable: on mount, full list is fetched)

**Performance:**
- Event processing latency < 100ms (time from Supabase receipt to React state update)
- No duplicate renders when multiple events batch-fire

**Testable verification:**
- API integration test: insert card via API, verify subscription callback fires within 200ms
- Unit test: subscribe with deckId filter, emit mock INSERT event matching deckId, confirm callback receives it; emit mock event with different deckId, confirm callback does not fire
- Unit test: cleanup callback unsubscribes channel

### 5. pgvector Integration

**Schema:**
- Migration adds `embedding vector(1536)` column to `cards` table (OpenAI `text-embedding-ada-002` dimension)
- `ivfflat` index created: `CREATE INDEX idx_cards_embedding ON cards USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)` — suitable for decks up to ~100K cards
- Embeddings are nullable; cards without embeddings are excluded from similarity search

**API:**
- `POST /api/decks/:id/cards/similar`
  - Request: `{ cardId: string, topK: number (1-20, default 5), threshold: number (0.0-1.0, default 0.7) }`
  - Response: `{ similar: Array<{ card: Card, score: number }> }` — sorted by cosine similarity descending
  - `score` is cosine similarity (0 = orthogonal, 1 = identical); results with score < threshold are excluded

**Embedding Generation:**
- Embeddings generated server-side via 9Router OpenAI-compatible endpoint using `text-embedding-ada-002`
- Generation is triggered:
  - On card creation (synchronous, < 500ms added to create latency)
  - On card content update (asynchronous, fire-and-forget)
  - Manually via batch endpoint `POST /api/decks/:id/cards/embed` (for backfilling)

**Performance:**
- P95 API response time < 500ms for similarity search on deck with 10K embedded cards
- P95 embedding generation < 300ms per card

**Testable verification:**
- Run migration, confirm `embedding` column exists with `vector(1536)` type
- API test: create card, confirm embedding is non-null after creation
- API test: search similar cards, confirm returned cards have `score >= threshold` and are sorted descending
- API test: card with null embedding returns empty similarity results

### 6. Request Cancellation

**API Layer:**
- `api.ts` exports: `type ApiRequest<T> = { promise: Promise<T>; cancel: () => void }`
- `api.ts` exports: `function createCancellableFetch<T>(url: string, options?: RequestInit): ApiRequest<T>`
- All existing API wrapper functions (`api.get`, `api.post`, `api.put`, `api.del`) accept optional `AbortSignal` parameter and return `Promise<T>` (backward-compatible)
- A new `api.cancellableGet`, `api.cancellablePost`, etc. variant returns `ApiRequest<T>` where needed

**Frontend Integration:**
- Every `useEffect` that calls an API or sets state includes `let cancelled = false` or uses `useRef(true)` for `isMounted`
- Before any `setState` call: `if (!cancelled) { setState(...) }`
- `AbortError` (`error.name === 'AbortError'`) is caught silently — not surfaced to user as error notification
- No "Can't perform a React state update on an unmounted component" warnings in browser console

**Endpoints Covered:**
- All API calls in `src/api.ts` are covered: deck CRUD, card CRUD, suggestion CRUD, export, sync, user profile, search

**Testable verification:**
- Unit test: create cancellable fetch, call `.cancel()`, confirm promise rejects with `AbortError`
- Unit test: check that original fetch request's `signal.aborted` is `true`
- E2E test: navigate between two large decks rapidly, confirm no stutter, no console warnings, no orphaned requests in Network tab

### 7. No Memory Leaks

**Quantitative Thresholds:**
- JS heap memory < 200MB during and after loading a deck with 50,000 cards (measured via `performance.memory.usedJSHeapSize` in Chrome)
- No browser "unresponsive script" warning after 10 seconds of continuous interaction (scroll, filter, sort) within a 50K card deck
- Chrome DevTools Performance recording shows zero detached DOM node after navigating away from a 50K card deck back to dashboard

**Verification Method:**
- Memory snapshot comparison: take heap snapshot on dashboard (baseline), load 50K deck, take snapshot, navigate back to dashboard, take snapshot. Baseline and final snapshots should differ by < 10MB.
- All `AbortController` instances created during a deck view are garbage collected within 5 seconds of navigating away
- All Supabase Realtime channels are in `closed` state after navigating away (check via `supabase.getChannels()`)

**Testable verification:**
- Integration test: create 50K cards via bulk API, load deck page, confirm page renders within 5 seconds
- Memory benchmark: run `node --experimental-vm-modules server/memory-benchmark.mjs` (new file) which loads 50K cards and reports heap usage
- CI check: heap delta threshold enforced as non-blocking warning

## User Scenarios

1. **Large Deck Study**: User with 50,000 cards loads their deck; cards paginate in smoothly
2. **Collaborative Editing**: Two users view same card; they see each other's presence
3. **Rollback Mistake**: Owner accepts wrong suggestion; reverts to previous version in 1 click
4. **Duplicate Detection**: AI suggests "Card X is similar to Card Y in your deck"
5. **Navigation Cancel**: User navigates away during 50K load; no memory leak

## Definition of Done

- [ ] Cards endpoint supports cursor pagination
- [ ] Frontend virtual scroll loads cards on demand
- [ ] deck_card_versions table created with migration
- [ ] Rollback API endpoint functional
- [ ] App.tsx state extracted into useDeckOperations hook
- [ ] App.tsx state extracted into useReviewQueue hook
- [ ] App.tsx state extracted into useSyncState hook
- [ ] useRealtime.ts subscribes to cards table
- [ ] pgvector migration created
- [ ] api.ts wraps fetch in AbortController
- [ ] Memory leak test passes with 50K cards

---

## Implementation Process

### Step 0: Setup — Prerequisites, Dependencies, and Conventions

**Sub-tasks:**
- Create `server/pagination.mjs` — shared `encodeCursor(card)`, `decodeCursor(token)` helpers (base64url JSON compound cursor on `(created_at, id)`)
- Create `src/hooks/common.ts` — shared types (`DeckOpsState`, `ReviewQueueState`, `SyncState`), debounce utility moved out of App.tsx
- Add `@supabase/realtime-js` dependency if not already bundled via `@supabase/supabase-js` (check `package.json`)
- Verify `CREATE EXTENSION IF NOT EXISTS vector` is available in Supabase project
- Create migration template pattern file at `supabase/migrations/README.md` documenting naming convention (`YYYYMMDDHHMMSS_description.sql`)
- Add `CardVersion` and `CursorPage<T>` types to `src/types.ts`

**Success Criteria:**
- `server/pagination.mjs` exports `encodeCursor`/`decodeCursor` — verified by unit test: encode then decode round-trips identically
- `src/hooks/common.ts` exports shared types — verified by `tsc --noEmit`
- Existing tests pass: `npm test` and `npm run test:api`

**Blockers:** None (no dependencies on other steps)

**Risks & Mitigations:**
- Cursor encoding change would break paginated clients → use `base64url` JSON with schema version field (`v: 1`)
- Shared type extraction might cause import cycles → keep types minimal, no runtime imports

**Effort:** Small

---

### Step 1: Cursor Pagination API — Backend Card Loading

**Sub-tasks:**
- **`server/app.mjs`**: Add `GET /api/decks/:deckId/cards` route with `cursor` and `limit` query params, returning `{ cards: Card[], nextCursor: string | null }` — ordered by `created_at ASC, id ASC`; use `parsePaginationParams`
- **`server/repositories/localRepository.mjs`**: Add `listCardsCursor(deckId, { cursor, limit })` — sorts deck cards by `(created_at, id)`, finds cursor offset, slices `limit+1` for has-more check
- **`server/repositories/supabaseRepository.mjs`**: Add `listCardsCursor(deckId, { cursor, limit })` — queries `cards` table with `WHERE (created_at, id) > ($1, $2)` compound comparison, ordered, limited
- **`server/domain.mjs`**: Add `compoundCursorEncode(card)` / `compoundCursorDecode(token)` or import from `pagination.mjs`
- Create `supabase/migrations/20260513120000_cards_cursor_index.sql` — composite index `CREATE INDEX CONCURRENTLY idx_cards_deck_created_id ON cards(deck_id, created_at, id)`
- **`server/routes.api.test.mjs`**: Add API test for cursor pagination flow (page 1 → nextCursor, page 2 → no overlap, page past end → null)

**Success Criteria:**
- `GET /api/decks/:deckId/cards?limit=3` returns `{ cards: [...], nextCursor: "..." }` — non-null cursor when more cards exist
- Second call with that cursor returns next page with no overlap
- Cursor with no more results returns `nextCursor: null`
- P95 response time < 200ms for 500-card page on 50K card deck (verified via `autocannon` or similar)
- API tests pass: `npm run test:api`

**Blockers:** Step 0 (pagination.mjs helpers must exist)

**Risks & Mitigations:**
- Compound cursor misalignment on timestamp collision → include `id` in cursor, never emit duplicate IDs
- Supabase `or()` query for compound cursor can be slow → benchmark; fallback to `created_at > $1 OR (created_at = $1 AND id > $2)` raw SQL with `rpc()`

**Effort:** Medium

---

### Step 2: Card Version History with Rollback

**Sub-tasks:**
- Create `supabase/migrations/20260513130000_card_version_history.sql`:
  ```sql
  CREATE TABLE deck_card_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    deck_id UUID NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES profiles(id)
  );
  CREATE INDEX idx_card_versions_card_id ON deck_card_versions(card_id, created_at DESC);
  ```
- **`server/repositories/localRepository.mjs`**: Add `listCardVersions`, `getCardVersion`, `createCardVersion`, `rollbackCardToVersion` methods
- **`server/repositories/supabaseRepository.mjs`**: Add matching Supabase methods
- **`server/domain.mjs`**: Add `snapshotCard(card)` — returns JSON-serializable snapshot of `{ fields, tags, modelName, modifiedAt }`
- **`server/app.mjs`**: Add 4 routes:
  - `POST /api/decks/:deckId/cards/:cardId/versions`
  - `GET /api/decks/:deckId/cards/:cardId/versions`
  - `GET /api/decks/:deckId/cards/:cardId/versions/:versionId`
  - `POST /api/decks/:deckId/cards/:cardId/rollback?version=<versionId>` — requires `requireEditor` middleware
- **`server/app.mjs`**: Integrate auto-versioning into `decideSuggestion` — before `applySuggestion`, call `createCardVersion` to snapshot pre-apply state
- **`server/routes.api.test.mjs`**: Add tests for version lifecycle and rollback
- **`server/domain.test.mjs`**: Add unit test for `snapshotCard` and rollback logic

**Success Criteria:**
- Accepting a suggestion auto-creates a version snapshot with correct fields
- Rollback to version N restores card fields + tags, creates undo version N+1
- Non-editor receives 403 on rollback endpoint
- Version list endpoint returns metadata only (no snapshot body)
- Unit tests pass: `npm test`; API tests pass: `npm run test:api`

**Blockers:** Step 0 (migration conventions and types)

**Risks & Mitigations:**
- Version snapshot could be stale if card mutated between snapshot and rollback → snapshot `modifiedAt`; on rollback, reject if card was modified after snapshot
- Large snapshots bloat DB → snapshot only `{ fields, tags, modelName }`; omit `mediaRefs, renderedFront, renderedBack, clozeOrd`

**Effort:** Large

---

### Step 3: pgvector Integration for Semantic Duplicate Detection

**Sub-tasks:**
- Create `supabase/migrations/20260513140000_pgvector_embeddings.sql`:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE cards ADD COLUMN IF NOT EXISTS embedding vector(1536);
  CREATE INDEX CONCURRENTLY idx_cards_embedding ON cards USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  ```
- **`server/app.mjs`**: Add `POST /api/decks/:deckId/cards/similar` route:
  - Accepts `{ cardId, topK (1-20), threshold (0-1) }`
  - Finds the source card's embedding (generate if missing)
  - Queries the repository for similar cards
  - Returns `{ similar: Array<{ card: Card, score: number }> }`
- **`server/repositories/supabaseRepository.mjs`**: Add `findSimilarCards(deckId, sourceCardId, embedding, { topK, threshold })` — runs the vector similarity query
- **`server/repositories/localRepository.mjs`**: Add `findSimilarCards` — iterate in-memory embeddings, compute `cosineSimilarity` (already in `domain.mjs`), sort, filter, slice
- **`server/app.mjs`**: Integrate embedding generation:
  - On card creation (synchronous, after insert): call `aiGateway.embed(cardText)` and store
  - On card content update (fire-and-forget): mark embedding as `stale`
  - Backfill endpoint already exists at `POST /api/decks/:deckId/ai/cards/embed`
- **`server/routes.api.test.mjs`**: Add API tests for similar cards endpoint
- **`server/domain.test.mjs`**: Add unit test for `cosineSimilarity`

**Success Criteria:**
- Migration runs: `embedding vector(1536)` column exists on `cards` table
- Creating a card generates a non-null embedding
- `POST /api/decks/:deckId/cards/similar` returns cards with `score >= threshold` sorted descending
- Card with null embedding returns empty results
- P95 response < 500ms for similarity search on 10K embedded cards
- API tests pass: `npm run test:api`

**Blockers:** Step 0 (migration conventions); 9Router/AI gateway must be configured for embeddings

**Risks & Mitigations:**
- `ivfflat` with `lists=100` is tuned for ~100K cards — if decks grow larger → increase `lists` or migrate to `hnsw` index
- Embedding generation adds latency to card creation → generate synchronously but limit to cards with `< 10K chars`; larger cards get async backfill
- 9Router OpenAI-compatible endpoint may rate-limit → batch API has 200ms delay between calls; embed failures are non-fatal

**Effort:** Large

---

### Step 4: App.tsx Decomposition into Domain Hooks

**Sub-tasks:**
- **`src/hooks/useDeckOperations.ts`** — Extract deck + card + suggestion state (25 variables) into `DeckOpsState`:
  - `state`, `selectedCardId`, `selectedSuggestionId`, `selectedOwnerQueueItemId`, `selectedSuggestionIds`, `commentsVersion`
  - `queryInput`, `tagFilter`, `cardStateFilter`, `draftReason`, `toasts`, `authNotice`, `busy`
  - `page`, `pageSize`, `apiHealth`, `deckLoading`, `qualityPulse`, `duplicateLinks`
  - `duplicateBusy`, `embeddingBusy`, `conflictReviewSnapshot`, `deckVisibility`, `copiedShare`, `addonPackage`
  - Exports: `{ state, loadDecks, loadDeck, uploadDeck, deleteDeck, exportDeck, ... }`
- **`src/hooks/useReviewQueue.ts`** — Extract review/suggestion triage state:
  - `reviewTab`, `reviewRiskFilter`, `reviewStatusFilter`, `reviewAuthorFilter`
  - `sourceCheckByReviewItem`, `suggestionBriefs`, `briefBusy`
  - Exports: `{ cards, currentIndex, currentCard, nextCard, prevCard, rateCard, ... }`
- **`src/hooks/useSyncState.ts`** — Extract sync/anatomy state:
  - `showConnectWizard`, `editingCardId`, `selectedCardIds`, `bulkAction`, `bulkTagInput`
  - `activeTab`, `showStudy`, `studyApprovedOnly`, `topView`, `darkMode`, `copiedShare`
  - Exports: `{ syncStatus, lastSyncedAt, pushChanges, pullChanges, conflictCount, ... }`
- **`src/App.tsx`**: Replace extracted state/callbacks with hook calls; wire hook outputs to component props
- Create test files: `src/hooks/useDeckOperations.test.ts`, `src/hooks/useReviewQueue.test.ts`, `src/hooks/useSyncState.test.ts`
- Extract `useDebounce` to `src/hooks/common.ts`

**Success Criteria:**
- `App.tsx` line count reduced from 3,499 to < 600 lines
- Each hook file exists at `src/hooks/useDeckOperations.ts`, `src/hooks/useReviewQueue.ts`, `src/hooks/useSyncState.ts`
- `npm test` — all existing tests pass without modification
- New hook tests achieve > 80% branch coverage
- App renders identically: no visual regression on dashboard, deck view, study mode

**Blockers:** Step 0 (shared types in `common.ts` must exist)

**Risks & Mitigations:**
- Regression from extracting state incorrectly → extract one hook at a time; run `npm run build` (tsc) after each hook extraction
- Circular dependencies if hooks import each other → hooks are independent; `useReviewQueue` takes cards as input, not imported from `useDeckOperations`

**Effort:** Large

---

### Step 5: Request Cancellation with AbortController

**Sub-tasks:**
- **`src/api.ts`**: Add exports:
  ```typescript
  export type ApiRequest<T> = { promise: Promise<T>; cancel: () => void };
  export function createCancellableFetch<T>(url: string, options?: RequestInit): ApiRequest<T>;
  ```
  - `createCancellableFetch` creates an `AbortController`, passes `signal` to `fetch`, returns `{ promise, cancel }`
- **`src/api.ts`**: Refactor `jsonRequest` to accept optional `AbortSignal` via `options.signal`
- **`src/api.ts`**: Add convenience wrappers `api.cancellableGet`, `api.cancellablePost` returning `ApiRequest<T>`
- **`src/App.tsx`**: In every `useEffect` that calls API or sets state:
  - Create `const controller = new AbortController()` at top
  - Pass `controller.signal` to API calls
  - Return `() => controller.abort()` from `useEffect` cleanup
- **`src/hooks/*.ts`**: Same pattern — each hook's load/refresh function accepts or creates `AbortSignal`
- Add guard: `if (signal.aborted) return` before `setState` calls
- Catch `AbortError` silently: `if (error.name === 'AbortError') return`
- Add `src/api.test.ts`: Unit test creating cancellable fetch, calling `.cancel()`, confirming `AbortError`

**Success Criteria:**
- No "Can't perform a React state update on an unmounted component" warnings in browser console
- `.cancel()` on `ApiRequest` causes promise to reject with `AbortError` and `signal.aborted === true`
- Rapid navigation between decks produces no orphaned requests
- All existing tests pass: `npm test`, `npm run test:api`

**Blockers:** None (independent of other steps, but ideally after Step 4 to avoid dual-refactoring App.tsx)

**Risks & Mitigations:**
- Aborting a fetch that already completed is a no-op — safe
- `.catch(() => {})` swallows legitimate errors → differentiate `AbortError` by name; rethrow others
- Retrofit touches every API consumer → start with `api.ts` type changes (backward compatible), then add guards to App.tsx and hooks

**Effort:** Medium

---

### Step 6: Real-time Card Updates via Postgres Changes

**Sub-tasks:**
- **`src/useRealtime.ts`**: Add `postgres_changes` subscription on `cards` table:
  ```typescript
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'cards', filter: `deck_id=eq.${deckId}` },
    (payload) => { onCardChange(payload); }
  )
  ```
- **`src/useRealtime.ts`**: Extend `RealtimeOptions` interface:
  - Add `onCardChange?: (payload) => void`
  - Channel name convention: `deck-cards-{deckId}`
  - Handle three event types:
    - `INSERT` → call `onCardInsert(card)`
    - `UPDATE` → replace if `incoming.updated_at >= local.updated_at`
    - `DELETE` → remove by `id`
- **`src/useRealtime.ts`**: Add retry logic: on subscription error, retry 3x with 1s, 2s, 4s backoff
- **`src/App.tsx`**: Wire `onCardChange` callback:
  - On INSERT/UPDATE/DELETE → dispatch to local card list state
  - Channel cleanup on `deckId` change (existing `useEffect` return handles this)
- **Migration**: `ALTER PUBLICATION supabase_realtime ADD TABLE cards;` (add to Step 0 migration template or a new migration)
- **`src/useRealtime.test.ts`**: Add unit test:
  - Subscribe with deck ID → INSERT callback fires
  - INSERT for different deck ID → callback does NOT fire
  - Cleanup → channel unsubscribed

**Success Criteria:**
- Inserting a card via API triggers callback within 200ms
- Updating a card replaces local state only if `updated_at >= local.updated_at`
- Deleting a card removes it from local list
- Navigating away from deck unsubscribes channel
- Unit tests pass: `npm test`

**Blockers:** Step 4 (App.tsx decomposition — needs clean hook boundaries to wire card changes)

**Risks & Mitigations:**
- Supabase Realtime requires replication on `cards` → add to migration
- Race between fetched data and subscription event → always re-fetch on mount; subscription is incremental
- Local repository has no DB-level timestamps → always accept incoming

**Effort:** Medium

---

### Step 7: Card Virtual List with Cursor Pagination UI

**Sub-tasks:**
- **`src/CardVirtualList.tsx`**: New component:
  - Props: `{ deckId: string; initialCards: Card[]; onCardSelect: (cardId: string) => void; selectedCardId?: string }`
  - Renders only visible rows + 2 buffer rows (windowed rendering via IntersectionObserver)
  - Pre-fetch trigger: scroll within 200px of loaded content bottom
  - Debounce rapid scrolls at 150ms → coalesce into single fetch
  - Uses `api.cancellableGet` (from Step 5) for each page fetch
  - Maintains ordered card list via cursor pagination, dedup by `card.id`
  - Loading skeleton for in-flight pages
- **`src/App.tsx`**: Replace full card list rendering with `<CardVirtualList>`
- **`src/types.ts`**: Add `CursorPage<T>` type
- **`src/api.ts`**: Add `api.cards.list(deckId, { cursor?, limit? })` returning `CursorPage<Card>`

**Success Criteria:**
- Deck with 1,500 cards: scroll to bottom, all cards rendered
- No duplicate cards or gaps during rapid scroll
- JS heap < 200MB during/after loading 50K cards
- E2E test passes: `npm run test:e2e`

**Blockers:** Step 1 (pagination API must exist); Step 5 (AbortController for cancellation)

**Risks & Mitigations:**
- Card height calculation for virtual scroll → use fixed row height (60px) with CSS
- IntersectionObserver in React 19 can cause stale closure → use refs for callbacks

**Effort:** Large

---

### Step 8: Integration, Polish, Edge Cases, and Benchmarks

**Sub-tasks:**
- **Integration tests** (`server/routes.api.test.mjs`):
  - Cursor pagination: page 1 → nextCursor; page 2 → no overlap; page past end → null
  - Version history: create version → list includes it; rollback → card matches snapshot
  - pgvector: create card → embedding non-null; search similar → sorted by score
  - Auth: non-editor on rollback → 403; non-contributor on version read → 403
- **Memory benchmark** (`server/memory-benchmark.mjs`):
  - Creates 50K cards via bulk API, loads deck, measures `performance.memory.usedJSHeapSize`
  - Reports heap delta; CI-enforced as non-blocking warning
- **Edge cases:**
  - Empty deck cursor pagination → empty array, null cursor
  - Rollback invalid versionId → 404
  - Similar cards no embeddings → empty results
  - AbortController called after unmount → no-op
  - Concurrent real-time INSERT while scrolling → card at correct position
  - Multiple rapid pagination fetches → only last renders
- **Cleanup:**
  - Remove dead code from App.tsx (extracted state, inline pagination, old card list)
  - Remove `paginateArray` from `app.mjs` if no longer used
  - Verify no `console.warn` about unmounted components
  - Run full suite: `npm test && npm run test:api && npm run test:e2e`
- **Docs**: Update `CLAUDE.md` with new API routes and hook contracts

**Success Criteria:**
- Full test suite passes: `npm test`, `npm run test:api`, `npm run test:e2e`
- No console warnings or errors in development mode
- Memory benchmark shows < 200MB heap for 50K cards
- All edge case tests pass (empty, not-found, unauthorized, concurrent)
- `wc -l src/App.tsx` < 600

**Blockers:** All Steps 1-7

**Risks & Mitigations:**
- E2E tests flaky with real-time subscriptions → retry 2x with `page.waitForTimeout(500)`
- Memory benchmark environment-dependent → non-blocking CI check

**Effort:** Medium

---

## Implementation Summary

| Step | Phase | Description | Effort | Dependencies | Key Files Changed |
|---|---|---|---|---|---|
| 0 | Setup | Prerequisites, shared types, conventions | Small | None | `server/pagination.mjs`, `src/hooks/common.ts`, `src/types.ts` |
| 1 | Backend | Cursor pagination API + indexes | Medium | 0 | `app.mjs`, `localRepository.mjs`, `supabaseRepository.mjs`, migration |
| 2 | Backend | Card version history + rollback API | Large | 0 | `app.mjs`, both repos, `domain.mjs`, migration |
| 3 | Backend | pgvector + semantic similarity search | Large | 0 | `app.mjs`, both repos, migration |
| 4 | Frontend | App.tsx decomposition into 3 hooks | Large | 0 | `src/hooks/*.ts`, `App.tsx`, test files |
| 5 | Frontend | AbortController request cancellation | Medium | None (benefits from 4) | `src/api.ts`, `App.tsx`, hooks |
| 6 | Frontend | Real-time card postgres_changes subscription | Medium | 4 | `src/useRealtime.ts`, `App.tsx` |
| 7 | Frontend | CardVirtualList with cursor pagination UI | Large | 1, 5 | `src/CardVirtualList.tsx`, `App.tsx`, `api.ts` |
| 8 | Polish | Integration tests, benchmarks, edge cases | Medium | 1-7 | Test files, `memory-benchmark.mjs` |

**Execution strategy:**
- Phases 1-2 (Steps 1-5) can be parallelized across developers — no file conflicts between backend (1-3) and frontend (4-5)
- Phase 3 (Steps 6-7) must wait for their respective dependencies (Step 4 for Step 6; Step 1 for Step 7)
- Phase 4 (Step 8) is a single integration pass

---

## Parallelization Plan

### Available Agents

| Agent | Capability | Use Case |
|-------|-----------|----------|
| `explore` | Codebase exploration, reading existing patterns, research | Step 0 setup — understand conventions before writing shared types |
| `general` | General coding — backend (Express, Supabase, migrations) and frontend (React, hooks, components) | Steps 1–8 implementation |

### Parallel Tracks

#### Track A: Backend API Layer — Steps 1, 2, 3 (parallel)

All three steps depend only on Step 0. They add distinct route groups and repository methods to the same files (`app.mjs`, `*Repository.mjs`) — changes are additive and merge-safe. Run them in parallel using separate sub-agents.

| Step | Agent | Reasoning |
|------|-------|-----------|
| 1 | `general` | Express route + repo cursor pagination — self-contained backend |
| 2 | `general` | Version history routes + repo + domain logic — independent of Step 1,3 |
| 3 | `general` | pgvector migration + similarity route + embedding generation — independent of Step 1,2 |

**File conflict handling:** Each step adds distinct route groups and repository methods. `app.mjs` routes are prefix-isolated (`/cards`, `/versions`, `/similar`). Accept merge conflicts on `app.mjs` route registration; resolve by appending (order doesn't matter for different paths).

#### Track B: Frontend Architecture — Steps 4, 5 (parallel)

Both depend only on Step 0. Step 5 benefits from Step 4 conceptually but has **no hard file dependency** — they modify different primary files (hooks vs `api.ts`). Minor overlap on `App.tsx` is additive (import statements vs guard clauses) and merges cleanly.

| Step | Agent | Reasoning |
|------|-------|-----------|
| 4 | `general` | Hook extraction — `useDeckOperations`, `useReviewQueue`, `useSyncState` — pure frontend refactor |
| 5 | `general` | AbortController wrappers in `api.ts` + effect cleanup guards — touches `api.ts` primarily |

**File conflict handling:** Step 4 writes `src/hooks/*.ts` (new files). Step 5 writes `src/api.ts` (new wrapper functions). Both touch `App.tsx` — Step 4 replaces inline state with hook calls; Step 5 adds `useEffect` cleanup guards. Apply Step 4 changes first, then overlay Step 5 guards.

#### Sequential Chain — Steps 6, 7

| Step | Agent | Blocks On | Reasoning |
|------|-------|-----------|-----------|
| 6 | `general` | Step 4 | Real-time subscription needs hook boundaries from decomposition to wire `onCardChange` |
| 7 | `general` | Step 1, Step 5 | Virtual list needs cursor pagination API (Step 1) and `api.cancellableGet` (Step 5) |

Step 6 and Step 7 can run in parallel with each other (no shared dependency ordering).

#### Integration Pass — Step 8

| Step | Agent | Blocks On | Reasoning |
|------|-------|-----------|-----------|
| 8 | `general` | Steps 1–7 | All features must exist before integration tests, benchmarks, and edge case polish |

### Parallelization Diagram

```
                    ┌────────────────────────────────────────────────────────────┐
                    │                    Step 0 (explore)                        │
                    │  pagination.mjs · common.ts · types.ts · conventions      │
                    └──────────┬──────────┬──────────┬──────────┬───────────────┘
                               │          │          │          │
              ┌────────────────┤          │          ├──────────────────┐
              ▼                ▼          ▼          ▼                  ▼
     ┌────────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
     │  Track A       │ │ Track A  │ │ Track A  │ │ Track B  │ │ Track B      │
     │  Step 1 (gen)  │ │Step 2(gen)│ │Step 3(gen)│ │Step 4(gen)│ │ Step 5 (gen) │
     │  Cursor Pag.   │ │Versions  │ │ pgvector │ │ Hooks    │ │ AbortCtrl    │
     │  API + idx     │ │ + Rollbk │ │ + Similar│ │ Extract  │ │ + api.ts     │
     └────────┬───────┘ └──────────┘ └──────────┘ └─────┬────┘ └──────┬───────┘
              │                                         │             │
              │           ┌─────────────────────────────┘             │
              │           │              ┌────────────────────────────┘
              ▼           ▼              ▼
     ┌────────────────────────────────────────────────────┐
     │              Step 6 (general) — Real-time subs     │
     │  (blocks on Step 4)                                │
     └────────────────────┬───────────────────────────────┘
                          │
     ┌────────────────────┐
     │  Step 7 (general)  │
     │  CardVirtualList   │
     │  (blocks on 1 + 5) │
     └─────────┬──────────┘
               │
               ▼
     ┌────────────────────────────────────────────────────┐
     │       Step 8 (general) — Integration + Polish      │
     │  Tests · Benchmarks · Edge Cases · Cleanup · Docs  │
     │  (blocks on all Steps 1-7)                         │
     └────────────────────────────────────────────────────┘
```

### Execution Directives

These rules govern how sub-agents run each step to maximize parallelism and minimize merge pain:

**1. Branch isolation:**
- Each step in Track A (Steps 1, 2, 3) MUST be implemented on its own feature branch: `feat/cursor-pagination`, `feat/card-versions`, `feat/pgvector`
- Steps in Track B (Steps 4, 5) MUST be implemented on separate branches: `feat/hooks-decompose`, `feat/abort-controller`
- Steps 6, 7, 8 MUST branch from the integration of their dependencies
- The `main` branch MUST NOT receive direct commits during parallel execution

**2. Repository interface contract:**
All backend steps (1, 2, 3) add methods to both `localRepository.mjs` and `supabaseRepository.mjs`. Each step MUST:
- Add its method signature to both implementations in the same commit
- Keep method signatures consistent: same params, same return shape
- NOT modify existing method signatures from other steps

**3. Shared file append-only policy:**
- `app.mjs`: Each step appends its route group — never delete or reorder another step's routes
- `server/domain.mjs`: Each step adds standalone functions — never modify another step's functions
- Migration files: Each step creates its own timestamped migration — never edit another step's migration

**4. Frontend merge order:**
When merging Track B into the integration branch:
1. Merge `feat/hooks-decompose` (Step 4) first — establishes the new hook interfaces
2. Merge `feat/abort-controller` (Step 5) second — retrofits hooks and App.tsx with guards
3. Resolve `App.tsx` conflicts by accepting Step 4's structure, then applying Step 5's guard clauses

**5. Sub-agent handoff protocol:**
- Each sub-agent MUST output a summary of what it created/changed at the end of its step
- The summary MUST list: all new files, all modified files with line ranges changed, all new exports
- The next sub-agent in the chain reads these summaries before starting work

**6. Verification gates:**
- After each step completes: `npm test && npm run test:api` must pass (where applicable)
- After Step 4 and Step 5 merge: `npm run build` must pass (TypeScript check)
- After Step 7: `npm run test:e2e` must pass
- Step 8 is the final gate: full suite must pass

---

## Verification

### Step 0: Setup — Prerequisites, Dependencies, and Conventions

**Verification Level:** `None`

**Rationale:** File creation and type definitions. Success is binary — files exist at expected paths, types compile, round-trip tests pass. Verified directly via `tsc --noEmit` and unit test assertions.

---

### Step 1: Cursor Pagination API

**Verification Level:** `Panel`

**Verification Prompts:**

```
You are evaluating Step 1 (Cursor Pagination API) of the DeckBridge next-level improvements feature.

Files to evaluate:
- server/app.mjs — GET /api/decks/:deckId/cards route
- server/repositories/localRepository.mjs — listCardsCursor
- server/repositories/supabaseRepository.mjs — listCardsCursor
- server/pagination.mjs — encodeCursor / decodeCursor
- supabase/migrations/20260513120000_cards_cursor_index.sql
- server/routes.api.test.mjs — cursor pagination tests

Success criteria:
1. GET /api/decks/:deckId/cards?limit=3 returns { cards: [...], nextCursor: "..." }
2. Second call with cursor returns next page with NO overlapping card IDs
3. Cursor past end returns nextCursor: null
4. P95 response time < 200ms for 500-card page on 50K card deck
5. Stable ordering by (created_at ASC, id ASC)

Evaluate using the Panel rubric below.
```

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Correctness | 0.35 | Pages have no overlapping card IDs; ordering is stable by (created_at, id); cursor past end returns null |
| Performance | 0.30 | P95 < 200ms for 500-card page on 50K deck; P99 < 500ms; composite index exists on (deck_id, created_at, id) |
| Completeness | 0.20 | Both repo implementations (local + supabase) support listCardsCursor; migration creates index; API route registered |
| Test Coverage | 0.15 | API test covers: page 1 returns non-null cursor, page 2 returns no overlap with page 1, past end returns null cursor |

**Threshold:** 4.0/5.0

---

### Step 2: Card Version History with Rollback

**Verification Level:** `Panel`

**Verification Prompts:**

```
You are evaluating Step 2 (Card Version History) of the DeckBridge next-level improvements feature.

Files to evaluate:
- supabase/migrations/20260513130000_card_version_history.sql
- server/repositories/localRepository.mjs — listCardVersions, getCardVersion, createCardVersion, rollbackCardToVersion
- server/repositories/supabaseRepository.mjs — matching methods
- server/domain.mjs — snapshotCard
- server/app.mjs — 4 routes + auto-versioning in decideSuggestion
- server/routes.api.test.mjs — version lifecycle + rollback tests
- server/domain.test.mjs — snapshotCard unit test

Success criteria:
1. Accepting a suggestion auto-creates a version snapshot before applying the suggestion
2. Rollback to version N restores card fields + tags, creates undo version N+1
3. Non-editor receives 403 on rollback endpoint
4. Version list endpoint returns metadata only (no snapshot body in list)
5. Full version endpoint returns complete snapshot for preview/restore

Evaluate using the Panel rubric below.
```

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Correctness | 0.35 | Rollback restores exact snapshot; pre-rollback state recorded as new version; auto-versioning triggers on suggestion accept before applySuggestion runs |
| Authorization | 0.25 | requireEditor enforced on rollback; contributor+ can read versions; appropriate 403 responses for unauthorized users |
| Completeness | 0.20 | All 4 routes implemented; both repos implement all methods; snapshotCard returns { fields, tags, modelName, modifiedAt }; trimmed snapshot omits renderedFront/renderedBack/clozeOrd |
| Test Coverage | 0.20 | Unit tests for snapshotCard and rollback logic; API tests for full version lifecycle (create, list, read, rollback) |

**Threshold:** 4.0/5.0

---

### Step 3: pgvector Integration for Semantic Duplicate Detection

**Verification Level:** `Single`

**Verification Prompts:**

```
You are evaluating Step 3 (pgvector Integration) of the DeckBridge next-level improvements feature.

Files to evaluate:
- supabase/migrations/20260513140000_pgvector_embeddings.sql
- server/app.mjs — POST /api/decks/:deckId/cards/similar + embedding generation hooks
- server/repositories/supabaseRepository.mjs — findSimilarCards
- server/repositories/localRepository.mjs — findSimilarCards
- server/domain.mjs — cosineSimilarity
- server/routes.api.test.mjs — similar cards API tests

Success criteria:
1. Migration creates embedding vector(1536) column and ivfflat index on cards table
2. Creating a card generates a non-null embedding
3. POST /api/decks/:deckId/cards/similar returns cards with score >= threshold sorted descending by cosine similarity
4. Card with null embedding returns empty similarity results
5. P95 < 500ms for similarity search on 10K embedded cards
6. Embedding generated synchronously for cards < 10K chars; async for larger

Evaluate holistically: does the implementation correctly wire pgvector from migration through API response? Are edge cases (null embeddings, threshold filtering) handled? Is embedding generation integrated into card create/update lifecycle?
```

**Threshold:** 4.0/5.0

---

### Step 4: App.tsx Decomposition into Domain Hooks

**Verification Level:** `Panel`

**Verification Prompts:**

```
You are evaluating Step 4 (App.tsx Decomposition) of the DeckBridge next-level improvements feature.

Files to evaluate:
- src/hooks/useDeckOperations.ts
- src/hooks/useReviewQueue.ts
- src/hooks/useSyncState.ts
- src/hooks/common.ts
- src/App.tsx (post-extraction)
- src/hooks/useDeckOperations.test.ts
- src/hooks/useReviewQueue.test.ts
- src/hooks/useSyncState.test.ts

Success criteria:
1. App.tsx line count < 600 lines (verified via wc -l)
2. All existing tests pass without modification
3. New hook tests achieve > 80% branch coverage
4. App renders identically — no visual regression on dashboard, deck view, study mode
5. Each hook file exists at src/hooks/use*.ts
6. Hook exports match specified contracts:
   - useDeckOperations: decks, activeDeck, loadDecks, loadDeck, uploadDeck, deleteDeck, exportDeck, isPending, error, resetError
   - useReviewQueue: cards, currentIndex, currentCard, nextCard, prevCard, rateCard, resetQueue, isEmpty, isExhausted, totalCount
   - useSyncState: syncStatus, lastSyncedAt, pushChanges, pullChanges, conflictCount, pendingChanges, resetSync

Evaluate using the Panel rubric below.
```

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Correctness | 0.30 | App renders identically (no visual regression on any view); all existing tests pass; hook exports match contracts exactly |
| Structure | 0.30 | App.tsx < 600 lines (wc -l); each hook in own file at src/hooks/use*.ts; hooks are independent (no circular imports); useDebounce extracted to common.ts |
| Test Coverage | 0.25 | New hook tests achieve > 80% branch coverage; test files exist at src/hooks/*.test.ts; tests run without flakiness |
| Completeness | 0.15 | All 25+ state variables extracted from App.tsx into the appropriate hook; no dead state left in App.tsx; hook boundaries are correct |

**Threshold:** 4.0/5.0

---

### Step 5: Request Cancellation with AbortController

**Verification Level:** `Single`

**Verification Prompts:**

```
You are evaluating Step 5 (Request Cancellation) of the DeckBridge next-level improvements feature.

Files to evaluate:
- src/api.ts — ApiRequest<T>, createCancellableFetch, cancellableGet/Post, signal plumbing via jsonRequest
- src/App.tsx — useEffect cleanup guards with AbortController
- src/hooks/*.ts — AbortSignal acceptance, cancelled guards before setState
- src/api.test.ts — cancellable fetch unit test

Success criteria:
1. No "Can't perform a React state update on an unmounted component" warnings in browser console
2. .cancel() on ApiRequest causes promise to reject with AbortError and signal.aborted === true
3. AbortError caught silently (error.name === 'AbortError' → return, not surfaced as notification)
4. All existing API wrapper functions (api.get, api.post, etc.) accept optional AbortSignal (backward-compatible)
5. Rapid navigation between decks produces no orphaned requests in Network tab

Evaluate holistically: does the api.ts layer properly expose cancellation without breaking existing callers? Are all useEffect call sites protected with cleanup that calls controller.abort()? Are AbortErrors caught silently without surfacing to users as error notifications?
```

**Threshold:** 4.0/5.0

---

### Step 6: Real-time Card Updates via Postgres Changes

**Verification Level:** `Single`

**Verification Prompts:**

```
You are evaluating Step 6 (Real-time Card Updates) of the DeckBridge next-level improvements feature.

Files to evaluate:
- src/useRealtime.ts — postgres_changes subscription on cards table with deck_id filter
- src/App.tsx — onCardChange callback wiring to local card list state
- supabase migration — ALTER PUBLICATION supabase_realtime ADD TABLE cards
- src/useRealtime.test.ts — subscription unit tests

Success criteria:
1. Inserting a card via API triggers onCardInsert callback within 200ms
2. Updating a card replaces local state only if incoming updated_at >= local updated_at (stale-overwrite prevention)
3. Deleting a card removes it from local list by id
4. Navigating away from deck unsubscribes channel (verify via supabase.getChannels())
5. Retry logic on subscription error: 3 attempts with exponential backoff (1s, 2s, 4s)
6. Channel name convention: deck-cards-{deckId} (unique per subscription)

Evaluate holistically: are all three event types handled with correct logic? Is stale-overwrite prevention implemented for UPDATE? Does cleanup call .unsubscribe()? Are events for different deck_ids correctly filtered out?
```

**Threshold:** 4.0/5.0

---

### Step 7: Card Virtual List with Cursor Pagination UI

**Verification Level:** `Panel`

**Verification Prompts:**

```
You are evaluating Step 7 (CardVirtualList) of the DeckBridge next-level improvements feature.

Files to evaluate:
- src/CardVirtualList.tsx — virtual scrolling component
- src/App.tsx — integration replacing full card list
- src/types.ts — CursorPage<T> type
- src/api.ts — api.cards.list method

Success criteria:
1. Deck with 1,500 cards: scroll to bottom, all cards rendered (verified via E2E test)
2. No duplicate cards or gaps during rapid scroll
3. JS heap < 200MB during/after loading 50K cards
4. Renders only visible rows + 2 buffer rows above/below viewport (IntersectionObserver)
5. Pre-fetch trigger: scroll within 200px of loaded content bottom
6. Rapid scroll debounced at 150ms — coalesces into single fetch
7. Uses api.cancellableGet (from Step 5) for each page fetch
8. Loading skeleton for in-flight pages
9. Maintains ordered card list via cursor pagination, dedup by card.id

Evaluate using the Panel rubric below.
```

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Correctness | 0.30 | No duplicate card IDs rendered; no visual gaps during scroll; all cards reachable by scrolling through entire deck; IntersectionObserver correctly windowed |
| Performance | 0.30 | JS heap < 200MB for 50K cards (memory benchmark passes); pre-fetch triggers at 200px threshold; 150ms debounce coalesces rapid scrolls; loading skeleton shown for in-flight pages |
| Completeness | 0.20 | CursorPage<T> type added to types.ts; api.cards.list in api.ts; CardVirtualList integrated into App.tsx replacing old card list; uses AbortController from Step 5; fixed 60px row height |
| Test Coverage | 0.20 | E2E test verifies 1,500 cards render on full scroll; no gaps detected during automated scroll test |

**Threshold:** 4.0/5.0

---

### Step 8: Integration, Polish, Edge Cases, and Benchmarks

**Verification Level:** `Single`

**Verification Prompts:**

```
You are evaluating Step 8 (Integration, Polish, Edge Cases) of the DeckBridge next-level improvements feature.

Files to evaluate:
- server/routes.api.test.mjs — integration tests for all new endpoints
- server/memory-benchmark.mjs — 50K card heap measurement
- server/domain.test.mjs — edge case unit tests
- All modified files from Steps 1-7 (cleanup pass)

Success criteria:
1. Full test suite passes: npm test && npm run test:api && npm run test:e2e
2. No console warnings or errors in development mode (verify browser console clean)
3. Memory benchmark: JS heap < 200MB for 50K cards
4. All edge cases pass:
   - Empty deck cursor pagination → empty array, null cursor
   - Rollback invalid versionId → 404
   - Similar cards with null embeddings → empty results
   - AbortController called after unmount → no-op (no crash)
   - Concurrent real-time INSERT while scrolling → card appears at correct position
5. Dead code removed: inline pagination from App.tsx, paginateArray from app.mjs if unused
6. CLAUDE.md updated with new API routes and hook contracts

Evaluate holistically: is the full integration clean and stable? Are edge cases covered? Is dead code removed? Are docs updated?
```

**Threshold:** 4.0/5.0

---

### Verification Summary

| Step | Level | Key Criteria | Threshold |
|------|-------|-------------|-----------|
| 0 — Setup | `None` | Files exist, tsc passes, round-trip test | Binary |
| 1 — Cursor Pagination | `Panel` | Correctness (0.35), Performance (0.30), Completeness (0.20), Test Coverage (0.15) | 4.0/5.0 |
| 2 — Version History | `Panel` | Correctness (0.35), Authorization (0.25), Completeness (0.20), Test Coverage (0.20) | 4.0/5.0 |
| 3 — pgvector | `Single` | Migration, API correctness, null-embedding edge case, P95 < 500ms | 4.0/5.0 |
| 4 — App Decomposition | `Panel` | Correctness (0.30), Structure (0.30), Test Coverage (0.25), Completeness (0.15) | 4.0/5.0 |
| 5 — AbortController | `Single` | Cancellation, no console warnings, backward-compatible API, all tests pass | 4.0/5.0 |
| 6 — Real-time Cards | `Single` | Event handling, stale-overwrite prevention, cleanup, retry backoff | 4.0/5.0 |
| 7 — CardVirtualList | `Panel` | Correctness (0.30), Performance (0.30), Completeness (0.20), Test Coverage (0.20) | 4.0/5.0 |
| 8 — Integration & Polish | `Single` | Full suite passes, memory < 200MB, edge cases covered, dead code removed | 4.0/5.0 |
