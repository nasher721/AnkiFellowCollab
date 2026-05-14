import { memo } from 'react';
import type { ReviewRiskLabel } from '../reviewModel';

export const ReviewRiskBadge = memo(function ReviewRiskBadge({ label }: { label: ReviewRiskLabel }) {
  const className = label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '');
  return <span className={`review-risk-badge review-risk-badge--${className}`}>{label}</span>;
});
