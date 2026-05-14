import { memo } from 'react';
import type { DeckCard, Suggestion } from '../types';
import { relativeTime, fieldValue } from '../hooks/common';
import type { QualityReviewItem } from '../reviewModel';
import { reviewCardPrompt, affectedFieldsLabel, sourceCheckLabel } from './reviewHelpers';
import { ReviewRiskBadge } from './ReviewRiskBadge';
import { EmptyState } from './EmptyState';

export const ReviewQueueList = memo(function ReviewQueueList({
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
