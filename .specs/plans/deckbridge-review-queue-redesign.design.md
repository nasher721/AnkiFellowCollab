# DeckBridge Review Queue Redesign

## Purpose

DeckBridge's Review Queue should help a deck owner protect card quality before changes land back in Anki. The current workbench already has the core pieces: cards, suggestions, conflicts, rendered Anki previews, comments, AI owner assist, and push controls. The redesign should make those pieces feel like one quality review workflow instead of a dense right sidebar.

This design optimizes for **card quality confidence**. Before accepting a suggestion, the owner should understand what changed, whether the rendered card still works, whether source review is needed, and whether the change is safe to push.

## Product Direction

The Review Queue becomes a focused **Quality Review Workspace**. The owner starts with a summary of risk buckets, chooses the next item, inspects a rendered before-and-after card comparison, checks raw field and tag changes, then decides.

The queue should answer five questions:

1. Did this change alter the answer, only the wording, only tags, or the template/rendering?
2. Does the rendered Anki card still look correct?
3. Does the change need a source check before approval?
4. Will this decision affect the next Anki pull or push?
5. Are unresolved sync conflicts blocking safe push-back to Anki?

This is not a separate dashboard. It is the review mode inside the Deck Workbench.

## Approaches Considered

### Recommended: Quality Review Workspace

Probability: `0.88`

Move deep review out of the cramped right rail and into a purpose-built inspection surface. The queue stays compact, while the selected item gets enough space for rendered previews, diffs, source-check cues, discussion, and decisions.

### Incremental Sidebar Cleanup

Probability: `0.84`

Keep the right panel in place, improve spacing, and add risk labels. This is low risk but leaves the central problem intact: high-stakes card review remains squeezed beside the table.

### Review Queue As Main Landing Page

Probability: `0.81`

Make pending review the default owner landing page whenever decisions exist. This is attractive later, but it may make card browsing and setup feel secondary too early.

### Mobile-First Review Sheet

Probability: `0.09`

Design the review experience primarily as a full-screen mobile sheet, then adapt it to desktop. This improves phones but underuses desktop width, where owners likely do deep review.

### AI-Centered Quality Judge

Probability: `0.06`

Put AI scoring, rationale, and recommendations at the top of every review item. This could help later, but it should remain advisory because the owner is the quality gate.

### Kanban Review Board

Probability: `0.04`

Split suggestions into lanes such as `Needs source`, `Ready`, `Revision`, and `Accepted`. This adds management overhead before the product has enough review volume to justify it.

## Interaction Model

The review flow separates choosing from judging.

The owner first sees a compact quality summary with risk buckets: `Answer changed`, `Source check`, `Tag-only`, `Formatting/render`, and `Sync conflict`. Each bucket is a filter. The owner can start with high-risk changes, clear tag-only cleanup later, or focus on conflicts before pushing.

The queue list shows one row per decision. Each row includes the card prompt, author, age, status, affected fields, and deterministic quality labels. It should not show full diffs. The list's job is selection and triage.

Selecting a queue item opens the inspection surface. On desktop, the inspection surface should occupy the main work area when review mode is active. The card table can remain available as context behind the `Cards` tab or collapse to a slimmer list. On mobile, selection opens a full-screen review sheet with sticky decision buttons.

The normal path is:

`quality bucket -> queue item -> rendered comparison -> raw changes/source notes -> decision -> next item`

## Component Design

`ReviewWorkspace` should own the redesigned review experience. It receives the active deck, suggestions, conflicts, AI artifacts, selected filters, and decision handlers from the app shell.

`ReviewQualitySummary` renders risk buckets and counts. Buckets are filters, not decorative metrics.

`ReviewQueueList` renders pending items with prompt, author, age, status, changed fields, and quality labels.

`ReviewInspectionPanel` renders the selected item's current and proposed cards, tags, raw field changes, source-check state, discussion, and conflict-specific controls.

`ReviewDecisionBar` stays visible at the bottom of the inspection surface. It exposes `Accept`, `Request revision`, `Reject`, and `Mark needs source check` for suggestions. For conflicts, it exposes source-of-truth actions rather than suggestion language.

`ReviewRiskBadge` renders deterministic labels such as `Answer changed`, `Tag-only`, `Render risk`, `Needs source check`, and `Conflict`.

The existing `OwnerAttentionPanel` should become an entry point into review, not a competing review surface. It can show urgent review counts and jump to the filtered `ReviewWorkspace`.

## Data And State

The first implementation should derive review data on the frontend without a database migration. Existing data already contains enough signal: suggestions, cards, conflicts, AI artifacts, comments, rendered card HTML, tags, field values, and sync state.

