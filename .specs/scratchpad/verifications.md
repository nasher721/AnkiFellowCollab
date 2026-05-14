# Verification Design Reasoning

## Step 0: Setup — `None`
- **Why None:** Setup is purely mechanical — create files, export types, verify compilation. Success is binary:
  - Does `server/pagination.mjs` exist and pass round-trip test?
  - Does `tsc --noEmit` pass after adding shared types?
  - Do existing tests still pass?
- No subjective evaluation needed. These are compiler/linter checks, not design decisions.
- **Risk if wrong:** Missed type exports would cause cascading compilation failures in later steps, caught immediately by CI.

## Step 1: Cursor Pagination — `Panel`
- **Why Panel (HIGH criticality):** Data integrity (no overlapping cards between pages) is fundamental. A bug here would cause silent data loss (missing cards) or duplicates. Performance P95 < 200ms is an SLA that needs verification.
- **Rubric weights rationale:**
  - Correctness 0.35: No overlap is the #1 requirement. Wrong pagination = wrong data.
  - Performance 0.30: 200ms P95 is a hard SLA. Needs load testing.
  - Completeness 0.20: Both repos must implement identically.
  - Test Coverage 0.15: Integration test must prove no-overlap property.
- **Judge prompt focus:** The judge needs to verify page boundaries produce no overlapping card IDs, that the compound cursor is stable under concurrent inserts, and that performance benchmarks were run.

## Step 2: Version History — `Panel`
- **Why Panel (HIGH criticality):** Rollback mutates data. A bug could permanently destroy card content. Auth enforcement (403 for non-editors) prevents unauthorized data changes.
- **Rubric weights rationale:**
  - Correctness 0.35: Rollback must restore the exact snapshot — no field leaks, no partial updates. Auto-versioning on suggestion accept must fire before applySuggestion.
  - Authorization 0.25: RBAC enforcement on rollback is non-negotiable. Non-editor must get 403.
  - Completeness 0.20: All 4 routes + both repo implementations.
  - Test Coverage 0.20: Both unit tests (snapshotCard) and API tests (full lifecycle) required because data mutation needs thorough coverage.
- **Judge prompt focus:** Verify rollback atomicity (all fields restored, undo version created), auth enforcement, and auto-versioning integration in decideSuggestion.

## Step 3: pgvector — `Single`
- **Why Single (MEDIUM criticality):** pgvector is additive — it doesn't change existing data paths. A bug here means similar-search returns wrong results or times out, but doesn't corrupt existing cards.
- **No Panel because:** The API is read-only (similar search) with clearly defined success criteria. No data integrity risk. Performance P95 < 500ms is important but not blocking for correctness.
- **Judge prompt focus:** Check migration syntax, verify embedding generation on card creation, validate similarity search returns correctly sorted results with threshold filtering.

## Step 4: App.tsx Decomposition — `Panel`
- **Why Panel (HIGH criticality):** This is the riskiest refactor in the feature set. Extracting 50+ state variables into hooks could subtly break UI behavior. No visual regression is the key correctness criterion.
- **Rubric weights rationale:**
  - Correctness 0.30: No visual regression is paramount — the app must behave identically. All existing tests must pass.
  - Structure 0.30: App.tsx < 600 lines is a hard metric. Hook file organization is the whole point of this step.
  - Test Coverage 0.25: >80% branch coverage on new hooks ensures extractability and maintainability.
  - Completeness 0.15: All state variables must be accounted for — missing state = broken feature.
- **Judge prompt focus:** The judge needs to verify the app renders identically (before/after screenshots or rendering comparison), hook exports match the specified contracts, and test coverage thresholds are met.

## Step 5: AbortController — `Single`
- **Why Single (MEDIUM criticality):** Cancellation is important for UX but failure is low-risk — stale state updates don't corrupt data, they just produce console warnings.
- **No Panel because:** The success criteria are clear pass/fail: no console warnings, signal.aborted is true, tests pass. There are no complex trade-offs.
- **Judge prompt focus:** Check that all useEffect call sites have cleanup guards, AbortErrors are caught silently, and the api.ts wrapper correctly exposes cancellation.

## Step 6: Real-time Cards — `Single`
- **Why Single (MEDIUM criticality):** Real-time subscriptions are additive UX improvement. A bug here means stale card lists (need manual refresh) but doesn't break the core edit/review flow.
- **No Panel because:** The implementation follows a well-known Supabase pattern (postgres_changes). Success criteria are behavioral (callbacks fire, cleanup works) rather than quantitative.
- **Judge prompt focus:** Verify all three event types (INSERT/UPDATE/DELETE) are handled, stale-overwrite prevention via updated_at comparison, channel cleanup on unmount, and retry backoff.

## Step 7: CardVirtualList — `Panel`
- **Why Panel (HIGH criticality):** Virtual scrolling with pagination directly affects visual correctness (gaps/duplicates) and performance (heap usage). Bad rendering is immediately visible to users. Memory leaks with 50K cards would crash browser tabs.
- **Rubric weights rationale:**
  - Correctness 0.30: No gaps or duplicates during scroll is the #1 UX requirement.
  - Performance 0.30: <200MB heap for 50K cards prevents tab crashes.
  - Completeness 0.20: Virtual list must integrate with cursor pagination API, AbortController, and IntersectionObserver.
  - Test Coverage 0.20: E2E test must verify 1,500 cards render on full scroll.
- **Judge prompt focus:** Verify IntersectionObserver-based windowed rendering, pre-fetch debounce at 150ms, AbortController integration via api.cancellableGet, heap memory benchmark results.

## Step 8: Integration & Polish — `Single`
- **Why Single (MEDIUM criticality):** This is an integration pass — combining all previous steps, adding edge case tests, and cleaning up. Each individual feature was already verified in its own step.
- **No Panel because:** The success criteria are comprehensive (full suite passes, no warnings, edge cases covered) but binary — either they pass or they don't. No weighted trade-offs.
- **Judge prompt focus:** Verify full test suite passes, memory benchmark <200MB, edge case handling (empty deck, not-found, unauthorized, concurrent real-time + scroll), and dead code removal.

## Verification Summary Table Design

The summary table at the end is designed as a quick-reference for the implementer. It maps:
- Step number → verification level
- Panel steps show weighted criteria
- Threshold is always 4.0/5.0 (standard high bar)
- `None` steps are marked "Binary" since they're pass/fail checks

This table should be referenced before the implementation plan is executed so the implementer knows what they'll be judged on.
