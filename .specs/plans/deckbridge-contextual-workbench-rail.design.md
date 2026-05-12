# DeckBridge Contextual Workbench Rail Design

## Purpose

Reduce whole-workbench clutter by making the right rail contextual instead of permanent. The Deck Workbench should keep its familiar two-column desktop shape, but the rail should answer one question: what matters beside the current task?

Today the right rail carries broad owner attention, quality review counts, conflict warnings, and review entry points across the whole workbench. That makes Cards, Review, Study, Settings, and analytics surfaces feel crowded even when the rail content does not match the active task.

This design keeps the useful owner cues while removing duplicated pressure from non-overview tabs. It optimizes for a calmer, roomier workbench without changing sync, review, suggestion, or Supabase behavior.

## Product Direction

The Deck Workbench becomes a main work area plus an optional context rail. The rail changes with the active tab:

- Overview: show owner-level attention and broad next actions.
- Cards: show selected-card context, preview, metadata, and linked actions.
- Review: give the review workspace full visual priority; hide the rail or limit it to queue/filter support.
- Study, Stats, Analytics, Activity, Settings, and Models: collapse the rail by default unless there is useful contextual content.

The workbench should stop showing every owner cue everywhere. Overview owns the summary. Review owns the decision workflow. Cards owns card-level context. Other tabs get horizontal space.

## Approaches Considered

### Recommended: Contextual Right Rail

Probability: `0.88`

Keep the rail, but derive its content from the active tab and selection. This preserves the current desktop pattern while removing unrelated content from focused work modes. It gives Cards and Review clearer jobs without a full navigation rewrite.

### Collapsible Owner Rail

Probability: `0.85`

Keep the current rail mostly unchanged and let users collapse it. This is safer but weaker: the app still treats broad owner attention and quality review as universal side content.

### Move Review Summary Into Tabs

Probability: `0.82`

Remove quality review from the rail and keep it only in Review. This reduces duplication, but it does not solve card-level context or non-review rail clutter.

### Floating Attention Tray

Probability: `0.09`

Replace the rail with a drawer opened from an attention button. This cleans the layout but hides important owner work behind an extra interaction.

### Overview-Only Rail

Probability: `0.07`

Show the rail only on Overview and make every other tab full width. This is very clean, but Cards loses a natural place for preview and selected-card actions.

### Status Strip And Command Palette

Probability: `0.04`

Remove the rail and move context into compact status plus command search. This may be elegant later, but it is too indirect for the current owner workflow.

## Interaction Model

The workbench keeps the current top-level sidebar, deck header, and tab model. The primary change is the relationship between the tab and the right rail.

On Overview, the rail remains the owner triage surface. It shows `OwnerAttentionPanel`, sync proof, pending review pressure, conflict status, visibility, and study readiness. This is the right place for "what needs attention?" because Overview is already a summary screen.

On Cards, the rail becomes selected-card context. It should show rendered front/back preview when possible, note type, tags, due/state metadata, pending suggestion state, and primary actions for the selected card. If a pending suggestion is attached, the rail links directly into Review with that item selected.

On Review, the rail should not compete with rendered comparison, raw diffs, discussion, and decision controls. The Review Workspace should usually render full width. If the rail remains visible, it should be narrow and limited to queue status or filters, never duplicate the inspection panel or owner attention.

On Study, Stats, Analytics, Activity, Settings, and Models, the rail collapses by default. Those tabs mostly need horizontal space and clear hierarchy. A blank rail is worse than no rail.

## Component Design

Add a small layout boundary rather than a broad rewrite.

`WorkbenchLayout` owns the main region and optional context rail. It receives an `activeRail` descriptor and applies the correct grid class: two-column, full-width, or collapsed.

`ContextRail` renders one rail surface at a time. It should not know deck business rules. It receives a type and props derived by `App.tsx` or a small helper.

`OverviewRail` keeps the existing owner attention content and a compact quality-review entry point. It should not render full review details.

`CardRail` is new. It renders selected-card preview, metadata, pending suggestion status, and selected-card actions. It should use existing card rendering helpers and existing edit/suggestion handlers.

`ReviewRail` is optional. If used, it should be limited to review queue status, active filter summary, or collapse controls. The main `ReviewWorkspace` remains the primary review surface.

