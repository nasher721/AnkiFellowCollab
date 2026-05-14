import { memo } from 'react';

export const EmptyState = memo(function EmptyState({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
});
