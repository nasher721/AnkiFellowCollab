import type { DeckCard, Suggestion, AppState } from '../types';
import { DiffBlock } from './DiffBlock';
import { EmptyState } from './EmptyState';

function formatFieldValue(value?: string) {
  const trimmed = (value || '').trim();
  return trimmed || 'Empty';
}

export function ChangedFieldRows({ currentCard, suggestion, conflict }: {
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
