import { useEffect, useMemo, useState } from 'react';

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

type Resolution = 'local' | 'incoming' | 'skip';

interface StoredDecision {
  resolution: Resolution;
  decidedAt: string;
  deckId: string;
  cardId: string;
  source: string;
}

type StoredDecisions = Record<string, StoredDecision>;

const STORAGE_PREFIX = 'deckbridge-conflict-decisions';

function hashParts(parts: string[]) {
  const input = parts.join('|');
  let hash = 0;

  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function getStorageKey(conflicts: Conflict[]) {
  const deckIds = Array.from(new Set(conflicts.map((conflict) => conflict.deckId).filter(Boolean))).sort();

  if (deckIds.length) {
    return `${STORAGE_PREFIX}:deck:${deckIds.join(',')}`;
  }

  const conflictIds = conflicts.map((conflict) => conflict.id).sort();
  return `${STORAGE_PREFIX}:set:${hashParts(conflictIds)}`;
}

function isResolution(value: unknown): value is Resolution {
  return value === 'local' || value === 'incoming' || value === 'skip';
}

function readStoredDecisions(storageKey: string): StoredDecisions {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, Partial<StoredDecision>>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, decision]) => isResolution(decision?.resolution))
        .map(([conflictId, decision]) => [conflictId, {
          resolution: decision.resolution as Resolution,
          decidedAt: decision.decidedAt || '',
          deckId: decision.deckId || '',
          cardId: decision.cardId || '',
          source: decision.source || ''
        }])
    );
  } catch {
    return {};
  }
}

function writeStoredDecisions(storageKey: string, decisions: StoredDecisions) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(decisions));
  } catch {
    // Storage may be unavailable in private browsing, SSR, or locked-down embeds.
  }
}

function clearStoredDecisions(storageKey: string) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore storage failures; conflict review should continue without persistence.
  }
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
  const storageKey = useMemo(() => getStorageKey(conflicts), [conflicts]);
  const [view, setView] = useState<'unresolved' | 'all'>('unresolved');
  const [decisions, setDecisions] = useState<StoredDecisions>(() => readStoredDecisions(storageKey));
  const [index, setIndex] = useState(0);
  const visibleConflicts = useMemo(() => {
    if (view === 'all') return conflicts;
    return conflicts.filter((item) => !decisions[item.id]);
  }, [conflicts, decisions, view]);
  const conflict = visibleConflicts[index];
  const decidedCount = conflicts.filter((item) => decisions[item.id]).length;
  const unresolvedCount = conflicts.length - decidedCount;

  useEffect(() => {
    setDecisions(readStoredDecisions(storageKey));
    setIndex(0);
    setView('unresolved');
  }, [storageKey]);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(visibleConflicts.length - 1, 0)));
  }, [visibleConflicts.length]);

  const recordDecision = (selectedConflict: Conflict, resolution: Resolution) => {
    const nextDecisions = {
      ...decisions,
      [selectedConflict.id]: {
        resolution,
        decidedAt: new Date().toISOString(),
        deckId: selectedConflict.deckId,
        cardId: selectedConflict.cardId,
        source: selectedConflict.source
      }
    };

    setDecisions(nextDecisions);
    writeStoredDecisions(storageKey, nextDecisions);
    onResolve(selectedConflict.id, resolution);
    if (index < visibleConflicts.length - 1) setIndex((i) => i + 1);
  };

  const resetProgress = () => {
    clearStoredDecisions(storageKey);
    setDecisions({});
    setIndex(0);
    setView('unresolved');
  };

  if (!conflict) {
    return (
      <div className="conflict-panel">
        <div className="conflict-header conflict-header-stacked">
          <div>
            <strong>Sync Conflicts</strong>
            <span className="conflict-progress">{unresolvedCount} unresolved</span>
          </div>
          <small>{decidedCount} saved decision{decidedCount === 1 ? '' : 's'}</small>
        </div>
        <div className="conflict-empty">
          <strong>No unresolved conflicts in this saved review.</strong>
          <span>Review decided conflicts or reset saved progress to run through this set again.</span>
          <div className="conflict-empty-actions">
            <button className="button secondary" disabled={!decidedCount} onClick={() => setView('all')}>
              Review Decided
            </button>
            <button className="button danger-outline" disabled={!decidedCount} onClick={resetProgress}>
              Reset Progress
            </button>
          </div>
        </div>
      </div>
    );
  }

  const allKeys = Array.from(new Set([...Object.keys(conflict.localFields), ...Object.keys(conflict.incomingFields)]));
  const cardPreview = Object.values(conflict.localFields)[0] || conflict.cardId;
  const currentDecision = decisions[conflict.id];

  return (
    <div className="conflict-panel">
      <div className="conflict-header">
        <div>
          <strong>Sync Conflict — {conflict.source}</strong>
          <span className="conflict-progress">Conflict {index + 1} of {visibleConflicts.length}</span>
          {currentDecision ? (
            <span className="conflict-decision">Decided: {currentDecision.resolution}</span>
          ) : null}
        </div>
        <small>Card: {cardPreview}</small>
      </div>

      <div className="conflict-controls" aria-label="Conflict review controls">
        <label>
          View
          <select value={view} onChange={(event) => {
            setView(event.target.value === 'all' ? 'all' : 'unresolved');
            setIndex(0);
          }}>
            <option value="unresolved">Unresolved only ({unresolvedCount})</option>
            <option value="all">All conflicts ({conflicts.length})</option>
          </select>
        </label>
        <div className="conflict-control-summary">
          <strong>{decidedCount}</strong>
          <span>saved decision{decidedCount === 1 ? '' : 's'}</span>
        </div>
        <button className="button danger-outline" disabled={!decidedCount} onClick={resetProgress}>
          Reset Progress
        </button>
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
        <button className="button secondary" disabled={index === 0} onClick={() => setIndex((i) => Math.max(i - 1, 0))}>
          Previous
        </button>
        <button className="button secondary" disabled={index >= visibleConflicts.length - 1} onClick={() => setIndex((i) => Math.min(i + 1, visibleConflicts.length - 1))}>
          Next
        </button>
        <button
          className="button secondary"
          disabled={Boolean(currentDecision)}
          onClick={() => {
            recordDecision(conflict, 'local');
          }}
        >
          Keep Local
        </button>
        <button
          className="button secondary"
          disabled={Boolean(currentDecision)}
          onClick={() => {
            recordDecision(conflict, 'incoming');
          }}
        >
          Keep Incoming
        </button>
        <button
          className="button primary"
          disabled={Boolean(currentDecision)}
          onClick={() => {
            recordDecision(conflict, 'skip');
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
