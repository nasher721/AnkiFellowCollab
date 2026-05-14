# Parallelization Analysis — DeckBridge Next-Level

## Dependency Graph (verified from .feature.md)

```
Step-0 ─┬─> Step-1 ─┬─> Step-7 ─┐
         ├─> Step-2 ─┤           │
         ├─> Step-3 ─┤           │
         ├─> Step-4 ─┬─> Step-6 ─┤
         └─> Step-5 ─┘           │
                                  ├─> Step-8
           All steps ────────────┘
```

Key edges:
- Step 0 → 1, 2, 3, 4 (shared types + pagination.mjs + common.ts)
- Step 1 → 7 (pagination API consumed by virtual list)
- Step 4 → 6 (hook boundaries needed for real-time wiring)
- Step 5 → 7 (AbortController needed for cancellable fetches)
- Steps 1–7 → 8 (integration pass)

## File Conflict Matrix

Identified which steps touch the same files (▲ = conflict risk):

| File                   | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|------------------------|---|---|---|---|---|---|---|---|
| server/pagination.mjs  | Y|   |   |   |   |   |   |   |
| server/app.mjs         |   | Y| Y| Y|   |   |   |   |
| server/domain.mjs      |   |   | Y| Y|   |   |   |   |
| server/*Repository.mjs |   | Y| Y| Y|   |   |   |   |
| supabase/migrations/   |   | Y| Y| Y|   |   | Y|   |
| test files (api)       |   | Y| Y| Y|   |   |   |   |
| src/hooks/common.ts    | Y|   |   |   | Y|   |   |   |
| src/types.ts           | Y|   |   |   |   |   |   | Y|
| src/hooks/*.ts         |   |   |   |   | Y| Y|   |   |
| src/App.tsx            |   |   |   |   | Y| Y| Y| Y|
| src/api.ts             |   |   |   |   |   | Y|   | Y|
| test files (unit)      |   |   |   |   | Y| Y| Y|   |

**Key insight:** Steps 1-3 all touch `app.mjs`, both repositories, and migrations → they collide on backend. Steps 4-5 touch `App.tsx` and hooks → they collide on frontend. True parallel requires branch isolation.

## Parallel Track Design

### Track A: Backend API Layer (Steps 1, 2, 3)
- **Parallel strategy:** Workspace branches per step, merged sequentially into an integration branch
- **File conflict handling:** Each step adds distinct route groups to `app.mjs` and distinct methods to repositories — additive changes are merge-safe
- **Order doesn't matter** — no cross-dependency between 1, 2, 3

### Track B: Frontend Architecture (Steps 4, 5)
- **Parallel strategy:** Step 4 focuses on hooks extraction; Step 5 focuses on api.ts retrofitting
- **Overlap:** Both modify `App.tsx` — Step 4 restructures, Step 5 adds AbortController guards
- **Resolution:** Step 4 first, Step 5 adapts — or both in parallel if using separate workspaces + manual merge

### Sequential Chain (Steps 6, 7)
- Step 6 blocked on Step 4 (needs hook boundaries)
- Step 7 blocked on Step 1 (pagination API exists) + Step 5 (AbortController exists)
- Neither can start until their dependencies finish

### Integration (Step 8)
- Blocked on all of 1-7
- Natural final pass

## Agent Assignments

| Step | Agent    | Reason |
|------|----------|--------|
| 0    | explore  | Codebase exploration to understand existing patterns before writing shared types |
| 1    | general  | Pure backend — Express routes, repository methods, migrations |
| 2    | general  | Pure backend — same patterns as Step 1 |
| 3    | general  | Pure backend — pgvector + 9Router integration |
| 4    | general  | Pure frontend — React hook extraction |
| 5    | general  | Pure frontend — api.ts refactoring, component guards |
| 6    | general  | Frontend — real-time subscription wiring |
| 7    | general  | Frontend — virtual list component |
| 8    | general  | Integration — tests, benchmarks, polish |

## Recommendation
- Steps 1, 2, 3 should NOT run as raw parallel (same agent would context-switch; separate agents would conflict on backend files). Instead, run them **sequentially within Track A** using one `general` agent per backend step, passing context.
- Steps 4 and 5 CAN run as true parallel because their core changes are in different files (hooks vs api.ts). App.tsx changes are additive (import hooks vs add guards) and merge cleanly.
- Use `explore` agent for Step 0 setup (understanding codebase conventions).
