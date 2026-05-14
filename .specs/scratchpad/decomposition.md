# Decomposition Scratchpad: DeckBridge Next-Level

## Reasoning

### Codebase Snapshot
- **App.tsx**: 3,499 lines, ~54 `useState` calls — extraction target
- **api.ts**: 587 lines, typed fetch wrapper — AbortController target
- **useRealtime.ts**: 45 lines, subscribes to `suggestions`/`comments` — needs cards channel
- **server/app.mjs**: 2,962 lines — route definitions, some in-memory pagination exists
- **localRepository.mjs**: 1,089 lines — JSON-file state, needs new methods
- **supabaseRepository.mjs**: 1,544 lines — Postgres, needs new methods
- **domain.mjs**: 874 lines — pure business logic
- **aiGateway.mjs**: 312 lines — `embed()` method already exists for 9Router
- **Migrations**: 16 files in `supabase/migrations/` with `YYYYMMDDHHMMSS_` prefix

### Dependency Graph

```
Step 0 (Prerequisites)
 ├── Step 1 (Pagination API) ................. no inter-step deps
 ├── Step 2 (Version History) ............... no inter-step deps
 ├── Step 3 (pgvector) ....................... no inter-step deps
 ├── Step 4 (App.tsx decomposition) ......... no inter-step deps
 └── Step 5 (AbortController API) ........... no inter-step deps

Step 4 ──► Step 6 (Real-time cards) ........ depends on App.tsx extraction
Step 1 ──► Step 7 (Virtual Scroll) ......... depends on pagination API

Step 6 + Step 7 ──► Step 8 (Polish) ........ integration + tests
```

### Critical Path
**Step 0 → Step 1 → Step 7 → Step 8** (pagination flow: longest path through backend to UI)
**Step 0 → Step 4 → Step 6** (decomposition before real-time, to avoid merge conflicts)

### Parallelization Opportunities
- Steps 1-5 can be done in parallel by different developers (no file overlap)
- Step 5 (AbortController) benefits all subsequent steps but doesn't block them

### Risk Analysis

| Risk | Impact | Mitigation |
|---|---|---|
| App.tsx extraction breaks existing behavior | High | Extract one hook at a time; run `npm test` after each |
| pgvector migration requires Supabase Postgres with extension | Medium | IVFFlat index without the extension creates a valid migration that skip on local; add `CREATE EXTENSION IF NOT EXISTS vector` |
| Real-time subscription fires stale events after reconnection | Low | Full list fetch on mount + `updated_at >= local updated_at` guard |
| Version snapshot payload too large | Medium | Store as JSONB; index `(card_id, created_at)` for fast queries |
| AbortController retrofitting touches every api.ts method | Medium | Add optional `signal` param to `jsonRequest`; add convenience wrappers |
| 9Router/OpenAI rate limits for batch embedding | Medium | Batch API has configurable `limit`; add 200ms delay between calls |

## Implementation Order Decision

**Backend-first + Frontend-parallel strategy:**
1. Setup first (migration patterns, env, types)
2. All backend routes (Steps 1-3) — independent, same files touched
3. Frontend extraction (Step 4) — high-value, unblocks parallel frontend work
4. AbortController (Step 5) — touches api.ts only
5. Real-time cards (Step 6) — depends on Step 4
6. Virtual scroll (Step 7) — depends on Step 1
7. Polish (Step 8) — depends on everything

## File Change Map

### Step 1 (Pagination API)
- `server/app.mjs` — new route `GET /api/decks/:deckId/cards`
- `server/repositories/index.mjs` — no change (pattern: optional method)
- `server/repositories/localRepository.mjs` — add `listCardsCursor` method
- `server/repositories/supabaseRepository.mjs` — add `listCardsCursor` method
- New: `server/pagination.mjs` — shared cursor encode/decode helpers
- `server/domain.mjs` — add `encodeCursor`, `decodeCursor` if not extracted

### Step 2 (Version History)
- New: `supabase/migrations/20260513100000_card_version_history.sql`
- `server/app.mjs` — 4 new routes
- `server/repositories/localRepository.mjs` — add version CRUD methods
- `server/repositories/supabaseRepository.mjs` — add version CRUD methods
- `server/domain.mjs` — `createCardSnapshot` helper
- `server/rbac.mjs` — no change (existing middleware covers it)

### Step 3 (pgvector)
- New: `supabase/migrations/20260513110000_pgvector_embeddings.sql`
- `server/app.mjs` — new route `POST /api/decks/:deckId/cards/similar`
- `server/repositories/supabaseRepository.mjs` — `findSimilarCards` method
- `server/repositories/localRepository.mjs` — in-memory cosine similarity search
- `server/domain.mjs` — `cosineSimilarity` already exists

### Step 4 (App.tsx decomposition)
- New: `src/hooks/useDeckOperations.ts`
- New: `src/hooks/useReviewQueue.ts`
- New: `src/hooks/useSyncState.ts`
- New: `src/hooks/common.ts`
- `src/App.tsx` — import & use hooks, delete extracted code
- New: `src/hooks/useDeckOperations.test.ts`
- New: `src/hooks/useReviewQueue.test.ts`
- New: `src/hooks/useSyncState.test.ts`

### Step 5 (AbortController)
- `src/api.ts` — add `createCancellableFetch`, `ApiRequest<T>`, optional `signal` param
- `src/App.tsx` — add `useRef/isMounted` guards, cleanup in effects
- `src/hooks/*.ts` — AbortController cleanup in each hook

### Step 6 (Real-time cards)
- `src/useRealtime.ts` — add `postgres_changes` on `cards` table
- `src/hooks/*.ts` — integrate real-time card updates
- `src/App.tsx` — wire card change callbacks

### Step 7 (Virtual Scroll)
- New: `src/CardVirtualList.tsx`
- `src/App.tsx` — integrate CardVirtualList
- `src/types.ts` — pagination types

### Step 8 (Polish)
- New: `server/memory-benchmark.mjs`
- `server/*.test.mjs` — new integration tests per AC
- `server/*.api.test.mjs` — new API tests per AC
