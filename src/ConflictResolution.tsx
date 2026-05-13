import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { AiArtifact, AiConflictSummaryPayload } from './types';

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
  pendingConflictIds?: string[];
  onResolve: (conflictId: string, resolution: 'local' | 'incoming' | 'skip') => void;
  onClearReview?: () => void;
}

type Resolution = 'local' | 'incoming' | 'skip';

interface StoredDecision {
  resolution: Resolution;
  decidedAt: string;
  deckId: string;
  cardId: string;
  source: string;
  detectedAt: string;
  fingerprint: string;
}

type StoredDecisions = Record<string, StoredDecision>;
type SummaryState = Record<string, { artifact: AiArtifact | null; loading: boolean; message: string }>;

const STORAGE_PREFIX = 'deckbridge-conflict-decisions';

function hashParts(parts: string[]) {
  const input = parts.join('|');
  let hash = 0;

  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function stableRecordFingerprint(record: Record<string, string>) {
  return Object.keys(record)
    .sort()
    .map((key) => `${key}:${record[key]}`)
    .join('\u001f');
}

function getConflictFingerprint(conflict: Conflict) {
  return hashParts([
    conflict.id,
    conflict.deckId,
    conflict.cardId,
    conflict.source,
    conflict.detectedAt,
    stableRecordFingerprint(conflict.localFields),
    stableRecordFingerprint(conflict.incomingFields)
  ]);
}

function getStorageKey(conflicts: Conflict[]) {
  const deckIds = Array.from(new Set(conflicts.flatMap((conflict) => conflict.deckId ? [conflict.deckId] : []))).sort();
  const conflictSetFingerprint = hashParts(conflicts
    .map((conflict) => getConflictFingerprint(conflict))
    .sort());

  if (deckIds.length) {
    return `${STORAGE_PREFIX}:deck:${deckIds.join(',')}:set:${conflictSetFingerprint}`;
  }

  return `${STORAGE_PREFIX}:set:${conflictSetFingerprint}`;
}

function isResolution(value: unknown): value is Resolution {
  return value === 'local' || value === 'incoming' || value === 'skip';
}

function isConflictSummaryPayload(value: unknown): value is AiConflictSummaryPayload {
  const payload = value as Partial<AiConflictSummaryPayload>;
  return Boolean(
    payload &&
    typeof payload.summary === 'string' &&
    typeof payload.rationale === 'string' &&
    (payload.risk === 'low' || payload.risk === 'medium' || payload.risk === 'high') &&
    (payload.recommendation === 'keep-local' || payload.recommendation === 'use-incoming' || payload.recommendation === 'skip-for-now' || payload.recommendation === 'manual-review')
  );
}

function readStoredDecisions(storageKey: string, conflicts: Conflict[]): StoredDecisions {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, Partial<StoredDecision>>;
    const conflictFingerprints = new Map(conflicts.map((conflict) => [conflict.id, getConflictFingerprint(conflict)]));

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([conflictId, decision]) => {
        if (!isResolution(decision?.resolution) || decision.fingerprint !== conflictFingerprints.get(conflictId)) return [];
        return [[conflictId, {
          resolution: decision.resolution as Resolution,
          decidedAt: decision.decidedAt || '',
          deckId: decision.deckId || '',
          cardId: decision.cardId || '',
          source: decision.source || '',
          detectedAt: decision.detectedAt || '',
          fingerprint: decision.fingerprint || ''
        }]];
      })
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

function saveConflictDecision(conflicts: Conflict[], selectedConflict: Conflict, resolution: Resolution, decidedAt = new Date().toISOString()) {
  const storageKey = getStorageKey(conflicts);
  const decisions = readStoredDecisions(storageKey, conflicts);
  const nextDecisions = {
    ...decisions,
    [selectedConflict.id]: {
      resolution,
      decidedAt,
      deckId: selectedConflict.deckId,
      cardId: selectedConflict.cardId,
      source: selectedConflict.source,
      detectedAt: selectedConflict.detectedAt,
      fingerprint: getConflictFingerprint(selectedConflict)
    }
  };

  writeStoredDecisions(storageKey, nextDecisions);
  return nextDecisions;
}

function readSavedConflictDecisions(conflicts: Conflict[]) {
  return readStoredDecisions(getStorageKey(conflicts), conflicts);
}

function highlightDiff(local: string, incoming: string, side: 'local' | 'incoming') {
  if (local === incoming) return <>{side === 'local' ? local : incoming}</>;

  const localWords = local.split(/(\s+)/);
  const incomingWords = incoming.split(/(\s+)/);

    if (side === 'local') {
    return <>{localWords.map((word, i) => {
      if (!incomingWords.includes(word) && word.trim()) {
        return <mark className="conflict-changed" aria-label={`Changed local text: ${word.trim()}`} key={`local-${i}`}>{word}</mark>;
      }
      return <span key={`local-${i}`}>{word}</span>;
    })}</>;
  }

  return <>{incomingWords.map((word, i) => {
    if (!localWords.includes(word) && word.trim()) {
      return <mark className="conflict-changed" aria-label={`Changed incoming text: ${word.trim()}`} key={`incoming-${i}`}>{word}</mark>;
    }
    return <span key={`incoming-${i}`}>{word}</span>;
  })}</>;
}

function ConflictResolution({ conflicts, pendingConflictIds, onResolve, onClearReview }: Props) {
  const storageKey = useMemo(() => getStorageKey(conflicts), [conflicts]);
  const pendingIds = useMemo(() => new Set(pendingConflictIds || conflicts.map((item) => item.id)), [conflicts, pendingConflictIds]);
  const [view, setView] = useState<'unresolved' | 'all'>('unresolved');
  const [decisions, setDecisions] = useState<StoredDecisions>(() => readStoredDecisions(storageKey, conflicts));
  const [summaries, setSummaries] = useState<SummaryState>({});
  const [index, setIndex] = useState(0);
  const replayedRef = useRef<Set<string>>(new Set());
  const visibleConflicts = useMemo(() => {
    if (view === 'all') return conflicts;
    return conflicts.filter((item) => !decisions[item.id]);
  }, [conflicts, decisions, view]);
  const safeIndex = Math.min(index, Math.max(visibleConflicts.length - 1, 0));
  const conflict = visibleConflicts[safeIndex];
  const decidedCount = conflicts.filter((item) => decisions[item.id]).length;
  const unresolvedCount = conflicts.length - decidedCount;
  const pendingCount = conflicts.filter((item) => pendingIds.has(item.id)).length;

  useEffect(() => {
    setDecisions(readStoredDecisions(storageKey, conflicts));
    setIndex(0);
    setView('unresolved');
    replayedRef.current = new Set();
  }, [storageKey]);

  useEffect(() => {
    let cancelled = false;
    const deckIds = Array.from(new Set(conflicts.flatMap((item) => item.deckId ? [item.deckId] : [])));
    if (!deckIds.length) {
      setSummaries({});
      return () => { cancelled = true; };
    }
    Promise.all(deckIds.map((deckId) => api.aiArtifacts.list(deckId, {
      kind: 'conflict-summary',
      subjectType: 'conflict',
      status: 'active'
    }).catch(() => ({ artifacts: [] }))))
      .then((responses) => {
        if (cancelled) return;
        const next: SummaryState = {};
        for (const response of responses) {
          for (const artifact of response.artifacts) {
            next[artifact.subjectId] = { artifact, loading: false, message: '' };
          }
        }
        setSummaries(next);
      });
    return () => { cancelled = true; };
  }, [storageKey, conflicts]);

  useEffect(() => {
    replayedRef.current.forEach((conflictId) => {
      if (!pendingIds.has(conflictId)) replayedRef.current.delete(conflictId);
    });

    conflicts.forEach((item) => {
      const decision = decisions[item.id];
      if (!decision || !pendingIds.has(item.id) || replayedRef.current.has(item.id)) return;

      replayedRef.current.add(item.id);
      onResolve(item.id, decision.resolution);
    });
  }, [conflicts, decisions, onResolve, pendingIds]);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(visibleConflicts.length - 1, 0)));
  }, [visibleConflicts.length]);

  const recordDecision = (selectedConflict: Conflict, resolution: Resolution) => {
    const isPending = pendingIds.has(selectedConflict.id);
    const nextDecisions = saveConflictDecision(conflicts, selectedConflict, resolution);

    setDecisions(nextDecisions);
    if (isPending) {
      replayedRef.current.add(selectedConflict.id);
      onResolve(selectedConflict.id, resolution);
    }
    if (view === 'all' && safeIndex < visibleConflicts.length - 1) setIndex((i) => i + 1);
  };

  const resetProgress = () => {
    clearStoredDecisions(storageKey);
    setDecisions({});
    setIndex(0);
    setView('unresolved');
    if (pendingCount === 0) onClearReview?.();
  };

  const generateSummary = async (selectedConflict: Conflict) => {
    setSummaries((current) => ({
      ...current,
      [selectedConflict.id]: {
        artifact: current[selectedConflict.id]?.artifact || null,
        loading: true,
        message: ''
      }
    }));
    try {
      const result = await api.aiConflictSummaries.generate(selectedConflict.deckId, selectedConflict.id);
      setSummaries((current) => ({
        ...current,
        [selectedConflict.id]: {
          artifact: result.artifact,
          loading: false,
          message: result.status === 'created' ? '' : (result.message || 'AI conflict summary is unavailable.')
        }
      }));
    } catch (err) {
      setSummaries((current) => ({
        ...current,
        [selectedConflict.id]: {
          artifact: current[selectedConflict.id]?.artifact || null,
          loading: false,
          message: err instanceof Error ? err.message : 'AI conflict summary is unavailable.'
        }
      }));
    }
  };

  if (!conflict) {
    return (
      <div className="conflict-panel">
        <div className="conflict-header conflict-header-stacked">
          <div>
            <strong>Sync Conflicts</strong>
            <span className="conflict-progress">{unresolvedCount} unresolved</span>
          </div>
          <small>{decidedCount} saved decision{decidedCount === 1 ? '' : 's'} · {pendingCount} pending</small>
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
            {onClearReview ? (
              <button className="button secondary" disabled={pendingCount > 0} onClick={onClearReview}>
                Clear Review
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const allKeys = Array.from(new Set([...Object.keys(conflict.localFields), ...Object.keys(conflict.incomingFields)]));
  const cardPreview = Object.values(conflict.localFields)[0] || conflict.cardId;
  const currentDecision = decisions[conflict.id];
  const summaryState = summaries[conflict.id];
  const summaryPayload = isConflictSummaryPayload(summaryState?.artifact?.payload) ? summaryState.artifact.payload : null;

  return (
    <div className="conflict-panel">
      <div className="conflict-header">
        <div>
          <strong>Sync Conflict: {conflict.source}</strong>
          <span className="conflict-progress">Conflict {safeIndex + 1} of {visibleConflicts.length}</span>
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

      <div className="wizard-test-card" aria-label="AI conflict summary">
        <strong>AI conflict summary</strong>
        {summaryPayload ? (
          <>
            <span>{summaryPayload.summary}</span>
            <span>Risk: {summaryPayload.risk} · Recommendation: {summaryPayload.recommendation.replaceAll('-', ' ')}</span>
            <span>{summaryPayload.rationale}</span>
            {summaryPayload.evidence?.length ? (
              <small>{summaryPayload.evidence.slice(0, 3).join(' · ')}</small>
            ) : null}
          </>
        ) : (
          <span>{summaryState?.message || 'Generate an advisory summary from the local and incoming fields.'}</span>
        )}
        <button
          className="button secondary"
          type="button"
          disabled={summaryState?.loading}
          onClick={() => generateSummary(conflict)}
        >
          {summaryState?.loading ? 'Generating...' : summaryPayload ? 'Refresh Summary' : 'Generate Summary'}
        </button>
      </div>

      <div className="conflict-diff" role="group" aria-label="Conflict field differences">
        {allKeys.map((key) => {
          const localVal = conflict.localFields[key] ?? '';
          const incomingVal = conflict.incomingFields[key] ?? '';
          const hasChange = localVal !== incomingVal;
          const fieldId = `conflict-${conflict.id}-${key}`.replace(/[^a-zA-Z0-9_-]/g, '-');

          return (
            <div className="conflict-field" role="group" aria-labelledby={fieldId} key={key}>
              <div className="conflict-field-label" id={fieldId}>{key}</div>
              <div className="conflict-side conflict-side-local" aria-label={`Local ${key}`}>
                <small>Local</small>
                <div>{hasChange ? highlightDiff(localVal, incomingVal, 'local') : localVal}</div>
              </div>
              <div className="conflict-side conflict-side-incoming" aria-label={`Incoming ${key}`}>
                <small>Incoming</small>
                <div>{hasChange ? highlightDiff(localVal, incomingVal, 'incoming') : incomingVal}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="conflict-actions">
        <button className="button secondary" disabled={safeIndex === 0} aria-label="Review previous conflict" onClick={() => setIndex((i) => Math.max(i - 1, 0))}>
          Previous
        </button>
        <button className="button secondary" disabled={safeIndex >= visibleConflicts.length - 1} aria-label="Review next conflict" onClick={() => setIndex((i) => Math.min(i + 1, visibleConflicts.length - 1))}>
          Next
        </button>
        <button
          className="button secondary"
          disabled={Boolean(currentDecision)}
          aria-label="Keep local version for this conflict"
          onClick={() => {
            recordDecision(conflict, 'local');
          }}
        >
          Keep Local
        </button>
        <button
          className="button secondary"
          disabled={Boolean(currentDecision)}
          aria-label="Keep incoming Anki version for this conflict"
          onClick={() => {
            recordDecision(conflict, 'incoming');
          }}
        >
          Keep Incoming
        </button>
        <button
          className="button primary"
          disabled={Boolean(currentDecision)}
          aria-label="Skip this conflict for now"
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

export { ConflictResolution, readSavedConflictDecisions, saveConflictDecision };
export type { Conflict, Props, Resolution };
