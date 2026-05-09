# Codebase Impact Analysis: 9Router AI Owner Assist

## Summary

The implementation touches the existing React/Express/Supabase/local-repository seams rather than replacing them. AI artifacts must be represented in shared types, returned through the existing API state, persisted in both repositories, and rendered inside existing owner surfaces.

## Primary Files

- `server/aiGateway.mjs`: new server-only 9Router adapter.
- `server/aiGateway.test.mjs`: gateway capability, timeout, malformed JSON, and fallback tests.
- `server/aiOwnerAssist.mjs`: prompt builders, input hashing, JSON validators, advisory artifact normalization.
- `server/app.mjs`: AI status, deck settings, suggestion brief, duplicate search, conflict summary, diagnostics, and study hint endpoints.
- `server/domain.mjs`: canonical card text, duplicate candidate shaping, stale-analysis input hashes.
- `server/repositories/localRepository.mjs`: local AI settings/artifact persistence.
- `server/repositories/supabaseRepository.mjs`: Supabase AI settings/artifact persistence.
- `server/repositories/index.mjs`: repository contract alignment if helper methods are added.
- `supabase/migrations/20260510120000_ai_owner_assist.sql`: deck AI settings, AI artifacts, embeddings metadata, duplicate links.
- `src/types.ts`: AI settings, briefs, duplicate links, conflict summaries, hints, gateway status.
- `src/api.ts`: typed client methods for AI settings and advisory actions.
- `src/App.tsx`: Owner Attention quality pulse, AI settings wiring, review queue integration.
- `src/SuggestionDiscussion.tsx`: reviewer brief and owner decision affordances.
- `src/ConflictResolution.tsx`: conflict summary display.
- `src/StudyView.tsx`: optional hint after miss.
- `src/ConnectAnkiWizard.tsx`: setup/sync diagnostic guidance.
- `src/AnalyticsDashboard.tsx` and `src/ActivityTimeline.tsx`: later digest and quality trend surfaces.

## Existing Patterns To Reuse

- Route-edge validation in `server/app.mjs`.
- Pure helper tests in `server/*.test.mjs`.
- Dual local/Supabase repository methods.
- Additive Supabase migrations in timestamp order.
- Owner Attention derivation in `src/App.tsx`.
- Existing review queue and comments in `src/SuggestionDiscussion.tsx`.
- Existing sync conflict review in `src/ConflictResolution.tsx`.
- Study progress persistence in `src/StudyView.tsx` and `src/sm2.ts`.

## Risks

- Repository drift if AI fields are implemented in Supabase but not local mode.
- AI latency in hot paths if generation is synchronous. Prefer explicit or async advisory generation.
- Privacy risk if raw deck content is sent without owner opt-in.
- JSON variability across 9Router provider models. Strict validation and fallback are required.
- Embedding dimension drift if models change. Store model ID and dimension.
- UX clutter in `src/App.tsx` if quality pulse, sync health, and review cards compete for attention.

## Test Surfaces

- `server/aiGateway.test.mjs`
- `server/routes.api.test.mjs`
- `server/domain.test.mjs`
- `server/supabaseRepository.test.mjs`
- `src/*.test.ts` or new focused Vitest files for derived UI state.
- `tests/e2e/deckbridge.spec.ts`
- `addons/deckbridge_sync/tests/test_addon.py` only for diagnostic payload changes.
