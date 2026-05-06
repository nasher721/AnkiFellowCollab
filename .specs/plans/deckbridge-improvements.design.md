# DeckBridge Improvements Design

## Overview

Transform DeckBridge from a private collaboration tool into a versatile, feature-rich platform while eliminating the primary friction point: add-on setup complexity. This design addresses improvements across user experience, collaboration features, Anki integration, and platform capabilities through a phased approach.

**Phase 1:** Simplified add-on setup flow (eliminate setup friction)
**Phase 2:** Browser-based deck management (reduce Anki dependency)
**Phase 3:** Enhanced collaboration features (rich collaborative workflows)
**Phase 4:** Platform capabilities & discovery (public decks, analytics, templates)

---

## Section 1: Simplified Add-on Setup Flow

**Purpose:** Eliminate add-on setup friction by replacing manual URL/token/deck configuration with a guided 4-step wizard.

**The Flow:**

1. **Download** — User clicks "Connect Anki" in the web UI. DeckBridge serves the `.ankiaddon` file directly with a "Download & Install" button. Brief instructions show: "Open the file in Anki to install."

2. **Generate Token** — After installation, user clicks "Next" to generate a persistent API token. The web UI displays the token with a one-click copy button. A code block shows exactly where to paste it in the add-on's settings.

3. **Connect** — User pastes the token into the add-on's "DeckBridge Token" field and clicks "Test Connection." The add-on calls `GET /api/me` with the token to validate. Success shows user email and available decks.

4. **Map Decks** — User selects their local Anki deck from a dropdown (populated via AnkiConnect `deckNames`), then selects the target DeckBridge deck from a second dropdown (populated from `GET /api/decks`). They choose a conflict policy (detect/overwrite-platform) and click "Save." The add-on stores config locally and performs an initial pull.

**Architecture Changes:**
- New endpoint: `POST /api/tokens` generates persistent tokens stored in Supabase `user_tokens` table
- Web UI adds `ConnectAnkiWizard` component with step state management
- Add-on updated to validate token via `/api/me` and store config as JSON

---

## Section 2: Add-on Package & Auto-Config

**Purpose:** Make the add-on installation seamless and enable one-click configuration via URL scheme.

**Bundled Add-on Package:**
- DeckBridge serves the `.ankiaddon` file at `GET /api/addon/download` with proper `Content-Disposition: attachment` headers
- The web wizard's "Download" step shows a direct link: `<a href="/api/addon/download" download>` that triggers Anki's add-on installer
- Add-on version tracking: `GET /api/addon/version` returns latest version; add-on checks on startup and prompts upgrade if outdated
- Build process: `npm run package:anki-addon` outputs to `dist/deckbridge-sync.ankiaddon` and deploys to both local `dist/` and Vercel static assets

**Auto-Config URL Scheme:**
- Register `anki://deckbridge` URL scheme in the add-on's `__init__.py`
- Web UI generates: `anki://deckbridge?url={platformUrl}&token={token}&deckId={deckId}`
- When user clicks "Auto-Configure" button, the add-on:
  1. Parses URL parameters
  2. Validates token via `/api/me`
  3. Stores config automatically
  4. Shows success dialog with deck mapping options
- Fallback: If URL scheme fails (Anki not running), display manual copy-paste instructions

**Add-on Config Storage:**
- Config stored in Anki's `mw.col.conf` under `deckbridge` key:
  ```python
  {
    "url": "https://deckbridge.com",
    "token": "db_...",
    "deckMappings": [{"localDeck": "Spanish Vocab", "deckId": "abc123", "conflictPolicy": "detect"}],
    "autoSync": False
  }
  ```

---

## Section 3: Browser-Based Deck Management

**Purpose:** Reduce dependency on Anki desktop by enabling core deck operations directly in the web UI — card editing, browsing, and studying.

**Web-Based Card Editor:**
- New `CardEditor` component with Markdown-supported fields (front/back/extra)
- Inline editing mode: click any card in the browser to edit; changes create suggestions automatically
- Rich text toolbar: bold, italic, lists, images, and cloze deletion helpers
- Field validation: required fields highlighted, character count, media preview
- Keyboard shortcuts: `Ctrl+S` to save, `Esc` to cancel, `Ctrl+Enter` to submit suggestion

**Browser-Based Studying:**
- New "Study" view using spaced repetition algorithm (simplified SM-2)
- Cards displayed with flip animation; user rates difficulty (Again/Hard/Good/Easy)
- Session stats: cards remaining, accuracy rate, time spent
- Study queue pulls from approved cards only; suggestions appear after owner approval
- Progress stored per-user in Supabase `study_sessions` table

**Integration with Existing Workflow:**
- Edits made in browser automatically generate suggestions (same as Anki add-on)
- Deck owners see browser-created suggestions in the same triage interface
- Study progress syncs back to Anki on next pull (add-on adds `deckbridgeStudied` tag)
- Conflict detection: if card changed both in browser and Anki, owner sees both versions

**Architecture:**
- New routes: `/decks/:deckId/study`, `/decks/:deckId/edit/:cardId`
- New Supabase tables: `study_sessions`, `study_progress`
- Study algorithm runs client-side (lightweight SM-2 implementation)
- Card rendering uses same `parse-deck` library for consistency

---

## Section 4: Enhanced Collaboration Features

**Purpose:** Transform shallow suggestion workflows into rich collaborative experiences with discussions, roles, and notification systems.

