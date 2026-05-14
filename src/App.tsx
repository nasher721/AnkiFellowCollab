import { type FormEvent, type ReactNode, useMemo, useState, useEffect, useCallback, memo } from 'react';
import { api } from './api';
import type { AiArtifact, AppState, Deck, DeckCard, Suggestion } from './types';
import {
  type Toast, type SyncHealth, type OwnerAttentionItem, type WorkbenchRailKind,
  initials, relativeTime, fieldValue, statusColors, TOAST_ICONS, supabase,
} from './hooks/common';
import { useDeckOperations } from './hooks/useDeckOperations';
import { useReviewQueue } from './hooks/useReviewQueue';
import { useSyncState } from './hooks/useSyncState';
import { useRealtime } from './useRealtime';
import { ConnectAnkiWizard } from './ConnectAnkiWizard';
import { CardVirtualList } from './CardVirtualList';
import { StudyView } from './StudyView';
import { SuggestionDiscussion } from './SuggestionDiscussion';
import { NotificationsBell } from './NotificationsBell';
import { DiscoverView } from './DiscoverView';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import { ActivityTimeline } from './ActivityTimeline';
import { TemplateGallery } from './TemplateGallery';
import { ConflictResolution, type Conflict } from './ConflictResolution';
import { DeckSettingsView } from './views/DeckSettingsView';
import { DeckStatsView } from './views/DeckStatsView';
import { StudyPrepView } from './views/StudyPrepView';
import { AnkiCardRenderer, renderCardHtml } from './AnkiCardRenderer';
import {
  deriveOwnerReviewQueue,
  deriveReviewBucketCounts,
  reviewItemMatchesBucket,
  selectCardForReview,
  selectSuggestionForReview,
  type QualityReviewItem,
  type ReviewBucket,
  type ReviewRiskLabel
} from './reviewModel';
export { deriveOwnerReviewQueue, deriveReviewBucketCounts, reviewItemMatchesBucket, selectCardForReview, selectSuggestionForReview } from './reviewModel';
export { authMessage, deriveOwnerAttentionItems, deriveSyncHealth, deriveWorkbenchRail, mergeHydratedDeckState, stateFromMeResponse, withAuthTimeout } from './hooks/common';
export type { OwnerAttentionItem, OwnerReviewQueueItem, SyncHealth, WorkbenchRailKind, WorkbenchTab } from './hooks/common';





