import type { OwnerAttentionItem, SyncHealth } from '../hooks/common';
import type { ReviewBucket } from '../reviewModel';
import type { deriveReviewBucketCounts } from '../reviewModel';
import { OwnerAttentionPanel } from './OwnerAttentionPanel';

export function OverviewRail({
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