**Suggestion Discussions:**
- Each suggestion gains a threaded comment system
- Users can `@mention` deck owners/editors; triggers in-app notifications
- Comment types: general feedback, alternative wording, source citations, flag for review
- Inline annotations: highlight specific text in card fields to comment on
- Reactions: quick emoji responses (👍, ❓, ✅) for rapid feedback

**Role-Based Permissions:**
- Expand beyond owner/editor to: viewer (read-only), reviewer (can approve/reject), contributor (can suggest), editor (can edit directly)
- Custom roles: deck owner creates named roles with specific permissions (e.g., "Subject Matter Expert" who can approve suggestions in specific tags)
- Role inheritance: org-level roles cascade to all decks in workspace
- Public decks: "Anyone with link" can view; "Signed-in users" can suggest

**Notification System:**
- In-app bell icon with unread count; dropdown shows recent activity
- Email notifications (configurable): suggestion submitted, decision made, comment added, deck shared
- Digest mode: daily/weekly summary of all deck activity
- Real-time updates via Supabase Realtime subscriptions on `suggestions` and `comments` tables

**Activity Dashboard:**
- New `/decks/:deckId/activity` view shows timeline of: suggestions, approvals, edits, comments, sync events
- Filters: by user, date range, action type, card tags
- Export activity log as CSV for record-keeping

**Architecture:**
- New tables: `comments` (threaded), `notifications`, `roles` (custom), `activity_log`
- Supabase Realtime channels: `deck:{deckId}:suggestions`, `deck:{deckId}:comments`
- Email via Supabase Edge Functions or webhook to email service

---

## Section 5: Platform Capabilities & Discovery

**Purpose:** Transform DeckBridge from a private collaboration tool into a discoverable platform where users can find, share, and analyze decks.

**Deck Discovery & Public Profiles:**
- Public deck gallery at `/discover` with search, filtering by tags, language, card count, last updated
- Deck cards show preview (3-5 sample cards), creator profile, download count, star rating
- Public profiles: `/u/{username}` shows user's public decks, contributions, reviewer status
- Featured decks: curated section highlighting high-quality, well-maintained decks
- Fork functionality: users can create a copy of a public deck to their workspace for private collaboration

**Deck Sharing & Embedding:**
- Shareable links with optional password protection for private decks
- Embed widget: `<iframe src="https://deckbridge.com/embed/deck/abc123">` for blogs/courses
- Export formats: `.apkg` (Anki), `.csv` (spreadsheets), PDF summary (card previews)
- Social features: star/favorite decks, follow creators, share to Twitter/LinkedIn

**Analytics Dashboard:**
- New `/decks/:deckId/analytics` with: suggestion acceptance rate, contributor leaderboard, card difficulty distribution
- Study analytics: retention rate, cards per day, struggling cards (shown to owners)
- Export analytics report as PDF for educators/institutions
- Privacy: analytics only visible to deck owners/editors unless marked public

**Deck Templates:**
- Template gallery: pre-structured decks (language learning, medical flashcards, coding interview prep)
- Templates include: predefined fields, card types, suggested tags, example cards
- Custom templates: users save their deck structure as reusable template
- Template marketplace: community-submitted templates with ratings

---

## Section 6: Architecture, Data Flow & Error Handling

**Purpose:** Define the technical foundation ensuring reliability, scalability, and maintainability across all new features.

**Overall Architecture:**
- **Frontend:** React 19 + TypeScript with component library (shadcn/ui or similar) for consistent UI
- **Backend:** Express API + Supabase (PostgreSQL, Auth, Realtime, Storage)
- **Add-on:** Python add-on using Anki's Qt hooks + requests library
- **State Management:** React Context for auth/deck state; React Query for API data fetching/caching
- **Build:** Vite 7 for web, esbuild for server, Anki's add-on packaging for the add-on

**Data Flow:**
1. **Setup Flow:** Web UI → `POST /api/tokens` → Supabase `user_tokens` → token displayed → add-on stores config → `GET /api/me` validates
2. **Browser Edit:** User edits card → `POST /api/decks/:id/suggestions` → Supabase `suggestions` → Realtime update to owner's view
3. **Study Session:** Client-side SM-2 algorithm → `POST /api/study/sessions` → Supabase `study_sessions` → sync to Anki on pull
4. **Notifications:** Database triggers on `suggestions/comments` → Supabase Edge Function → email/Realtime → in-app bell

**Error Handling:**
- **API Errors:** Standardized error response format `{error: {code, message, details}}` with appropriate HTTP status codes
- **Add-on Errors:** Graceful degradation — if sync fails, queue changes locally and retry on next connection
- **Study Progress:** Client-side persistence in `localStorage` as backup if API unreachable
- **Conflict Resolution:** Enhanced UI showing diffs between conflicting versions with 3-way merge option

**Testing Strategy:**
- **Unit Tests:** Expand `server/*.test.mjs` for new API endpoints, SM-2 algorithm, token generation
- **Integration Tests:** Expand `server/*.api.test.mjs` for authenticated flows with Supabase test DB
- **E2E Tests:** Expand Playwright tests for wizard flow, study mode, collaboration features
- **Add-on Tests:** Python unittest for config storage, API client, sync logic

---

## Implementation Priority

1. **Simplified Setup Flow** (Section 1 & 2) — eliminates primary friction point
2. **Browser-Based Card Editing** (partial Section 3) — biggest UX improvement
3. **Enhanced Collaboration** (Section 4) — drives retention and engagement
4. **Browser-Based Studying** (remainder of Section 3) — reduces Anki dependency
5. **Platform Discovery** (Section 5) — expands user base
6. **Analytics & Templates** (remainder of Section 5) — monetization and scaling
