import { useState } from 'react';

interface Conflict {
  id: string;
  deckId: string;
  cardId: string;
  source: string;
  detectedAt: string;
  incomingFields: Record<string, string>;
  localFields: Record<string, string>;
}

interface Props {
  conflicts: Conflict[];
  onResolve: (conflictId: string, resolution: 'local' | 'incoming' | 'skip') => void;
}

function highlightDiff(local: string, incoming: string, side: 'local' | 'incoming') {
  if (local === incoming) return <>{side === 'local' ? local : incoming}</>;

  const localWords = local.split(/(\s+)/);
  const incomingWords = incoming.split(/(\s+)/);

  if (side === 'local') {
    return <>{localWords.map((word, i) => {
      if (!incomingWords.includes(word) && word.trim()) {
        return <mark className="conflict-changed" key={i}>{word}</mark>;
      }
      return <span key={i}>{word}</span>;
    })}</>;
  }

  return <>{incomingWords.map((word, i) => {
    if (!localWords.includes(word) && word.trim()) {
      return <mark className="conflict-changed" key={i}>{word}</mark>;
    }
    return <span key={i}>{word}</span>;
  })}</>;
}

function ConflictResolution({ conflicts, onResolve }: Props) {
  const [index, setIndex] = useState(0);
  const conflict = conflicts[index];

  if (!conflict) return null;

  const allKeys = Array.from(new Set([...Object.keys(conflict.localFields), ...Object.keys(conflict.incomingFields)]));
  const cardPreview = Object.values(conflict.localFields)[0] || conflict.cardId;

  return (
    <div className="conflict-panel">
      <div className="conflict-header">
        <div>
          <strong>Sync Conflict — {conflict.source}</strong>
          <span className="conflict-progress">Conflict {index + 1} of {conflicts.length}</span>
        </div>
        <small>Card: {cardPreview}</small>
      </div>

      <div className="conflict-diff">
        {allKeys.map((key) => {
          const localVal = conflict.localFields[key] ?? '';
          const incomingVal = conflict.incomingFields[key] ?? '';
          const hasChange = localVal !== incomingVal;

          return (
            <div className="conflict-field" key={key}>
              <div className="conflict-field-label">{key}</div>
              <div className="conflict-side conflict-side-local">
                <small>Local</small>
                <div>{hasChange ? highlightDiff(localVal, incomingVal, 'local') : localVal}</div>
              </div>
              <div className="conflict-side conflict-side-incoming">
                <small>Incoming</small>
                <div>{hasChange ? highlightDiff(localVal, incomingVal, 'incoming') : incomingVal}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="conflict-actions">
        <button
          className="button secondary"
          onClick={() => {
            onResolve(conflict.id, 'local');
            if (index < conflicts.length - 1) setIndex((i) => i + 1);
          }}
        >
          Keep Local
        </button>
        <button
          className="button secondary"
          onClick={() => {
            onResolve(conflict.id, 'incoming');
            if (index < conflicts.length - 1) setIndex((i) => i + 1);
          }}
        >
          Keep Incoming
        </button>
        <button
          className="button primary"
          onClick={() => {
            onResolve(conflict.id, 'skip');
            if (index < conflicts.length - 1) setIndex((i) => i + 1);
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

export { ConflictResolution };
export type { Conflict, Props };
