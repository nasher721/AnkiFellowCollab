---
name: 9router-deckbridge-ai
description: Implement DeckBridge AI owner-assist features through the server-side 9Router OpenAI-compatible gateway while preserving owner control and Anki card quality.
---

# 9Router DeckBridge AI

Use this skill when implementing AI assistance in DeckBridge.

## Gateway Contract

Treat 9Router as an optional server-side gateway.

Environment:

- `NINEROUTER_URL`: base gateway URL, for example `http://localhost:20128`.
- `NINEROUTER_KEY`: optional bearer token. Omit `Authorization` when unset.
- `NINEROUTER_CHAT_MODEL`: preferred chat model from `GET /v1/models`.
- `NINEROUTER_EMBEDDING_MODEL`: preferred embedding model from `GET /v1/models/embedding`.
- `DECKBRIDGE_AI_ENABLED`: deck AI feature gate, default false unless explicitly enabled.
- `DECKBRIDGE_AI_TIMEOUT_MS`: default 8000-15000 ms.
- `DECKBRIDGE_AI_MODEL_CACHE_TTL_MS`: default 5-15 minutes.

Endpoints:

- `GET /api/health`: readiness probe only.
- `GET /v1/models`: chat model discovery.
- `GET /v1/models/embedding`: embedding model discovery.
- `POST /v1/chat/completions`: non-streaming JSON advisory outputs.
- `POST /v1/embeddings`: semantic fingerprints for duplicate/search features.

## Implementation Rules

- Call 9Router only from the Express server. Never expose `NINEROUTER_KEY` in browser code.
- Discover models before use. A healthy gateway can still have no chat or embedding models.
- Cache discovery briefly, then re-check after failures so users can fix local 9Router without restarting DeckBridge.
- Use `response_format: { "type": "json_object" }` first. Validate parsed JSON locally with strict shape checks.
- Retry malformed JSON once with a repair prompt, then degrade gracefully.
- Store `model`, `promptVersion`, `inputHash`, `createdAt`, and validation status for every AI artifact.
- Keep AI advisory. It may summarize, classify, score, or draft suggestions; it must not silently edit cards, accept suggestions, merge duplicates, resolve conflicts, or alter sync results.
- Preserve full medical/study content. Do not shorten, omit, normalize, or rewrite canonical card fields unless the owner explicitly creates/approves a normal suggestion.
- If chat is unavailable, keep reviewer, conflict, setup, and study workflows usable without AI.
- If embeddings are unavailable, keep lexical card search and manual duplicate review usable.

## Recommended Release Order

1. Foundation: gateway client, feature flags, deck opt-in, audit schema, fallback UI.
2. Suggestion assist: reviewer briefs in the existing review queue.
3. Semantic duplicates: async embeddings and related-card indicators.
4. Conflict and diagnostics: advisory summaries grounded in structured local data.
5. Quality pulse: Owner Attention grouping and stale-analysis invalidation.
6. Later: study hints, owner digest, and comment summarization after the owner-control path is proven.

## Verification

Run the normal DeckBridge gate after implementation:

```bash
npm test
npm run test:api
npm run test:frontend
npm run build
npm run test:e2e
```

For add-on diagnostics changes, also run:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 addons/deckbridge_sync/tests/test_addon.py
npm run package:anki-addon
```
