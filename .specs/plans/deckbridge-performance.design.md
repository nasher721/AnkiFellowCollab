# DeckBridge Performance Design

## Overview

A broad performance pass across the full stack: bundle size, React rendering, database queries, and large-deck data handling. Every change must produce a measurable improvement against the KPIs below.

## Goals & Measurement

| Metric | Target | Tool |
|---|---|---|
| LCP | < 2.5s | `web-vitals` library |
| Card list scroll | 60fps at 10K cards | React DevTools profiler |
| Search/filter latency | < 100ms | Browser Performance API |
| API P95 | < 200ms (excl. AI) | Express timing middleware |
| Initial JS chunk | < 150KB gzipped | `rollup-plugin-visualizer` |
| App re-renders | No cascading re-renders | React DevTools flame graphs |

Add `web-vitals` to `src/main.tsx` for real-user monitoring. Add request-timing middleware to Express. Run a profiling script before and after each phase.

## Section 1: App Decomposition & Render Optimization

The 1,976-line `App.tsx` is the primary performance liability. Every state change in that component risks cascading re-renders across the entire view tree.

**Extract inline components.** Move these to `src/components/`, each in its own file with typed props and `React.memo`: `AuthScreen`, `SyncHealthStrip`, `OwnerAttentionPanel`, `WorkbenchLayout`, `OverviewRail`, `CardRail`, `ReviewWorkspace`, `ReviewInspectionPanel`, `ReviewDecisionBar`, `ReviewQueueList`. Each gets `React.memo` with stable props so one change does not cascade.

**Profile-guided memoization.** After extraction, profile with React DevTools flame graphs. Apply `useMemo` to expensive derivations (filtered card lists, computed stats, tag aggregations). Apply `useCallback` to event handlers passed as props to memoized children. Split overbroad context subscriptions — if a component reads only `user` from a context that also carries deck state, create a separate `UserContext`.

**Route-based code splitting.** Wrap heavy views with `React.lazy(() => import(...))` and a `Suspense` boundary: `AnalyticsDashboard`, `DiscoverView`, `TemplateGallery`, `StudyView`. Their chart libraries and template engines load on demand, not at startup.

## Section 2: Bundle Size & Build Optimization

**Analyze first.** Run `rollup-plugin-visualizer` to identify heavy imports. Common suspects: chart libraries in AnalyticsDashboard, markdown renderers, date utilities. Each gets moved to a lazy-loaded async chunk.

**Code splitting.** Three tiers: route chunks (one per top-level view), vendor chunk (`react`, `react-dom`, Supabase client — stable with long-term caching), feature chunk (AI assist loads only when the owner opens the Workbench rail).

**Tree-shake.** Check `package.json` for unused or partially-used packages. Replace full-locale date library imports with `date-fns` tree-shakeable imports. Import `lodash` as individual functions. Verify the Supabase client import tree-shakes unused methods.

**CSS optimization.** Remove unused rules with `purgecss` in production. Inline critical CSS for initial page render.

## Section 3: Database & Query Optimization

**Missing indexes.** Add these composite indexes to Supabase, each targeting a specific query pattern visible in the Express route handlers:

- `cards(deck_id, updated_at)` — cursor pagination
- `suggestions(deck_id, status, created_at)` — review queues
- `deck_members(deck_id, user_id)` — membership lookups
- `card_versions(card_id, created_at)` — version history

Verify with `EXPLAIN ANALYZE` that pagination queries use index-only scans.

**Cursor pagination tuning.** Ensure the composite index covers both the sort column and the cursor column. Handle the edge case where the cursor points past the last result — return an empty set without a full table scan.

**Response compression.** Enable `compression` middleware in Express for gzip on JSON responses. Card lists of 200KB+ drop to 20-30KB.

**HTTP caching.** Add `Cache-Control: public, max-age=60` (or `ETag`/`If-None-Match`) on read-only endpoints: `GET /api/decks`, `GET /api/decks/:id`, `GET /api/decks/:id/cards`.

## Section 4: Large Deck Data Handling

Decks with 10K+ cards stress both server (pagination, sync) and client (rendering, search).

**Streaming `.apkg` imports.** `parseApkg` currently loads the entire zip into memory. Switch to incremental processing: read the zip header, extract and normalize cards in batches of 500, write each batch before reading the next. Discard partial imports on interruption.

**Chunked Anki sync.** The add-on push endpoint receives all modified cards in one request. Split into batches of 200 with a sequence number. The server acknowledges each batch; on reconnect, the add-on resumes from the last acknowledged batch. This also avoids Vercel's 10s function timeout.

**Web Worker for client computation.** Offload SM-2 scheduling and tag/state filtering on large card lists to a Web Worker. The worker receives card data, computes, and posts results back — keeping the UI responsive during heavy operations.

## Section 5: Error Handling & Fallbacks

**Graceful degradation for AI features.** If the 9Router gateway is slow or unreachable, fall back to local-only review without briefs. Show a subtle indicator that AI features are unavailable rather than blocking the view.

**Request cancellation.** Use `AbortController` for all API fetches. If the user navigates away from a view before its data loads, cancel the in-flight request. This prevents stale state updates and reduces server load.

**Retry with backoff.** For sync operations, implement exponential backoff (1s, 2s, 4s, 8s, max 30s) with jitter. Show progress to the user during long operations rather than a spinner.

**Offline resilience.** Cache the last-loaded card list and deck metadata in `localStorage`. If the API is unreachable, show cached data with a "stale" indicator. This makes the app usable during spotty connections — common when studying on mobile or transit.

## Testing Strategy

**Before/after benchmarks.** Run each KPI measurement before and after every change. Record results in a `PERF.md` log to prevent regressions.

**React render tests.** Add `vitest` tests that assert render count for memoized components using `@testing-library/react` and `console spy`. A component wrapped in `React.memo` should not re-render when its props haven't changed.

**API latency tests.** Extend `routes.api.test.mjs` with response-time assertions for paginated endpoints. Use `Date.now()` before and after the request.

**E2E performance smoke tests.** Add two Playwright tests: one that loads a deck with 5000 cards and measures time-to-interactive, one that scrolls through the virtual list and measures frame drops (via `requestAnimationFrame` callback injection).

## Implementation Priority

1. **Measurement & profiling setup** (add `web-vitals`, request-timing middleware, baseline capture)
2. **App decomposition** (extract inline components, add `React.memo`)
3. **Code splitting** (lazy-load heavy views, vendor chunk, tree-shake)
4. **Database indexes & query optimization** (add indexes, compression, caching)
5. **Large deck streaming** (streaming imports, chunked sync)
6. **Web Worker offloading** (SM-2, search filtering)
7. **Error handling & fallbacks** (AbortController, retry, offline cache)
8. **Test coverage** (render tests, latency assertions, E2E perf smoke tests)