`CollapsedRailHandle` appears when rail content exists but is hidden due to viewport size or user collapse. It shows a concise label and badge count, with an accessible name that says what will open.

The existing `OwnerAttentionPanel` should remain, but only inside `OverviewRail` unless a later product decision gives it a specific role elsewhere.

## Data And State

The first pass should derive all rail behavior on the frontend. No database migration, server route, or dependency is needed.

Required inputs already exist in `App.tsx`:

- `activeTab`
- `activeDeck`
- `selectedCard`
- `selectedSuggestion`
- `selectedOwnerQueueItem`
- `ownerAttentionItems`
- `syncHealth`
- `reviewBucketCounts`
- `state.sync.conflicts`
- `canReview`, `canSuggest`, and `canManageDeck`

The new state should stay minimal:

- `railCollapsed`, if the user can hide visible rail content.
- Optional tab-local memory if the rail should remember collapse preference per tab.

Avoid a new workbench state machine. Switching tabs should derive the rail. Selecting a card should update the Cards rail. Entering Review should prioritize the full review workspace.

## Error And Empty States

Errors should appear where recovery happens.

If sync is down or a token fails, Overview rail shows the recovery action. If selected-card rendering fails, Cards rail shows raw field fallback instead of an empty preview. If a selected card has a pending suggestion, Cards rail links to Review with that item selected. If unresolved conflicts block push-back, Review owns that warning because the conflict decision happens there.

Empty states should stay quiet:

- Cards with no selected card: prompt the user to select a card.
- Overview with no urgent work: show the clear owner state.
- Review with no matching items: show the review-empty state in the main Review Workspace.
- Non-context tabs: use full width instead of showing an empty rail.

## Safeguards

The layout change should not alter product behavior.

Do not change sync APIs, suggestion decisions, conflict resolution, card rendering semantics, Supabase queries, authentication, or Anki add-on behavior. The first implementation slice should only change layout composition and rail placement.

Do not add a UI framework or dependency. Reuse current React components, CSS tokens, and existing button, tab, and panel patterns.

Do not bury critical owner warnings. If the rail is collapsed, unresolved conflicts and pending review counts still need visible badges or links from Overview and Review.

## Testing Strategy

Use focused frontend coverage for rail derivation and layout states:

- Overview chooses `OverviewRail`.
- Cards chooses `CardRail` when a deck is loaded.
- Review chooses full-width review or review-specific rail behavior.
- Study, Stats, Analytics, Activity, Settings, and Models default to full-width without an empty rail.
- Selected-card changes update Cards rail content.
- Card-linked pending suggestions navigate to the matching Review item.

Add Playwright checks for desktop and narrow viewports:

1. Open the workbench on Overview and verify owner attention is in the rail.
2. Switch to Cards and verify the rail shows selected-card context, not the quality review summary.
3. Switch to Review and verify the review workspace gains horizontal priority.
4. Switch to Settings or Analytics and verify the main panel is not squeezed by an empty rail.
5. At the mobile breakpoint, verify rail content stacks or collapses without breaking card-table scanning.

The expected verification gate for implementation is:

```bash
npm run test:frontend
npm run build
npm run test:e2e
```

If the full e2e suite is too slow during iteration, run a focused workbench-layout Playwright spec first, then run the standard gate before commit.

## Scope Boundaries

In scope:

- Introduce contextual rail behavior in the Deck Workbench.
- Move broad owner attention to Overview.
- Add selected-card context for Cards.
- Give Review the full width it needs for quality decisions.
- Collapse or remove the rail from non-context tabs.
- Improve responsive behavior for rail content.

Out of scope:

- New backend persistence.
- New Supabase migrations.
- New sync or add-on behavior.
- New UI dependencies.
- A complete navigation rewrite.
- New analytics or marketplace surfaces.

## Implementation Notes

Start with a small frontend slice:

1. Extract the current `content-grid` layout into `WorkbenchLayout`.
2. Add a helper that derives rail type from `activeTab` and selected state.
3. Move `OwnerAttentionPanel` and the compact quality review entry into `OverviewRail`.
4. Create `CardRail` using existing selected-card data and rendering helpers.
5. Let Review render full width, then add a narrow review rail only if it proves useful.
6. Adjust CSS grid classes and responsive behavior.
7. Add focused tests before visual polish.

Keep the diff reversible. The goal is cleaner spatial ownership, not new product logic.
