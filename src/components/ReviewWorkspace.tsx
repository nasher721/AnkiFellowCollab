import type { Deck, DeckCard, Suggestion, AppState, AiArtifact } from '../types';
import type { QualityReviewItem, ReviewBucket } from '../reviewModel';
import { Icon } from './Icon';
import { ReviewQualitySummary } from './ReviewQualitySummary';
import { ReviewQueueList } from './ReviewQueueList';
import { ReviewInspectionPanel } from './ReviewInspectionPanel';

export function ReviewWorkspace({
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
