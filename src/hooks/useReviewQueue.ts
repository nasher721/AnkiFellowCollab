import { useMemo } from 'react';
import type { AiArtifact, AiDuplicateLink, AiQualityPulse, AppState, Deck, DeckCard, Suggestion } from '../types';
import {
  deriveOwnerReviewQueue,
  deriveReviewBucketCounts,
  reviewItemMatchesBucket,
  selectCardForReview,
  selectSuggestionForReview,
  type QualityReviewItem,
  type ReviewBucket,
} from '../reviewModel';

export function useReviewQueue(
  state: AppState | null,
  activeDeck: Deck | undefined,
  suggestions: Suggestion[],
  activeSyncConflicts: AppState['sync']['conflicts'],
  qualityPulse: AiQualityPulse | null,
  selectedOwnerQueueItemId: string | null,
  selectedSuggestionId: string | null,
  selectedCardId: string | null,
  duplicateLinks: AiDuplicateLink[],
  conflictReviewSnapshot: any[],
  reviewRiskFilter: string,
  reviewStatusFilter: string,
  reviewAuthorFilter: string,
  suggestionBriefs: Record<string, AiArtifact | null>,
) {
  const pendingSuggestions = useMemo(() => suggestions.filter((item) => item.status === 'pending'), [suggestions]);
  const reviewAuthors = useMemo(() => ['All', ...Array.from(new Set(suggestions.map((item) => item.authorName))).sort()], [suggestions]);

  const ownerReviewQueue = useMemo(() => deriveOwnerReviewQueue({
    suggestions,
    conflicts: activeSyncConflicts,
    pulse: qualityPulse,
    cards: activeDeck?.cards || []
  }), [activeDeck?.cards, activeSyncConflicts, qualityPulse, suggestions]);

  const reviewBucketCounts = useMemo(() => deriveReviewBucketCounts(ownerReviewQueue), [ownerReviewQueue]);

  const queueItems = useMemo(() => ownerReviewQueue.filter((item) => {
    const bucketMatch = reviewItemMatchesBucket(item, reviewRiskFilter as ReviewBucket);
    const statusMatch = reviewStatusFilter === 'all' || item.status === reviewStatusFilter;
    const authorMatch = reviewAuthorFilter === 'All' || !item.authorName || item.authorName === reviewAuthorFilter;
    return bucketMatch && statusMatch && authorMatch;
  }), [ownerReviewQueue, reviewRiskFilter, reviewStatusFilter, reviewAuthorFilter]);

  const selectedOwnerQueueItem = queueItems.find((item) => item.id === selectedOwnerQueueItemId) || queueItems[0];
  const selectedSuggestion = selectSuggestionForReview(selectedOwnerQueueItem, suggestions, selectedSuggestionId);
  const selectedConflict = selectedOwnerQueueItem?.conflictId
    ? activeSyncConflicts.find((item) => item.id === selectedOwnerQueueItem.conflictId) || conflictReviewSnapshot.find((item: any) => item.id === selectedOwnerQueueItem.conflictId)
    : undefined;
  const selectedCard = activeDeck ? selectCardForReview(selectedOwnerQueueItem, selectedSuggestion, activeDeck.cards, selectedCardId) : undefined;
  const selectedSuggestionBrief = selectedSuggestion ? suggestionBriefs[selectedSuggestion.id] : null;

  const selectedDuplicateLinks = useMemo(() => duplicateLinks.filter((link) => (
    selectedCard && (link.sourceCardId === selectedCard.id || link.targetCardId === selectedCard.id)
  )), [duplicateLinks, selectedCard]);

  return {
    pendingSuggestions, reviewAuthors,
    ownerReviewQueue, reviewBucketCounts, queueItems,
    selectedOwnerQueueItem, selectedSuggestion, selectedConflict,
    selectedCard, selectedSuggestionBrief, selectedDuplicateLinks,
  };
}