const Icon = memo(function Icon({ name }: { name: 'upload' | 'download' | 'sync' | 'search' | 'filter' | 'cards' | 'users' | 'check' | 'x' | 'spark' | 'moon' | 'sun' }) {
  const paths = {
    upload: 'M12 3v12m0-12 4 4m-4-4-4 4M4 17v3h16v-3',
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3',
    sync: 'M20 7h-5a5 5 0 0 0-8-2M4 17h5a5 5 0 0 0 8 2M20 7V3m0 4h-4M4 17v4m0-4h4',
    search: 'M10.5 18a7.5 7.5 0 1 1 5.3-12.8 7.5 7.5 0 0 1-5.3 12.8Zm5.5-2 4 4',
    filter: 'M4 6h16M7 12h10M10 18h4',
    cards: 'M4 7h16v12H4zM7 4h10',
    users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20a6 6 0 0 1 12 0M14 20a5 5 0 0 1 7-4.5',
    check: 'm5 13 4 4L19 7',
    x: 'M6 6l12 12M18 6 6 18',
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
    moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    sun: 'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z'
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="icon">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
});

function AuthScreen({
  authMode,
  authEmail,
  authPassword,
  authBusy,
  authNotice,
  onSubmit,
  onEmailChange,
  onPasswordChange,
  onToggleMode
}: {
  authMode: 'sign-in' | 'sign-up';
  authEmail: string;
  authPassword: string;
  authBusy: boolean;
  authNotice: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onToggleMode: () => void;
}) {
  const isSignIn = authMode === 'sign-in';
  return (
    <div className="auth-screen">
      <section className="auth-hero" aria-label="DeckBridge sign in">
        <div className="auth-visual" aria-hidden="true">
          <div className="auth-visual-ribbon ribbon-a" />
          <div className="auth-visual-ribbon ribbon-b" />
          <div className="auth-visual-ribbon ribbon-c" />
          <div className="auth-preview-card preview-owner">
            <span>Owner review</span>
            <strong>12 changes ready</strong>
            <em>ABPN NCC deck</em>
          </div>
          <div className="auth-preview-card preview-sync">
            <span>Anki bridge</span>
            <strong>Dry-run passed</strong>
            <em>285 notes scanned</em>
          </div>
          <div className="auth-preview-card preview-source">
            <span>Source-backed edits</span>
            <strong>3 conflicts held</strong>
            <em>No silent overwrites</em>
          </div>
          <div className="auth-lattice">
            {Array.from({ length: 28 }, (_, index) => <i key={`lattice-${index}`} />)}
          </div>
        </div>
        <div className="auth-copy">
          <div className="auth-brandline">
            <span className="brand-mark"><Icon name="cards" /></span>
            <span>DeckBridge</span>
          </div>
          <h1>Bring every Anki deck review into one calm command center.</h1>
          <p>
            Sync from Anki, review collaborator edits, protect source-backed cards, and keep the owner in control before changes land.
          </p>
          <div className="auth-proof-strip" aria-label="DeckBridge highlights">
            <span><Icon name="sync" /> Local add-on sync</span>
            <span><Icon name="users" /> Study group review</span>
            <span><Icon name="check" /> Owner approval</span>
          </div>
        </div>
      </section>

      <section className="auth-panel" aria-label={isSignIn ? 'Sign in to DeckBridge' : 'Create a DeckBridge account'}>
        <div className="auth-panel-heading">
          <span className="auth-kicker">{isSignIn ? 'Welcome back' : 'Start your workspace'}</span>
          <h2>{isSignIn ? 'Sign in to DeckBridge' : 'Create your DeckBridge account'}</h2>
          <p className="auth-subtitle">
            {isSignIn
              ? 'One account unlocks the web workspace and the Anki add-on token flow.'
              : 'Create an account, then let DeckBridge issue the add-on credential for Anki.'}
          </p>
        </div>
        <form className="auth-form" onSubmit={onSubmit}>
          <label>
            <span>Email</span>
            <input
              aria-label="Email"
              autoComplete="email"
              placeholder="you@example.com"
              type="email"
              value={authEmail}
              onChange={(event) => onEmailChange(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              aria-label="Password"
              autoComplete={isSignIn ? 'current-password' : 'new-password'}
              placeholder="Enter your password"
              type="password"
              minLength={6}
              value={authPassword}
              onChange={(event) => onPasswordChange(event.target.value)}
              required
            />
          </label>
          <button className="button primary auth-submit" type="submit" disabled={authBusy}>
            {authBusy ? 'Working...' : isSignIn ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button className="auth-switch" type="button" onClick={onToggleMode}>
          {isSignIn ? 'Create a new DeckBridge account' : 'Use an existing DeckBridge account'}
        </button>
        {authNotice ? <p className="auth-notice" role="alert">{authNotice}</p> : null}
      </section>
    </div>
  );
}

const EmptyState = memo(function EmptyState({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
});

function SyncHealthStrip({ health, onAction }: { health: SyncHealth; onAction: (action: SyncHealth['primaryAction']) => void }) {
  return (
    <div className={`sync-strip sync-strip--${health.tone}`} aria-label="Sync health">
      <span className={`sync-light ${health.tone === 'success' ? 'on' : ''}`} />
      <div className="sync-strip-main">
        <strong>{health.title}</strong>
        <small>{health.packageLabel} · {health.deckLabel} · {health.localDeckLabel}</small>
      </div>
      <span className={`sync-badge sync-badge--${health.tone}`}>{health.badge}</span>
      <small className="sync-strip-detail">
        {health.state === 'dry-run-passed'
          ? health.detail
          : `Checked ${health.lastCheckedLabel} · Last success ${health.lastSyncedLabel} · ${health.conflictLabel}`}
      </small>
      <button className="icon-button" title={health.primaryLabel} onClick={() => onAction(health.primaryAction)}>
        <Icon name={health.primaryAction === 'conflicts' ? 'x' : 'sync'} />
      </button>
    </div>
  );
}

function OwnerAttentionPanel({
  items,
  onDismissArtifact,
  onAction,
  syncHealth
}: {
  items: OwnerAttentionItem[];
  onDismissArtifact?: (artifactId: string) => void;
  onAction: (item: OwnerAttentionItem) => void;
  syncHealth: SyncHealth;
}) {
  return (
    <section className="owner-attention" aria-label="Owner attention">
      <div className="owner-attention-heading">
        <strong>Owner Attention</strong>
        <span className={`sync-badge sync-badge--${syncHealth.tone}`}>{syncHealth.badge}</span>
      </div>
      <div className="owner-sync-proof">
        <span>{syncHealth.packageLabel}</span>
        <span>{syncHealth.lastCheckedLabel === 'Not yet' ? 'No bridge check yet' : `Checked ${syncHealth.lastCheckedLabel}`}</span>
      </div>
      {items.length ? (
        <div className="attention-list">
          {items.map((item) => (
            <div
              key={item.id}
              style={{ display: 'grid', gridTemplateColumns: item.artifactId ? '1fr 34px' : '1fr', gap: 6, alignItems: 'stretch' }}
              role="group"
              aria-label={`Attention item: ${item.label}`}
            >
              <button
                type="button"
                className={`attention-item attention-item--${item.tone}`}
                aria-label={`Open attention item: ${item.label}`}
                onClick={() => onAction(item)}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <b>{item.actionLabel}</b>
              </button>
              {item.artifactId ? (
                <button
                  type="button"
                  className="icon-button"
                  title="Dismiss AI artifact"
                  aria-label={`Dismiss AI artifact: ${item.label}`}
                  onClick={() => onDismissArtifact?.(item.artifactId!)}
                >
                  <Icon name="x" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="attention-clear">
          <Icon name="check" />
          <span>
            <strong>Owner queue clear</strong>
            <small>Sync, review, and study readiness have no urgent blockers.</small>
          </span>
        </div>
      )}
    </section>
  );
}

function WorkbenchLayout({
  railKind,
  rail,
  children
}: {
  railKind: WorkbenchRailKind;
  rail?: ReactNode;
  children: ReactNode;
}) {
  const hasRail = railKind !== 'none' && Boolean(rail);
  return (
    <div className={`content-grid content-grid--${hasRail ? 'with-rail' : 'full'} content-grid--rail-${railKind}`}>
      <section className="deck-panel">
        {children}
      </section>
      {hasRail ? (
        <aside className={`review-panel context-rail context-rail--${railKind}`} aria-label="Workbench context">
          {rail}
        </aside>
      ) : null}
    </div>
  );
}

function OverviewRail({
  ownerAttentionItems,
  syncHealth,
  reviewCount,
  reviewBucketCounts,
  conflictCount,
  onDismissArtifact,
  onOwnerAction,
  onOpenReviewBucket,
  onOpenReview
}: {
  ownerAttentionItems: OwnerAttentionItem[];
  syncHealth: SyncHealth;
  reviewCount: number;
  reviewBucketCounts: ReturnType<typeof deriveReviewBucketCounts>;
  conflictCount: number;
  onDismissArtifact: (artifactId: string) => void;
  onOwnerAction: (item: OwnerAttentionItem) => void;
  onOpenReviewBucket: (bucket: ReviewBucket) => void;
  onOpenReview: () => void;
}) {
  return (
    <>
      <OwnerAttentionPanel
        items={ownerAttentionItems}
        onDismissArtifact={onDismissArtifact}
        syncHealth={syncHealth}
        onAction={onOwnerAction}
      />
      <section className="review-entry-card">
        <div className="review-heading">
          <strong>Quality Review <span>{reviewCount}</span></strong>
        </div>
        <div className="review-entry-grid">
          <button type="button" onClick={() => onOpenReviewBucket('answer')}>
            <small>Answer changed</small>
            <strong>{reviewBucketCounts.answer}</strong>
          </button>
          <button type="button" onClick={() => onOpenReviewBucket('source')}>
            <small>Source check</small>
            <strong>{reviewBucketCounts.source}</strong>
          </button>
          <button type="button" onClick={() => onOpenReviewBucket('conflict')}>
            <small>Sync conflict</small>
            <strong>{reviewBucketCounts.conflict}</strong>
          </button>
        </div>
        <button className="button primary review-open-button" type="button" onClick={onOpenReview}>
          Open review workspace
        </button>
        {conflictCount > 0 ? (
          <small className="conflict-block-rationale">
            Push blocked because unresolved sync conflicts could overwrite local Anki or DeckBridge edits.
          </small>
        ) : <small className="review-entry-clear">No sync conflicts are blocking push-back.</small>}
      </section>
    </>
  );
}

function CardRail({
  deckId,
  card,
  pendingSuggestion,
  duplicateCount,
  canSuggest,
  onEditCard,
  onOpenSuggestion
}: {
  deckId: string;
  card?: DeckCard;
  pendingSuggestion?: Suggestion;
  duplicateCount: number;
  canSuggest: boolean;
  onEditCard: (cardId: string) => void;
  onOpenSuggestion: (suggestion: Suggestion) => void;
}) {
  if (!card) {
    return (
      <section className="card-context-card" aria-label="Selected card context">
        <div className="card-context-heading">
          <span>Card Context</span>
          <strong>Select a card</strong>
        </div>
        <p className="card-context-empty">Choose a row in Cards to inspect rendered preview, note metadata, and linked review work.</p>
      </section>
    );
  }

  const frontHtml = renderCardHtml(card, deckId, 'front', undefined, card.clozeOrd);
  const visibleTags = card.tags.slice(0, 5);

  return (
    <section className="card-context-card" aria-label="Selected card context">
      <div className="card-context-heading">
        <span>Card Context</span>
        <strong>{fieldValue(card, 'Front') || Object.values(card.fields)[0] || card.id}</strong>
      </div>

      <div className="card-context-preview" aria-label="Selected card preview">
        <small>Rendered preview</small>
        <span className="card-preview-side-label">Front</span>
        <AnkiCardRenderer card={card} deckId={deckId} side="front" />
        <span className="card-preview-side-label">Back</span>
        <AnkiCardRenderer card={card} deckId={deckId} side="back" frontHtml={frontHtml} />
      </div>

      <dl className="card-context-meta">
        <div><dt>Note type</dt><dd>{card.modelName || card.type}</dd></div>
        <div><dt>State</dt><dd><b className={`state-chip ${statusColors[card.state] || 'neutral'}`}>{card.state}</b></dd></div>
        <div><dt>Due</dt><dd>{card.due ?? '-'}</dd></div>
        <div><dt>Modified</dt><dd>{relativeTime(card.modifiedAt)} by {card.modifiedBy}</dd></div>
        <div><dt>Anki note</dt><dd>{card.ankiNoteId ?? card.id}</dd></div>
      </dl>

      <div className="card-context-tags" aria-label="Selected card tags">
        {visibleTags.length ? visibleTags.map((tag) => <em key={tag}>{tag}</em>) : <small>No tags</small>}
        {card.tags.length > visibleTags.length ? <small>+{card.tags.length - visibleTags.length} more</small> : null}
      </div>

      {pendingSuggestion ? (
        <div className="card-context-linked-review">
          <small>Pending suggestion</small>
          <strong>{pendingSuggestion.authorName}</strong>
          <span>{pendingSuggestion.reason || 'Review proposed card changes.'}</span>
          <button className="button secondary" type="button" onClick={() => onOpenSuggestion(pendingSuggestion)}>
            Open in Review
          </button>
        </div>
      ) : null}

      {duplicateCount > 0 ? (
        <small className="card-context-signal">{duplicateCount} related or duplicate candidate{duplicateCount === 1 ? '' : 's'} linked to this card.</small>
      ) : null}

      {canSuggest ? (
        <button className="button primary card-context-action" type="button" onClick={() => onEditCard(card.id)}>
          Suggest edit
        </button>
      ) : null}
    </section>
  );
}

const REVIEW_BUCKETS: Array<{ key: ReviewBucket; label: string; detail: string }> = [
  { key: 'all', label: 'All review', detail: 'Every item' },
  { key: 'answer', label: 'Answer changed', detail: 'Check facts' },
  { key: 'source', label: 'Source check', detail: 'Needs evidence' },
  { key: 'tag', label: 'Tag-only', detail: 'Cleanup' },
  { key: 'render', label: 'Formatting/render', detail: 'Preview risk' },
  { key: 'conflict', label: 'Sync conflict', detail: 'Blocks push' }
];

const ReviewRiskBadge = memo(function ReviewRiskBadge({ label }: { label: ReviewRiskLabel }) {
  const className = label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '');
  return <span className={`review-risk-badge review-risk-badge--${className}`}>{label}</span>;
});

const ReviewQualitySummary = memo(function ReviewQualitySummary({
  activeBucket,
  counts,
  onBucketChange
}: {
  activeBucket: ReviewBucket;
  counts: Record<ReviewBucket, number>;
  onBucketChange: (bucket: ReviewBucket) => void;
}) {
  return (
    <div className="review-quality-summary" aria-label="Quality review buckets">
      {REVIEW_BUCKETS.map((bucket) => (
        <button
          key={bucket.key}
          type="button"
          className={`review-bucket ${activeBucket === bucket.key ? 'active' : ''}`}
          onClick={() => onBucketChange(bucket.key)}
          aria-pressed={activeBucket === bucket.key}
        >
          <span>{bucket.label}</span>
          <strong>{counts[bucket.key]}</strong>
          <small>{bucket.detail}</small>
        </button>
      ))}
    </div>
  );
});

const ReviewQueueList = memo(function ReviewQueueList({
  items,
  selectedItem,
  suggestions,
  cards,
  sourceCheckByReviewItem,
  canReview,
  selectedSuggestionIds,
  onSelect,
  onToggleSuggestion
}: {
  items: QualityReviewItem[];
  selectedItem?: QualityReviewItem;
  suggestions: Suggestion[];
  cards: DeckCard[];
  sourceCheckByReviewItem: Record<string, 'needs' | 'checked'>;
  canReview: boolean;
  selectedSuggestionIds: Set<string>;
  onSelect: (item: QualityReviewItem) => void;
  onToggleSuggestion: (suggestionId: string) => void;
}) {
  if (!items.length) {
    return <EmptyState message="No quality review items match the current filters." />;
  }

  return (
    <div className="quality-queue-list" aria-label="Quality review queue">
      {items.map((item) => {
        const suggestion = item.suggestionId ? suggestions.find((candidate) => candidate.id === item.suggestionId) : undefined;
        const card = item.cardId ? cards.find((candidate) => candidate.id === item.cardId) : undefined;
        const prompt = reviewCardPrompt(card);
        const affected = affectedFieldsLabel(item);
        const sourceStatus = sourceCheckLabel(item, sourceCheckByReviewItem[item.id]);
        return (
          <div className={`quality-queue-item ${item.id === selectedItem?.id ? 'active' : ''}`} key={item.id}>
            {canReview && suggestion?.status === 'pending' ? (
              <input
                type="checkbox"
                className="queue-select"
                checked={selectedSuggestionIds.has(suggestion.id)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation();
                  onToggleSuggestion(suggestion.id);
                }}
                aria-label={`${selectedSuggestionIds.has(suggestion.id) ? 'Deselect' : 'Select'} ${suggestion.authorName}'s suggestion`}
              />
            ) : <span className="queue-select-spacer" aria-hidden="true" />}
            <button type="button" className="quality-queue-main" onClick={() => onSelect(item)}>
              <span className={`risk-dot risk-dot--${item.risk}`} aria-hidden="true" />
              <span className="quality-queue-copy">
                <strong>{prompt}</strong>
                <small>{item.label} · {item.source} · {relativeTime(item.sortAt)}</small>
                <small className="quality-queue-affected">Affected: {affected}</small>
                <small className={`quality-queue-source quality-queue-source--${sourceCheckByReviewItem[item.id] || (item.needsSourceCheck ? 'needs' : 'checked')}`}>
                  {sourceStatus}
                </small>
                <span className="quality-queue-labels">
                  {item.labels.slice(0, 3).map((label) => <ReviewRiskBadge key={label} label={label} />)}
                </span>
              </span>
              <b className={`queue-status ${item.status}`}>{item.status}</b>
            </button>
          </div>
        );
      })}
    </div>
  );
});

function formatFieldValue(value?: string) {
  const trimmed = (value || '').trim();
  return trimmed || 'Empty';
}

function reviewCardPrompt(card?: DeckCard) {
  if (!card) return 'Card not found';
  return fieldValue(card, 'Front') || Object.values(card.fields)[0] || card.id;
}

function affectedFieldsLabel(item: QualityReviewItem) {
  const fields = [...item.changedFields];
  if (item.changedTags) fields.push('Tags');
  return fields.length ? fields.join(', ') : 'Card context';
}

function hasRenderFallback(card: DeckCard, side: 'front' | 'back') {
  const rendered = side === 'front' ? card.renderedFront : card.renderedBack;
  const template = side === 'front' ? card.templateFront : card.templateBack;
  return !rendered?.trim() && !template?.trim();
}

function sourceCheckLabel(item: QualityReviewItem, sourceCheckState?: 'needs' | 'checked') {
  if (sourceCheckState === 'checked') return 'Source checked this session';
  if (sourceCheckState === 'needs') return 'Needs source check this session';
  if (item.needsSourceCheck) return 'Needs source check';
  return 'Source checked';
}

function ChangedFieldRows({ currentCard, suggestion, conflict }: {
  currentCard?: DeckCard;
  suggestion?: Suggestion;
  conflict?: AppState['sync']['conflicts'][number];
}) {
  const fields = suggestion
    ? Object.keys(suggestion.proposedFields || {}).filter((field) => (currentCard?.fields[field] || '') !== (suggestion.proposedFields[field] || ''))
    : conflict
      ? Array.from(new Set([...Object.keys(conflict.localFields || {}), ...Object.keys(conflict.incomingFields || {})])).sort()
      : [];

  if (!fields.length) {
    return <EmptyState message="No raw field changes are available for this item." />;
  }

  return (
    <div className="raw-change-list">
      {fields.map((field) => {
        const before = conflict ? conflict.localFields[field] : currentCard?.fields[field];
        const after = conflict ? conflict.incomingFields[field] : suggestion?.proposedFields[field];
        return <DiffBlock key={field} label={field} before={formatFieldValue(before)} after={formatFieldValue(after)} />;
      })}
    </div>
  );
}

function ReviewDecisionBar({
  item,
  canReview,
  busy,
  hasSuggestion,
  hasConflicts,
  renderFallback,
  canSuggest,
  sourceCheckState,
  onDecideSuggestion,
  onResolveConflict,
  onMarkNeedsSourceCheck,
  onMarkSourceChecked,
  onCreateSuggestion,
  onPushToAnki
}: {
  item?: QualityReviewItem;
  canReview: boolean;
  busy: boolean;
  hasSuggestion: boolean;
  hasConflicts: boolean;
  renderFallback: boolean;
  canSuggest: boolean;
  sourceCheckState: 'needs' | 'checked' | undefined;
  onDecideSuggestion: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onResolveConflict: (resolution: 'local' | 'incoming' | 'skip') => void;
  onMarkNeedsSourceCheck: () => void;
  onMarkSourceChecked: () => void;
  onCreateSuggestion: () => void;
  onPushToAnki: () => void;
}) {
  if (item?.kind === 'conflict') {
    return (
      <div className="review-decision-bar review-decision-bar--conflict">
        <span>
          <strong>Source-of-truth decision</strong>
          <small>Push to Anki stays blocked until this conflict is resolved.</small>
        </span>
        <button className="button secondary" onClick={() => onResolveConflict('skip')} disabled={busy}>Skip for now</button>
        <button className="button secondary" onClick={() => onResolveConflict('local')} disabled={busy}>Keep local Anki</button>
        <button className="button primary" onClick={() => onResolveConflict('incoming')} disabled={busy}>Use DeckBridge</button>
        <button
          className="button secondary"
          disabled
          title="Push blocked: resolve sync conflicts before writing accepted changes back to Anki."
        >
          <Icon name="sync" /> Push to Anki blocked
        </button>
      </div>
    );
  }

  if (canReview && hasSuggestion) {
    const cautious = item?.needsSourceCheck || item?.risk === 'high' || renderFallback;
    return (
      <div className={`review-decision-bar ${cautious ? 'review-decision-bar--cautious' : ''}`}>
        <span>
          <strong>{cautious ? 'Check source before accepting' : 'Suggestion decision'}</strong>
          <small>{renderFallback ? 'Rendered HTML is missing; compare the field-rendered preview with raw diffs before accepting.' : cautious ? 'Request revision is the safer action until the evidence is checked.' : 'Approved changes become canonical for the deck.'}</small>
        </span>
        <button className="button secondary" onClick={() => onDecideSuggestion('rejected')} disabled={busy}><Icon name="x" /> Reject</button>
        <button className={cautious ? 'button primary' : 'button secondary'} onClick={() => onDecideSuggestion('revision')} disabled={busy}>Request revision</button>
        {sourceCheckState === 'checked' ? (
          <button className="button secondary" onClick={onMarkNeedsSourceCheck} disabled={busy}>Mark needs source check</button>
        ) : (
          <button className={cautious ? 'button primary' : 'button secondary'} onClick={onMarkSourceChecked} disabled={busy}>Mark checked</button>
        )}
        <button className={cautious ? 'button secondary' : 'button primary'} onClick={() => onDecideSuggestion('accepted')} disabled={busy}><Icon name="check" /> Accept</button>
      </div>
    );
  }

  return (
    <div className="review-decision-bar">
      <span>
        <strong>Card actions</strong>
        <small>{hasConflicts ? 'Push blocked by unresolved sync conflicts.' : 'Accepted changes can be pushed back to Anki.'}</small>
      </span>
      <button className="button secondary" onClick={onCreateSuggestion} disabled={busy || !canSuggest}><Icon name="spark" /> Suggest edit</button>
      {item ? <button className="button secondary" onClick={onMarkNeedsSourceCheck} disabled={busy}>Mark needs source check</button> : null}
      <button
        className="button primary"
        disabled={busy || hasConflicts}
        title={hasConflicts ? 'Push blocked: resolve sync conflicts before writing accepted changes back to Anki.' : undefined}
        onClick={onPushToAnki}
      >
        <Icon name="sync" /> Push to Anki
      </button>
    </div>
  );
}

function ReviewInspectionPanel({
  item,
  deck,
  currentCard,
  suggestion,
  conflict,
  reviewTab,
  setReviewTab,
  currentUserId,
  currentUserName,
  commentsVersion,
  brief,
  aiReviewEnabled,
  canManageAi,
  briefBusy,
  canReview,
  busy,
  hasConflicts,
  canSuggest,
  sourceCheckState,
  draftReason,
  setDraftReason,
  onGenerateBrief,
  onMarkBriefUseful,
  onDismissBrief,
  onDecideSuggestion,
  onResolveConflict,
  onMarkNeedsSourceCheck,
  onMarkSourceChecked,
  onCreateSuggestion,
  onPushToAnki
}: {
  item?: QualityReviewItem;
  deck: Deck;
  currentCard?: DeckCard;
  suggestion?: Suggestion;
  conflict?: AppState['sync']['conflicts'][number];
  reviewTab: 'changes' | 'discussion';
  setReviewTab: (tab: 'changes' | 'discussion') => void;
  currentUserId: string;
  currentUserName: string;
  commentsVersion: number;
  brief: AiArtifact | null;
  aiReviewEnabled: boolean;
  canManageAi: boolean;
  briefBusy: boolean;
  canReview: boolean;
  busy: boolean;
  hasConflicts: boolean;
  canSuggest: boolean;
  sourceCheckState: 'needs' | 'checked' | undefined;
  draftReason: string;
  setDraftReason: (value: string) => void;
  onGenerateBrief: () => void;
  onMarkBriefUseful: (artifactId: string) => void;
  onDismissBrief: (artifactId: string) => void;
  onDecideSuggestion: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onResolveConflict: (resolution: 'local' | 'incoming' | 'skip') => void;
  onMarkNeedsSourceCheck: () => void;
  onMarkSourceChecked: () => void;
  onCreateSuggestion: () => void;
  onPushToAnki: () => void;
}) {
  if (!currentCard) {
    return (
      <section className="review-inspection-panel">
        <EmptyState message="Select a quality review item to inspect the rendered card and raw changes." />
      </section>
    );
  }

  if (!item) {
    const currentFrontHtml = renderCardHtml(currentCard, deck.id, 'front', undefined, currentCard.clozeOrd);
    return (
      <section className="review-inspection-panel">
        <div className="review-inspection-header">
          <div>
            <small>Card context</small>
            <h2>{fieldValue(currentCard, 'Front') || Object.values(currentCard.fields)[0] || currentCard.id}</h2>
            <p>No queue item is selected. You can browse the card or propose a new owner-review change.</p>
          </div>
        </div>
        <div className="card-preview-single">
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={currentCard} deckId={deck.id} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={currentCard} deckId={deck.id} side="back" frontHtml={currentFrontHtml} />
        </div>
        <ReviewDecisionBar
          canReview={canReview}
          busy={busy}
          hasSuggestion={false}
          hasConflicts={hasConflicts}
          renderFallback={hasRenderFallback(currentCard, 'front') || hasRenderFallback(currentCard, 'back')}
          canSuggest={canSuggest}
          sourceCheckState={sourceCheckState}
          onDecideSuggestion={onDecideSuggestion}
          onResolveConflict={onResolveConflict}
          onMarkNeedsSourceCheck={onMarkNeedsSourceCheck}
          onMarkSourceChecked={onMarkSourceChecked}
          onCreateSuggestion={onCreateSuggestion}
          onPushToAnki={onPushToAnki}
        />
      </section>
    );
  }

  const proposedCard: DeckCard = suggestion
    ? { ...currentCard, fields: { ...currentCard.fields, ...suggestion.proposedFields }, tags: suggestion.proposedTags, renderedFront: undefined, renderedBack: undefined }
    : currentCard;
  const showRendered = item.kind !== 'conflict' && !(item.labels.includes('Tag-only') && !item.labels.includes('Formatting/render'));
  const prompt = reviewCardPrompt(currentCard);
  const effectiveNeedsSourceCheck = sourceCheckState === 'checked' ? false : sourceCheckState === 'needs' ? true : item.needsSourceCheck;
  const effectiveLabels = effectiveNeedsSourceCheck && !item.labels.includes('Source check')
    ? [...item.labels, 'Source check' as const]
    : item.labels;
  const renderFallback = item.kind !== 'conflict' && (
    hasRenderFallback(currentCard, 'front') ||
    hasRenderFallback(currentCard, 'back') ||
    (suggestion ? hasRenderFallback(proposedCard, 'front') || hasRenderFallback(proposedCard, 'back') : false)
  );

  return (
    <section className={`review-inspection-panel review-inspection-panel--${item.kind}`}>
      <div className="review-inspection-header">
        <div>
          <small>{item.kind === 'conflict' ? 'Conflict review' : 'Card quality review'}</small>
          <h2>{prompt}</h2>
          <p>{item.kind === 'conflict' ? 'Which source of truth should win?' : 'Should this proposed change become canonical?'}</p>
        </div>
        <div className="review-risk-stack">
          <b className={`review-risk-score review-risk-score--${item.risk}`}>{item.risk} risk</b>
          {effectiveLabels.map((label) => <ReviewRiskBadge key={label} label={label} />)}
        </div>
      </div>

      {item.blocksPush ? (
        <div className="review-warning">
          Push to Anki is blocked because unresolved sync conflicts could overwrite local Anki or DeckBridge edits.
        </div>
      ) : effectiveNeedsSourceCheck ? (
        <div className="review-warning">
          Source check recommended before quiet acceptance. Use Mark checked only after source evidence has been reviewed.
        </div>
      ) : null}

      {sourceCheckState === 'checked' ? (
        <div className="review-source-checked">Source check marked checked in this review session.</div>
      ) : null}

      <div className="review-tabs">
        <button className={reviewTab === 'changes' ? 'active' : ''} onClick={() => setReviewTab('changes')}>Inspection</button>
        <button className={reviewTab === 'discussion' ? 'active' : ''} onClick={() => setReviewTab('discussion')} disabled={!suggestion}>Discussion</button>
      </div>

      {reviewTab === 'changes' ? (
        <>
          {showRendered ? (
            <CardPreviewComparison
              currentCard={currentCard}
              proposedCard={proposedCard}
              deckId={deck.id}
              hasSuggestion={!!suggestion}
            />
          ) : (
            <div className="review-render-collapsed">
              <strong>Rendered preview collapsed for tag-only review.</strong>
              <span>Raw tag changes are the primary quality check for this item.</span>
            </div>
          )}

          <div className="review-detail-grid">
            <section className="review-detail-section">
              <div className="review-section-heading">
                <strong>Raw field changes</strong>
                <small>{item.changedFields.length ? item.changedFields.join(', ') : 'No field changes'}</small>
              </div>
              <ChangedFieldRows currentCard={currentCard} suggestion={suggestion} conflict={conflict} />
            </section>

            <section className="review-detail-section">
              <div className="review-section-heading">
                <strong>Tags and source cues</strong>
                <small>{item.changedTags ? 'Tags changed' : 'Tags unchanged'}</small>
              </div>
              <div className="tag-diff">
                <span>{currentCard.tags.join(', ') || 'No tags'}</span>
                <strong>→</strong>
                <span>{suggestion?.proposedTags.join(', ') || currentCard.tags.join(', ') || 'No tags'}</span>
              </div>
              <div className="source-cue-list">
                <span>{effectiveNeedsSourceCheck ? 'Needs source check' : 'Source checked'}</span>
                <span>{item.affectsNextPull ? 'Affects next pull' : 'No next-pull impact'}</span>
                <span>{item.blocksPush ? 'Blocks push' : 'Does not block push'}</span>
                {renderFallback ? <span>Rendered HTML missing: field-rendered preview active</span> : null}
              </div>
              {suggestion ? (
                <label className="reason-box">
                  <span>Reason for change</span>
                  <textarea id="suggestion-reason" name="suggestion-reason" aria-label="Reason for change" value={suggestion.reason || draftReason} onChange={(event) => setDraftReason(event.target.value)} />
                </label>
              ) : null}
            </section>
          </div>
        </>
      ) : (
        suggestion ? (
          <SuggestionDiscussion
            suggestionId={suggestion.id}
            deckId={deck.id}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            commentsVersion={commentsVersion}
            brief={brief}
            aiEnabled={aiReviewEnabled}
            canManageAi={canManageAi}
            briefBusy={briefBusy}
            onGenerateBrief={onGenerateBrief}
            onMarkBriefUseful={onMarkBriefUseful}
            onDismissBrief={onDismissBrief}
          />
        ) : <EmptyState message="Discussion is available for suggestion items." />
      )}

      <ReviewDecisionBar
        item={item}
        canReview={canReview}
        busy={busy}
        hasSuggestion={!!suggestion}
        hasConflicts={hasConflicts}
        renderFallback={renderFallback}
        canSuggest={canSuggest}
        sourceCheckState={sourceCheckState}
        onDecideSuggestion={onDecideSuggestion}
        onResolveConflict={onResolveConflict}
        onMarkNeedsSourceCheck={onMarkNeedsSourceCheck}
        onMarkSourceChecked={onMarkSourceChecked}
        onCreateSuggestion={onCreateSuggestion}
        onPushToAnki={onPushToAnki}
      />
    </section>
  );
}

function ReviewWorkspace({
  deck,
  items,
  selectedItem,
  selectedCard,
  selectedSuggestion,
  selectedConflict,
  suggestions,
  bucketCounts,
  activeBucket,
  onBucketChange,
  statusFilter,
  onStatusFilterChange,
  authorFilter,
  onAuthorFilterChange,
  authors,
  canReview,
  canManageDeck,
  busy,
  selectedSuggestionIds,
  onToggleSuggestion,
  onSelectItem,
  onResetFilters,
  onBulkDecision,
  onClearSelection,
  reviewTab,
  setReviewTab,
  currentUserId,
  currentUserName,
  commentsVersion,
  brief,
  briefBusy,
  draftReason,
  setDraftReason,
  onGenerateBrief,
  onMarkBriefUseful,
  onDismissBrief,
  onDecideSuggestion,
  onResolveConflict,
  sourceCheckByReviewItem,
  onMarkNeedsSourceCheck,
  onMarkSourceChecked,
  onCreateSuggestion,
  onPushToAnki,
  hasConflicts,
  canSuggest,
}: {
  deck: Deck;
  items: QualityReviewItem[];
  selectedItem?: QualityReviewItem;
  selectedCard?: DeckCard;
  selectedSuggestion?: Suggestion;
  selectedConflict?: AppState['sync']['conflicts'][number];
  suggestions: Suggestion[];
  bucketCounts: Record<ReviewBucket, number>;
  activeBucket: ReviewBucket;
  onBucketChange: (bucket: ReviewBucket) => void;
  statusFilter: 'pending' | 'accepted' | 'rejected' | 'revision' | 'all';
  onStatusFilterChange: (status: 'pending' | 'accepted' | 'rejected' | 'revision' | 'all') => void;
  authorFilter: string;
  onAuthorFilterChange: (author: string) => void;
  authors: string[];
  canReview: boolean;
  canManageDeck: boolean;
  busy: boolean;
  selectedSuggestionIds: Set<string>;
  onToggleSuggestion: (suggestionId: string) => void;
  onSelectItem: (item: QualityReviewItem) => void;
  onResetFilters: () => void;
  onBulkDecision: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onClearSelection: () => void;
  reviewTab: 'changes' | 'discussion';
  setReviewTab: (tab: 'changes' | 'discussion') => void;
  currentUserId: string;
  currentUserName: string;
  commentsVersion: number;
  brief: AiArtifact | null;
  briefBusy: boolean;
  draftReason: string;
  setDraftReason: (value: string) => void;
  onGenerateBrief: () => void;
  onMarkBriefUseful: (artifactId: string) => void;
  onDismissBrief: (artifactId: string) => void;
  onDecideSuggestion: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onResolveConflict: (resolution: 'local' | 'incoming' | 'skip') => void;
  sourceCheckByReviewItem: Record<string, 'needs' | 'checked'>;
  onMarkNeedsSourceCheck: (itemId: string) => void;
  onMarkSourceChecked: (itemId: string) => void;
  onCreateSuggestion: () => void;
  onPushToAnki: () => void;
  hasConflicts: boolean;
  canSuggest: boolean;
}) {
  return (
    <div className="quality-review-workspace">
      <div className="quality-review-header">
        <div>
          <small>Quality Review Workspace</small>
          <h1>{deck.name}</h1>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={onResetFilters}
          disabled={activeBucket === 'all' && statusFilter === 'pending' && authorFilter === 'All'}
        >
          <Icon name="filter" /> Reset review filters
        </button>
      </div>

      <ReviewQualitySummary
        activeBucket={activeBucket}
        counts={bucketCounts}
        onBucketChange={onBucketChange}
      />

      <div className="quality-review-layout">
        <aside className="quality-queue-panel">
          <div className="review-filter-bar" aria-label="Review queue filters">
            <label>
              <span>Status</span>
              <select
                aria-label="Filter review queue by status"
                value={statusFilter}
                onChange={(event) => onStatusFilterChange(event.target.value as typeof statusFilter)}
              >
                <option value="pending">Pending</option>
                <option value="revision">Needs revision</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
                <option value="all">All statuses</option>
              </select>
            </label>
            <label>
              <span>Author</span>
              <select
                aria-label="Filter review queue by author"
                value={authorFilter}
                onChange={(event) => onAuthorFilterChange(event.target.value)}
              >
                {authors.map((author) => <option key={author}>{author}</option>)}
              </select>
            </label>
          </div>
          <ReviewQueueList
            items={items}
            selectedItem={selectedItem}
            suggestions={suggestions}
            cards={deck.cards}
            sourceCheckByReviewItem={sourceCheckByReviewItem}
            canReview={canReview}
            selectedSuggestionIds={selectedSuggestionIds}
            onSelect={onSelectItem}
            onToggleSuggestion={onToggleSuggestion}
          />
          {canReview && selectedSuggestionIds.size > 0 ? (
            <div className="suggestion-bulk-toolbar" role="toolbar" aria-label="Bulk suggestion decisions">
              <span>{selectedSuggestionIds.size} selected</span>
              <button className="button secondary" onClick={() => onBulkDecision('rejected')} disabled={busy}>Reject</button>
              <button className="button secondary" onClick={() => onBulkDecision('revision')} disabled={busy}>Request revision</button>
              <button className="button primary" onClick={() => onBulkDecision('accepted')} disabled={busy}>Accept</button>
              <button className="button secondary" onClick={onClearSelection} disabled={busy}>Clear</button>
            </div>
          ) : null}
        </aside>

        <ReviewInspectionPanel
          item={selectedItem}
          deck={deck}
          currentCard={selectedCard}
          suggestion={selectedSuggestion}
          conflict={selectedConflict}
          reviewTab={reviewTab}
          setReviewTab={setReviewTab}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          commentsVersion={commentsVersion}
          brief={brief}
          aiReviewEnabled={deck.aiSettings?.reviewBriefs === true}
          canManageAi={canManageDeck}
          briefBusy={briefBusy}
          canReview={canReview}
          busy={busy}
          hasConflicts={hasConflicts}
          canSuggest={canSuggest}
          sourceCheckState={sourceCheckByReviewItem[selectedItem?.id || '']}
          draftReason={draftReason}
          setDraftReason={setDraftReason}
          onGenerateBrief={onGenerateBrief}
          onMarkBriefUseful={onMarkBriefUseful}
          onDismissBrief={onDismissBrief}
          onDecideSuggestion={onDecideSuggestion}
          onResolveConflict={onResolveConflict}
          onMarkNeedsSourceCheck={() => selectedItem && onMarkNeedsSourceCheck(selectedItem.id)}
          onMarkSourceChecked={() => selectedItem && onMarkSourceChecked(selectedItem.id)}
          onCreateSuggestion={onCreateSuggestion}
          onPushToAnki={onPushToAnki}
        />
      </div>
    </div>
  );
}

function ModelTemplateEditor({ deck, busy, onSave }: {
  deck: Deck;
  busy: boolean;
  onSave: (modelName: string, payload: { templateFront: string; templateBack: string; modelCss: string }) => void;
}) {
  const models = useMemo(() => (
    Array.from(new Set(deck.cards.map((card) => card.modelName || card.type || 'Basic'))).sort()
  ), [deck.cards]);
  const [selectedModel, setSelectedModel] = useState(models[0] || '');
  const modelCards = useMemo(
    () => deck.cards.filter((card) => (card.modelName || card.type || 'Basic') === selectedModel),
    [deck.cards, selectedModel]
  );
  const previewCard = modelCards[0];
  const [templateForm, setTemplateForm] = useState({ templateFront: '', templateBack: '', modelCss: '' });

  useEffect(() => {
    if (!models.includes(selectedModel)) setSelectedModel(models[0] || '');
  }, [models, selectedModel]);

  useEffect(() => {
    setTemplateForm({
      templateFront: previewCard?.templateFront || '{{Front}}',
      templateBack: previewCard?.templateBack || '{{FrontSide}}<hr id=answer>{{Back}}',
      modelCss: previewCard?.modelCss || ''
    });
  }, [previewCard?.id, previewCard?.templateFront, previewCard?.templateBack, previewCard?.modelCss]);

  if (!models.length || !previewCard) {
    return <EmptyState message="This deck has no cards to preview." />;
  }

  const draftCard: DeckCard = {
    ...previewCard,
    ...templateForm,
    renderedFront: undefined,
    renderedBack: undefined
  };
  const frontHtml = renderCardHtml(draftCard, deck.id, 'front', undefined, draftCard.clozeOrd);

  return (
    <div className="model-editor">
      <div className="model-editor-header">
        <div>
          <small>Model editor</small>
          <strong>{selectedModel}</strong>
        </div>
        <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} aria-label="Select card model">
          {models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </div>
      <div className="model-editor-grid">
        <section>
          <label>
            <span>Front template</span>
            <textarea value={templateForm.templateFront} onChange={(event) => setTemplateForm((prev) => ({ ...prev, templateFront: event.target.value }))} rows={8} spellCheck={false} />
          </label>
          <label>
            <span>Back template</span>
            <textarea value={templateForm.templateBack} onChange={(event) => setTemplateForm((prev) => ({ ...prev, templateBack: event.target.value }))} rows={8} spellCheck={false} />
          </label>
          <label>
            <span>Model CSS</span>
            <textarea value={templateForm.modelCss} onChange={(event) => setTemplateForm((prev) => ({ ...prev, modelCss: event.target.value }))} rows={8} spellCheck={false} />
          </label>
          <button className="button primary" disabled={busy} onClick={() => onSave(selectedModel, templateForm)}>
            Save template
          </button>
        </section>
        <section className="model-preview">
          <small>Preview card</small>
          <strong>{fieldValue(previewCard, 'Front') || Object.values(previewCard.fields)[0] || previewCard.id}</strong>
          <AnkiCardRenderer card={draftCard} deckId={deck.id} side="front" frontHtml={frontHtml} clozeOrd={draftCard.clozeOrd} />
          <AnkiCardRenderer card={draftCard} deckId={deck.id} side="back" frontHtml={frontHtml} clozeOrd={draftCard.clozeOrd} />
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const deckOps = useDeckOperations();
  const {
    state, setState, activeDeck, activeSummary, isDevDemo, membershipRole, canReview, canManageDeck, canSuggest,
    session, authReady, authMode, authEmail, authPassword, authBusy, authNotice,
    activeSyncConflicts, pendingConflictIds,
    suggestions, pendingSuggestions, reviewAuthors,
    allTags, cardStates, filteredCards, maxPage, safePage, pagedCards,
    currentStart, currentEnd, cardsWithPendingSuggestions,
    approvedStudyCards, studyCards, closeStudyView, suggestionStats,
    duplicateCountsByCard,
    activeDeckVisibility, deckEmbedCode,
    addonPackage, apiHealth, busy, setBusy, deckLoading,
    page, pageSize, queryInput, tagFilter, cardStateFilter, draftReason,
    qualityPulse, qualityPulseBusy, duplicateLinks, embeddingBusy,
    conflictReviewSnapshot, deckVisibility, copiedShare,
    selectedCardId, selectedSuggestionId, selectedOwnerQueueItemId,
    selectedSuggestionIds, selectedCardIds,
    toasts, commentsVersion,
    reviewTab, reviewRiskFilter, reviewStatusFilter, reviewAuthorFilter,
    sourceCheckByReviewItem, suggestionBriefs, briefBusy,
    showConnectWizard, editingCardId, bulkAction, bulkTagInput,
    activeTab, showStudy, studyApprovedOnly, topView, darkMode,
    overviewTabRef, suggestionImportRef,
    uploadDeck, importSuggestionSpreadsheet, exportDeck,
    removeActiveDeckFromDeckBridge, switchDeck, switchRole, submitAuth,
    pushToast, dismissToast,
    refreshActiveDeckState, refreshState, refreshWith,
    handleSuggestionChange, handleCommentChange,
    toggleCardSelection, handleBulkTagAdd, handleBulkTagRemove, handleBulkDelete,
    createSuggestion, bulkDecideSuggestions, clearSuggestionSelection,
    toggleSuggestionSelection,
    selectOwnerQueueItem, decideSuggestion, resolveSelectedConflict,
    generateSuggestionBrief, updateSuggestionBriefStatus,
    dismissOwnerArtifact, indexSelectedCardEmbedding, indexVisibleCardEmbeddings,
    handleSyncAction, handleOwnerAttentionAction,
    setAuthMode, setAuthEmail, setAuthPassword,
    setSelectedCardId, setSelectedSuggestionId, setSelectedOwnerQueueItemId,
    setSelectedSuggestionIds, setQueryInput, setTagFilter, setCardStateFilter,
    setDraftReason, setPage, setPageSize, setShowConnectWizard,
    setReviewTab, setReviewRiskFilter, setReviewStatusFilter, setReviewAuthorFilter,
    setSourceCheckByReviewItem, setActiveTab, setShowStudy, setStudyApprovedOnly,
    setTopView, setDarkMode, setEditingCardId, setSelectedCardIds,
    setBulkAction, setBulkTagInput, setConflictReviewSnapshot, setCopiedShare,
    setDeckVisibility, retainConflictReviewSnapshot,
  } = deckOps;

  const reviewQueue = useReviewQueue(state, activeDeck, suggestions, activeSyncConflicts, qualityPulse, selectedOwnerQueueItemId, selectedSuggestionId, selectedCardId, duplicateLinks, conflictReviewSnapshot, reviewRiskFilter, reviewStatusFilter, reviewAuthorFilter, suggestionBriefs);
  const {
    ownerReviewQueue, reviewBucketCounts, queueItems,
    selectedOwnerQueueItem, selectedSuggestion, selectedConflict,
    selectedCard, selectedSuggestionBrief, selectedDuplicateLinks,
  } = reviewQueue;

  const syncState = useSyncState(state, activeDeck, addonPackage, apiHealth, canReview, pendingSuggestions.length, qualityPulse, studyCards.length, activeDeckVisibility, activeTab);
  const {
    syncHealth, changedCards, activeRail, ownerAttentionItems,
  } = syncState;

  useRealtime({
    supabase,
    deckId: activeDeck?.id,
    onSuggestionChange: handleSuggestionChange,
    onCommentChange: handleCommentChange,
    onCardChange: (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') {
        refreshActiveDeckState();
      }
    },
    enabled: !!session,
  });
  const cardRailCard = activeDeck?.cards.find((card) => card.id === selectedCardId) || selectedCard;
  const highlightedCard = activeTab === 'cards' ? cardRailCard : selectedCard;
  const cardRailPendingSuggestion = cardRailCard
    ? pendingSuggestions.find((item) => item.cardId === cardRailCard.id)
    : undefined;
  const contextRail = activeRail === 'overview' ? (
    <OverviewRail
      ownerAttentionItems={ownerAttentionItems}
      syncHealth={syncHealth}
      reviewCount={ownerReviewQueue.length}
      reviewBucketCounts={reviewBucketCounts}
      conflictCount={activeSyncConflicts.length}
      onDismissArtifact={dismissOwnerArtifact}
      onOwnerAction={handleOwnerAttentionAction}
      onOpenReviewBucket={(bucket) => {
        setReviewRiskFilter(bucket);
        setReviewStatusFilter('pending');
        setSelectedOwnerQueueItemId(null);
        setActiveTab('review');
      }}
      onOpenReview={() => setActiveTab('review')}
    />
  ) : activeRail === 'card' && activeDeck ? (
    <CardRail
      deckId={activeDeck.id}
      card={cardRailCard}
      pendingSuggestion={cardRailPendingSuggestion}
      duplicateCount={cardRailCard ? duplicateCountsByCard.get(cardRailCard.id) || 0 : 0}
      canSuggest={canSuggest}
      onEditCard={(cardId) => {
        setSelectedCardId(cardId);
        setEditingCardId(cardId);
      }}
      onOpenSuggestion={(suggestion) => {
        setSelectedSuggestionId(suggestion.id);
        setSelectedOwnerQueueItemId(`suggestion:${suggestion.id}`);
        setReviewRiskFilter('all');
        setReviewStatusFilter('pending');
        setActiveTab('review');
      }}
    />
  ) : null;





  if (supabase && authReady && !session) {
    return (
      <AuthScreen
        authMode={authMode}
        authEmail={authEmail}
        authPassword={authPassword}
        authBusy={authBusy}
        authNotice={authNotice}
        onSubmit={submitAuth}
        onEmailChange={setAuthEmail}
        onPasswordChange={setAuthPassword}
        onToggleMode={() => setAuthMode(authMode === 'sign-in' ? 'sign-up' : 'sign-in')}
      />
    );
  }

  if (!state) {
    return (
      <div className="loading">
        <div className="loading-spinner" aria-hidden="true" />
        <strong>Loading DeckBridge…</strong>
        {apiHealth === 'down' ? <span>API bridge is unavailable. Start it with npm run dev:server.</span> : null}
      </div>
    );
  }

  if (!activeDeck) {
    return (
      <div className="empty-workspace">
        <div className="brand-row">
          <div className="brand-mark"><Icon name="cards" /></div>
          <span>DeckBridge</span>
        </div>
        <section className="empty-import">
          <Icon name="upload" />
          <h1>Import your first Anki deck</h1>
          <p>Upload an <code>.apkg</code> file to create a collaborative workspace. Invite teammates, review suggestions, and export approved changes back to Anki.</p>
          <label className="button primary">
            <Icon name="upload" />
            Import .apkg
            <input className="file-input-hidden" type="file" accept=".apkg" onChange={uploadDeck} />
          </label>
        </section>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><Icon name="cards" /></div>
          <span>DeckBridge</span>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${topView === 'workspace' ? 'active' : ''}`} onClick={() => setTopView('workspace')}>
            <Icon name="cards" /> Workspace
          </button>
          <button className={`nav-item ${topView === 'discover' ? 'active' : ''}`} onClick={() => setTopView('discover')}>
            <Icon name="search" /> Discover
          </button>
          <button className={`nav-item ${topView === 'templates' ? 'active' : ''}`} onClick={() => setTopView('templates')}>
            <Icon name="spark" /> Templates
          </button>
        </nav>

        <section className="side-section">
          <div className="section-heading">
            <span>Decks</span>
            <span className="mini-actions">+ ⌕</span>
          </div>
          <div className="deck-list">
            {state.summaries.map((summary) => (
              <button
                className={`deck-item ${summary.id === activeDeck.id ? 'active' : ''}`}
                key={summary.id}
                onClick={() => switchDeck(summary.id)}
              >
                <Icon name="cards" />
                <span>
                  <strong>{summary.name}</strong>
                  <small>{summary.cardCount.toLocaleString()} cards</small>
                </span>
                <span className="people-dot"><Icon name="users" /></span>
              </button>
            ))}
          </div>
        </section>

        <section className="side-section collaborator-section">
          <div className="section-heading">
            <span>Collaborators</span>
            <span>+</span>
          </div>
          {state.collaborators.map((person) => (
            <div className="person-row" key={person.id}>
              <span className={`avatar ${person.role === 'owner' ? 'owner' : ''}`}>{initials(person.name)}</span>
              <span>
                <strong>{person.name}{person.role === 'owner' ? ' (Deck Owner)' : ''}</strong>
                <small>{person.email}</small>
              </span>
              {person.role === 'owner' ? <span className="crown">♛</span> : <span className="accepted-count">{person.accepted}</span>}
            </div>
          ))}
        </section>

        <section className="side-section activity-section">
          <div className="section-heading">Recent activity</div>
          {state.activity.slice(0, 6).map((item) => (
            <div className="activity-row" key={item.id}>
              <span className="activity-icon"><Icon name={item.kind === 'export' ? 'download' : item.kind === 'sync' ? 'sync' : 'spark'} /></span>
              <span>{item.text}</span>
              <small>{relativeTime(item.at)}</small>
            </div>
          ))}
        </section>

        <button
          className="dark-toggle"
          onClick={() => setDarkMode((d) => !d)}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <Icon name={darkMode ? 'sun' : 'moon'} />
          {darkMode ? 'Light mode' : 'Dark mode'}
        </button>
      </aside>

      {topView === 'discover' && (
        <section className="workspace">
          <DiscoverView
            onFork={(deckId, name) => {
              setTopView('workspace');
              pushToast(`Forked "${name}" into your workspace`, 'success');
              refreshState();
            }}
          />
        </section>
      )}

      {topView === 'templates' && (
        <section className="workspace">
          <TemplateGallery
            onUse={(deckId, name) => {
              setTopView('workspace');
              pushToast(`Created "${name}" from template`, 'success');
              refreshState();
            }}
          />
        </section>
      )}

      {topView === 'workspace' && <section className="workspace">
        <header className="topbar">
          <div className="topbar-actions">
            <label className="button secondary">
              <Icon name="upload" />
              Upload .apkg
              <input id="deck-upload" type="file" name="deck-upload" aria-label="Upload Anki deck package" accept=".apkg" onChange={uploadDeck} hidden />
            </label>
            <button className="button secondary" onClick={() => activeDeck && refreshWith(api.ankiPull(activeDeck.id), 'Pulled current Anki deck')}>
              <Icon name="sync" />
              Import from Anki
            </button>
            <button className="button primary" onClick={() => setShowConnectWizard(true)}>
              <Icon name="sync" />
              Connect Anki
            </button>
          </div>

          <SyncHealthStrip health={syncHealth} onAction={handleSyncAction} />

          <div className="right-actions">
            {isDevDemo ? (
              <div className="role-toggle" aria-label="Role selector">
                <button className={membershipRole === 'owner' ? 'selected' : ''} onClick={() => switchRole('owner')}>Owner</button>
                <button className={membershipRole === 'editor' ? 'selected' : ''} onClick={() => switchRole('editor')}>Editor</button>
                <button className={membershipRole === 'reviewer' ? 'selected' : ''} onClick={() => switchRole('reviewer')}>Reviewer</button>
                <button className={membershipRole === 'contributor' ? 'selected' : ''} onClick={() => switchRole('contributor')}>Contributor</button>
              </div>
            ) : null}
            <NotificationsBell />
            <div className="export-dropdown">
              <button className="button primary" onClick={exportDeck} disabled={busy}>
                <Icon name="download" /> Export/Download
              </button>
              <div className="export-menu">
                <button onClick={exportDeck} disabled={busy}>.apkg (Anki)</button>
                <button onClick={async () => {
                  if (!activeDeck) return;
                  try {
                    setBusy(true);
                    const { blob, filename } = await api.exportDeckCsv(activeDeck.id);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(url);
                    pushToast(`Exported ${filename}`, 'success');
                  } catch (e) { pushToast(e instanceof Error ? e.message : 'Export failed', 'error'); }
                  finally { setBusy(false); }
                }} disabled={busy}>.csv (Spreadsheet)</button>
                <button onClick={() => suggestionImportRef.current?.click()} disabled={busy || !canSuggest}>Upload spreadsheet changes</button>
                <button onClick={async () => {
                  if (!activeDeck) return;
                  try {
                    setBusy(true);
                    const { blob, filename } = await api.exportActivityCsv(activeDeck.id);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(url);
                    pushToast(`Exported ${filename}`, 'success');
                  } catch (e) { pushToast(e instanceof Error ? e.message : 'Export failed', 'error'); }
                  finally { setBusy(false); }
                }} disabled={busy}>Activity Log (.csv)</button>
              </div>
            </div>
            <input
              ref={suggestionImportRef}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              onChange={importSuggestionSpreadsheet}
              hidden
            />
          </div>
        </header>

        <WorkbenchLayout railKind={activeRail} rail={contextRail}>
            <div className="breadcrumb">Decks <span>/</span> {activeDeck.name}</div>
            <div className="tabs">
              <button ref={overviewTabRef} className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
              <button className={activeTab === 'review' ? 'active' : ''} onClick={() => setActiveTab('review')}>Review</button>
              <button className={activeTab === 'study' ? 'active' : ''} onClick={() => setActiveTab('study')}>Study</button>
              <button className={activeTab === 'cards' ? 'active' : ''} onClick={() => setActiveTab('cards')}>Cards</button>
              {canManageDeck ? <button className={activeTab === 'models' ? 'active' : ''} onClick={() => setActiveTab('models')}>Models</button> : null}
              <button className={activeTab === 'stats' ? 'active' : ''} onClick={() => setActiveTab('stats')}>Stats</button>
              <button className={activeTab === 'analytics' ? 'active' : ''} onClick={() => setActiveTab('analytics')}>Analytics</button>
              <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}>Activity</button>
              <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>Settings</button>
              {pendingSuggestions.length > 0 && (
                <span className="pending-callout" title={`${pendingSuggestions.length} suggestion${pendingSuggestions.length === 1 ? '' : 's'} pending owner review`}>
                  {pendingSuggestions.length} pending
                </span>
              )}
            </div>

            {deckLoading && activeDeck.cards.length === 0 && (activeSummary?.cardCount || 0) > 0 ? (
              <div className="inline-notice">
                Loading {activeSummary?.cardCount.toLocaleString()} cards for {activeDeck.name}. The workspace is ready while card details hydrate.
              </div>
            ) : null}

            {activeTab === 'study' && activeDeck ? (
              <StudyPrepView
                totalCards={activeDeck.cards.length}
                studyCards={studyCards.length}
                approvedCards={approvedStudyCards.length}
                pendingBlocked={cardsWithPendingSuggestions.size}
                approvedOnly={studyApprovedOnly}
                onApprovedOnlyChange={setStudyApprovedOnly}
                onStart={() => setShowStudy(true)}
              />
            ) : null}

            {activeTab === 'stats' && activeDeck ? (
              <DeckStatsView
                deck={activeDeck}
                summary={activeSummary}
                suggestions={suggestionStats}
                filteredCount={filteredCards.length}
              />
            ) : null}

            {activeTab === 'analytics' && activeDeck ? (
              <AnalyticsDashboard
                deckId={activeDeck.id}
                deckName={activeDeck.name}
                isOwner={canManageDeck}
                currentVisibility={activeDeckVisibility}
                onSetVisibility={(v) => setDeckVisibility((prev) => ({ ...prev, [activeDeck.id]: v }))}
              />
            ) : null}

            {activeTab === 'activity' && activeDeck ? (
              <ActivityTimeline
                deckId={activeDeck.id}
                deckName={activeDeck.name}
                activities={state.activity}
                suggestionStats={suggestionStats}
              />
            ) : null}

            {activeTab === 'models' && activeDeck && canManageDeck ? (
              <ModelTemplateEditor
                deck={activeDeck}
                busy={busy}
                onSave={(modelName, payload) => refreshWith(api.updateModelTemplate(activeDeck.id, modelName, payload), `${modelName} template updated`)}
              />
            ) : null}

            {activeTab === 'settings' && activeDeck ? (
              <DeckSettingsView
                deck={activeDeck}
                visibility={activeDeckVisibility}
                canReview={canManageDeck}
                embedCode={deckEmbedCode}
                copiedShare={copiedShare}
                onCopied={setCopiedShare}
                onSetVisibility={(v) => {
                  refreshWith(api.setVisibility(activeDeck.id, v), `Deck visibility set to ${v}`, () => {
                    setDeckVisibility((prev) => ({ ...prev, [activeDeck.id]: v }));
                    return state;
                  });
                }}
                onRemoveDeck={() => removeActiveDeckFromDeckBridge(activeDeck.id, activeDeck.name)}
              />
            ) : null}

            {activeTab === 'review' && activeDeck ? (
              <ReviewWorkspace
                deck={activeDeck}
                items={queueItems}
                selectedItem={selectedOwnerQueueItem}
                selectedCard={selectedCard}
                selectedSuggestion={selectedSuggestion}
                selectedConflict={selectedConflict}
                suggestions={suggestions}
                bucketCounts={reviewBucketCounts}
                activeBucket={reviewRiskFilter as ReviewBucket}
                onBucketChange={(bucket: ReviewBucket) => {
                  setReviewRiskFilter(bucket);
                  setSelectedOwnerQueueItemId(null);
                }}
                statusFilter={reviewStatusFilter as 'pending' | 'accepted' | 'rejected' | 'revision' | 'all'}
                onStatusFilterChange={(status: 'pending' | 'accepted' | 'rejected' | 'revision' | 'all') => {
                  setReviewStatusFilter(status);
                  setSelectedOwnerQueueItemId(null);
                }}
                authorFilter={reviewAuthorFilter}
                onAuthorFilterChange={(author) => {
                  setReviewAuthorFilter(author);
                  setSelectedOwnerQueueItemId(null);
                }}
                authors={reviewAuthors}
                canReview={canReview}
                canManageDeck={canManageDeck}
                busy={busy}
                selectedSuggestionIds={selectedSuggestionIds}
                onToggleSuggestion={toggleSuggestionSelection}
                onSelectItem={selectOwnerQueueItem}
                onResetFilters={() => {
                  setReviewRiskFilter('all');
                  setReviewStatusFilter('pending');
                  setReviewAuthorFilter('All');
                  setSelectedOwnerQueueItemId(null);
                }}
                onBulkDecision={bulkDecideSuggestions}
                onClearSelection={clearSuggestionSelection}
                reviewTab={reviewTab}
                setReviewTab={setReviewTab}
                currentUserId={state.user?.id || 'you'}
                currentUserName={state.user?.name || 'You'}
                commentsVersion={commentsVersion}
                brief={selectedSuggestionBrief}
                briefBusy={briefBusy}
                draftReason={draftReason}
                setDraftReason={setDraftReason}
                onGenerateBrief={generateSuggestionBrief}
                onMarkBriefUseful={(artifactId) => updateSuggestionBriefStatus(artifactId, 'useful')}
                onDismissBrief={(artifactId) => updateSuggestionBriefStatus(artifactId, 'dismiss')}
                onDecideSuggestion={decideSuggestion}
                onResolveConflict={resolveSelectedConflict}
                sourceCheckByReviewItem={sourceCheckByReviewItem}
                onMarkNeedsSourceCheck={(itemId) => {
                  setSourceCheckByReviewItem((prev) => ({ ...prev, [itemId]: 'needs' }));
                  pushToast('Marked needs source check for this review session', 'info');
                }}
                onMarkSourceChecked={(itemId) => {
                  setSourceCheckByReviewItem((prev) => ({ ...prev, [itemId]: 'checked' }));
                  pushToast('Marked source checked for this review session', 'success');
                }}
                onCreateSuggestion={createSuggestion}
                onPushToAnki={() => refreshWith(api.ankiPush(activeDeck.id), 'Pushed accepted note updates', (value) => value.state)}
                hasConflicts={state.sync.conflicts.length > 0}
                canSuggest={canSuggest}
              />
            ) : null}

            {conflictReviewSnapshot.length ? (
              <ConflictResolution
                conflicts={conflictReviewSnapshot}
                pendingConflictIds={pendingConflictIds}
                onResolve={(conflictId, resolution) => {
                  retainConflictReviewSnapshot.current = true;
                  setState(prev => prev ? {
                    ...prev,
                    sync: {
                      ...prev.sync,
                      conflicts: prev.sync.conflicts.filter(c => c.id !== conflictId)
                    }
                  } : prev);
                  if (resolution !== 'skip') {
                    pushToast(resolution === 'local' ? 'Kept local version' : 'Applied incoming changes', 'info');
                  }
                }}
                onClearReview={() => setConflictReviewSnapshot([])}
              />
            ) : null}

            {(activeTab === 'overview' || activeTab === 'cards') ? (<>
            <div className="summary-band">
              <div>
                <small>Deck description</small>
                <strong>{activeDeck.description}</strong>
              </div>
              <div><small>Cards</small><strong>{activeSummary?.cardCount.toLocaleString()}</strong></div>
              <div><small>Notes</small><strong>{activeSummary?.noteCount.toLocaleString()}</strong></div>
              <div><small>Tags</small><strong>{activeSummary?.tagCount.toLocaleString()}</strong></div>
              <div><small>Last synced</small><strong>{relativeTime(activeDeck.lastSyncedAt)}</strong></div>
            </div>

            <div className="table-panel">
              <div className="table-tools">
                <label className="sr-only" htmlFor="card-search">Search cards</label>
                <label className="search-box">
                  <Icon name="search" />
                  <input id="card-search" name="card-search" aria-label="Search cards" placeholder="Search cards..." value={queryInput} onChange={(event) => setQueryInput(event.target.value)} />
                </label>
                <label className="sr-only" htmlFor="tag-filter">Filter by tag</label>
                <select id="tag-filter" name="tag-filter" aria-label="Filter by tag" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
                  {allTags.map((tag) => <option key={tag}>{tag}</option>)}
                </select>
                <label className="sr-only" htmlFor="card-state-filter">Filter by card state</label>
                <select id="card-state-filter" name="card-state-filter" aria-label="Filter by card state" value={cardStateFilter} onChange={(event) => setCardStateFilter(event.target.value)}>
                  {cardStates.map((item) => <option key={item}>{item}</option>)}
                </select>
                <button
                  className="button secondary"
                  onClick={() => {
                    setQueryInput('');
                    setTagFilter('All');
                    setCardStateFilter('All');
                  }}
                  disabled={!queryInput && tagFilter === 'All' && cardStateFilter === 'All'}
                >
                  <Icon name="filter" /> Clear filters
                </button>
                {canManageDeck && activeDeck.aiSettings?.embeddings ? (
                  <button className="button secondary" onClick={indexVisibleCardEmbeddings} disabled={embeddingBusy || !filteredCards.length}>
                    <Icon name="spark" /> Index visible
                  </button>
                ) : null}
              </div>

              {selectedCardIds.size > 0 && (
                <div className="bulk-toolbar">
                  <span className="bulk-count">{selectedCardIds.size} selected</span>
                  {bulkAction === 'tag-add' && (
                    <span className="bulk-tag-form">
                      <input
                        className="bulk-tag-input"
                        placeholder="Tag name…"
                        value={bulkTagInput}
                        onChange={(e) => setBulkTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleBulkTagAdd(bulkTagInput); if (e.key === 'Escape') setBulkAction(null); }}
                      />
                      <button className="button primary" onClick={() => handleBulkTagAdd(bulkTagInput)}>Apply</button>
                      <button className="button secondary" onClick={() => { setBulkAction(null); setBulkTagInput(''); }}>Cancel</button>
                    </span>
                  )}
                  {bulkAction === 'tag-remove' && (
                    <span className="bulk-tag-form">
                      <input
                        className="bulk-tag-input"
                        placeholder="Tag to remove…"
                        value={bulkTagInput}
                        onChange={(e) => setBulkTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleBulkTagRemove(bulkTagInput); if (e.key === 'Escape') setBulkAction(null); }}
                      />
                      <button className="button primary" onClick={() => handleBulkTagRemove(bulkTagInput)}>Apply</button>
                      <button className="button secondary" onClick={() => { setBulkAction(null); setBulkTagInput(''); }}>Cancel</button>
                    </span>
                  )}
                  {bulkAction === 'delete' && (
                    <span className="bulk-confirm">
                      <span>Delete {selectedCardIds.size} card(s)? This cannot be undone.</span>
                      <button className="button danger" onClick={handleBulkDelete}>Confirm delete</button>
                      <button className="button secondary" onClick={() => setBulkAction(null)}>Cancel</button>
                    </span>
                  )}
                  {bulkAction === null && canSuggest && (
                    <>
                      <button className="button secondary" onClick={() => setBulkAction('tag-add')}>+ Add tag</button>
                      <button className="button secondary" onClick={() => setBulkAction('tag-remove')}>- Remove tag</button>
                      {canManageDeck && <button className="button danger-outline" onClick={() => setBulkAction('delete')}>Delete</button>}
                    </>
                  )}
                  <button className="button secondary" onClick={() => { setSelectedCardIds(new Set()); setBulkAction(null); }}>Clear selection</button>
                </div>
              )}

              <CardVirtualList deckId={activeDeck.id} onCardSelect={setSelectedCardId} selectedCardId={selectedCardId ?? undefined} />
            </div>
            </>) : null}
        </WorkbenchLayout>
      </section>}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {busy ? <div className="busy-bar" /> : null}
      {showConnectWizard && (
        <ConnectAnkiWizard
          decks={state.summaries}
          platformUrl={window.location.origin}
          currentState={state}
          onRefreshState={refreshState}
          onClose={() => setShowConnectWizard(false)}
        />
      )}
      {showStudy && activeDeck && (
        <StudyView
          deckId={activeDeck.id}
          cards={studyCards}
          modeLabel={studyApprovedOnly ? 'Approved cards only' : 'All cards'}
          onClose={closeStudyView}
        />
      )}
    </main>
  );
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <span className="toast__icon" aria-hidden="true">{TOAST_ICONS[t.type]}</span>
          <span className="toast__message">{t.message}</span>
          <button className="toast__dismiss" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">✕</button>
        </div>
      ))}
    </div>
  );
}

function DiffBlock({ label, before, after }: { label: string; before?: string; after?: string }) {
  return (
    <div className="diff-block">
      <label>{label}</label>
      <div className="diff-lines">
        <p className="removed">- {before || 'Empty'}</p>
        <p className="added">+ {after || before || 'No suggested change'}</p>
      </div>
    </div>
  );
}

function CardPreviewComparison({ currentCard, proposedCard, deckId, hasSuggestion }: {
  currentCard: DeckCard;
  proposedCard: DeckCard;
  deckId: string;
  hasSuggestion: boolean;
}) {
  const currentFrontHtml = useMemo(
    () => renderCardHtml(currentCard, deckId, 'front'),
    [currentCard, deckId],
  );
  const proposedFrontHtml = useMemo(
    () => renderCardHtml(proposedCard, deckId, 'front'),
    [proposedCard, deckId],
  );
  const currentRenderFallback = hasRenderFallback(currentCard, 'front') || hasRenderFallback(currentCard, 'back');
  const proposedRenderFallback = hasSuggestion && (hasRenderFallback(proposedCard, 'front') || hasRenderFallback(proposedCard, 'back'));
  const renderFallback = currentRenderFallback || proposedRenderFallback;

  const renderFallbackNotice = renderFallback ? (
    <div className="render-unavailable" role="status">
      <strong>Rendered HTML missing</strong>
      <span>
        {currentRenderFallback && proposedRenderFallback
          ? 'Current and proposed previews are field-rendered from card data.'
          : currentRenderFallback
            ? 'Current preview is field-rendered from card data.'
            : 'Proposed preview is field-rendered from card data.'}
        {' '}Use the raw field diff below before accepting.
      </span>
    </div>
  ) : null;

  if (!hasSuggestion) {
    return (
      <>
        {renderFallbackNotice}
        <div className="card-preview-single">
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="back" frontHtml={currentFrontHtml} />
        </div>
      </>
    );
  }

  return (
    <>
      {renderFallbackNotice}
      <div className="card-preview-comparison">
        <div className="card-preview-col">
          <span className="card-preview-label">Current</span>
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="back" frontHtml={currentFrontHtml} />
        </div>
        <div className="card-preview-col">
          <span className="card-preview-label proposed">Proposed</span>
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={proposedCard} deckId={deckId} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={proposedCard} deckId={deckId} side="back" frontHtml={proposedFrontHtml} />
        </div>
      </div>
    </>
  );
}
