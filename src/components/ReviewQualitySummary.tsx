import { memo } from 'react';
import type { ReviewBucket } from '../reviewModel';

const REVIEW_BUCKETS: Array<{ key: ReviewBucket; label: string; detail: string }> = [
  { key: 'all', label: 'All review', detail: 'Every item' },
  { key: 'answer', label: 'Answer changed', detail: 'Check facts' },
  { key: 'source', label: 'Source check', detail: 'Needs evidence' },
  { key: 'tag', label: 'Tag-only', detail: 'Cleanup' },
  { key: 'render', label: 'Formatting/render', detail: 'Preview risk' },
  { key: 'conflict', label: 'Sync conflict', detail: 'Blocks push' }
];

export const ReviewQualitySummary = memo(function ReviewQualitySummary({
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