Create a richer derived review model:

```ts
interface QualityReviewItem {
  id: string;
  kind: 'suggestion' | 'conflict' | 'ai' | 'recent-change';
  cardId?: string;
  suggestionId?: string;
  conflictId?: string;
  authorName?: string;
  status: 'pending' | 'revision' | 'accepted' | 'rejected';
  changedFields: string[];
  changedTags: boolean;
  labels: ReviewRiskLabel[];
  risk: 'low' | 'medium' | 'high';
  needsSourceCheck: boolean;
  affectsNextPull: boolean;
  blocksPush: boolean;
}
```

Risk should be deterministic first. Answer-bearing fields, back fields, cloze text, template fields, rendered HTML failures, and conflicts are higher risk. Tag-only and wording-only edits are lower risk. AI owner assist can add advisory context, but the queue must work without AI.

UI state should remain small: selected review item, risk filter, status filter, author filter, review tab, and source-check marker. A later backend pass can persist a first-class `needsSourceCheck` flag if owners use it often. Until then, the UI can express it through revision decisions or comments.

## Rendering And Comparison

The inspection panel should lead with rendered Anki previews. Current and proposed cards should show front and back states side by side on desktop and stacked on mobile. The design should favor readable card content over dense metadata.

Raw diffs belong below rendered previews. They should show changed fields, tag changes, template changes, and media references. If a suggestion changes only tags, the rendered preview can collapse by default and the tag diff can lead.

Render failures must be visible. If current or proposed rendering fails, the panel should show `Render unavailable`, explain that raw field diffs are being used, and downgrade the primary action away from a quiet accept.

## Safeguards

The review UI should be conservative around quality.

Answer changes, cloze edits, template edits, media changes, and conflicts should carry clear warning labels. When an item needs source review, `Accept` should not be the dominant visual action. The owner should see `Mark checked`, `Request revision`, or `Reject` as safer next steps.

Conflicts should share the workspace but use different language. Suggestions ask, `Should this proposed change become canonical?` Conflicts ask, `Which source of truth should win?` The UI should avoid treating those as the same decision.

`Push to Anki` should remain blocked when unresolved conflicts could overwrite local or DeckBridge edits. The disabled state should state the reason and link to the relevant conflict filter.

## Empty And Error States

Empty states should keep the owner oriented:

- No pending review items: show the queue is clear and offer card browsing or study.
- No high-risk changes: explain that only lower-risk review items remain.
- No source checks: show source review is clear.
- Render unavailable: show raw diffs and warn before accepting.
- Conflict queue empty: show push-back is no longer blocked by conflicts.

Error states should name the failed step and give a recovery action. Comment loading, AI brief loading, rendered card preview, and decision submission can fail independently without collapsing the whole review workspace.

## Testing Strategy

Frontend unit tests should cover deterministic risk labels, review model derivation, filter behavior, selected-item transitions, source-check state, disabled push states, and conflict-specific decision labels.

Component tests should cover `ReviewQualitySummary`, `ReviewQueueList`, `ReviewInspectionPanel`, and `ReviewDecisionBar` with suggestion, conflict, tag-only, answer-change, and render-failure fixtures.

Playwright should cover the owner review path on desktop and mobile:

1. Open the workbench with pending suggestions.
2. Filter to `Answer changed`.
3. Select a queue item.
4. Verify rendered current and proposed previews are visible.
5. Request revision or accept.
6. Verify the next item is selected or the queue-empty state appears.
7. Verify unresolved conflicts block `Push to Anki`.

The standard verification gate for an implementation pass should include:

```bash
npm run test:frontend
npm run build
npm run test:e2e
```

## Scope Boundaries

In scope:

- Redesign the review queue around quality confidence.
- Derive deterministic risk labels and filters from existing data.
- Promote rendered card comparison as the primary inspection surface.
- Add conflict-specific language and blocking states.
- Improve mobile review with a full-screen inspection sheet.

Out of scope:

- New dependencies or a new UI framework.
- Backend persistence for source-check flags in the first pass.
- AI as a required reviewer.
- Replacing the existing sync, suggestion, or comment APIs.
- Marketplace, public deck, or analytics redesign.

## Implementation Notes

Start with the frontend model and component extraction. Keep behavior compatible with existing suggestion decisions, comments, rendered Anki previews, AI artifacts, and sync conflict handling.

The safest first slice is read-only UI structure: derive `QualityReviewItem`, render risk filters, and preserve existing accept/reject/revision behavior. The second slice can move inspection into a larger review workspace. The third slice can improve mobile review and Playwright coverage.
