# DeckBridge Performance Baseline

## Bundle Size (build stats)

| Chunk | Size (gzip) | Notes |
|---|---|---|
| vendor (react, react-dom) | TBD | `rollup-plugin-visualizer: ANALYZE=true npm run build` |
| supabase | TBD | `manualChunks` in vite.config.ts |
| app (main) | TBD | ~1976-line App.tsx before decomposition |
| Total | TBD | Baseline before optimization |

## Server Response Times

| Endpoint | p50 | p95 | p99 |
|---|---|---|---|
| GET /api/health | TBD | TBD | TBD |
| GET /api/decks | TBD | TBD | TBD |
| GET /api/decks/:id | TBD | TBD | TBD |
| POST /api/decks/upload | TBD | TBD | TBD |
| GET /api/decks/:id/cards | TBD | TBD | TBD |

Measured via `X-Response-Time` header (from `server/timing.mjs`).

## Web Vitals (in-browser)

| Metric | Target | Baseline |
|---|---|---|
| LCP | <2.5s | TBD |
| FCP | <1.8s | TBD |
| CLS | <0.1 | TBD |
| INP | <200ms | TBD |
| TTFB | <800ms | TBD |

Measured via `web-vitals` library (see `src/main.tsx`).

## Optimization Results

| # | Change | Bundle Δ | LCP Δ | Notes |
|---|---|---|---|---|
| 1 | App decomposition (memo) | — | — | Reduce re-render count |
| 2 | Code splitting (lazy routes) | TBD | TBD | |
| 3 | Server compression | — | TBD | |
| 4 | Web Worker (SM-2, search) | — | TBD | |
| 5 | Error handling (retry, offline) | — | — | |
