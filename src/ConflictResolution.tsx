import { useState } from 'react';

export interface Conflict {
  id: string;
  deckId: string;
  cardId: string;
  source: string;
  detectedAt: string;
  incomingFields: Record<string, string>;
  localFields: Record<string, string>;
}

export interface Props {
  conflicts: Conflict[];
  onResolve: (conflictId: string, resolution: 'local' | 'incoming' | 'skip') => Promise<void>;
}

// LCS-based token diff — marks tokens as removed/added compared to the other side.
type DiffToken = { text: string; kind: 'same' | 'removed' | 'added' };

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function diffTokens(localText: string, incomingText: string): { local: DiffToken[]; incoming: DiffToken[] } {
  if (localText === incomingText) {
    const same = tokenize(localText).map((t) => ({ text: t, kind: 'same' as const }));
    return { local: same, incoming: same };
  }

  const a = tokenize(localText);
  const b = tokenize(incomingText);
  const dp = lcs(a, b);

  const localOut: DiffToken[] = [];
  const incomingOut: DiffToken[] = [];

  let i = a.length;
  let j = b.length;
  const localDiff: Array<'same' | 'removed'> = new Array(a.length).fill('removed');
  const incomingDiff: Array<'same' | 'added'> = new Array(b.length).fill('added');

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      localDiff[i - 1] = 'same';
      incomingDiff[j - 1] = 'same';
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  for (let k = 0; k < a.length; k++) localOut.push({ text: a[k], kind: localDiff[k] });
  for (let k = 0; k < b.length; k++) incomingOut.push({ text: b[k], kind: incomingDiff[k] });

  return { local: localOut, incoming: incomingOut };
}

function DiffView({ tokens }: { tokens: DiffToken[] }) {
  return (
    <>
      {tokens.map((token, i) =>
        token.kind === 'same' ? (
          <span key={i}>{token.text}</span>
        ) : (
          <mark className={`conflict-changed conflict-changed-${token.kind}`} key={i}>{token.text}</mark>
        )
      )}
    </>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ConflictResolution({ conflicts, onResolve }: Props) {
  const [index, setIndex] = useState(0);
  const [resolving, setResolving] = useState<string | null>(null);
  const [batchResolving, setBatchResolving] = useState(false);

  const conflict = conflicts[index];

  if (!conflict) return null;

  const allKeys = Array.from(
    new Set([...Object.keys(conflict.localFields), ...Object.keys(conflict.incomingFields)])
  );
  const cardPreview = Object.values(conflict.localFields)[0]?.slice(0, 80) || conflict.cardId;
  const isLast = index === conflicts.length - 1;

  async function handleResolve(id: string, resolution: 'local' | 'incoming' | 'skip') {
    setResolving(resolution);
    try {
      await onResolve(id, resolution);
      // After resolving, stay at same index (next conflict slides in) unless we were at the end
      if (isLast && index > 0) setIndex((i) => i - 1);
    } finally {
      setResolving(null);
    }
  }

  async function handleBatchResolve(resolution: 'local' | 'incoming') {
    setBatchResolving(true);
    try {
      for (const c of conflicts) {
        await onResolve(c.id, resolution);
      }
      setIndex(0);
    } finally {
      setBatchResolving(false);
    }
  }

  const busy = resolving !== null || batchResolving;

  return (
    <div className="conflict-panel">
      <div className="conflict-header">
        <div>
          <strong>Sync Conflicts</strong>
          <span className="conflict-progress">
            {index + 1} / {conflicts.length}
            <button
              className="conflict-nav-btn"
              disabled={index === 0 || busy}
              onClick={() => setIndex((i) => i - 1)}
              aria-label="Previous conflict"
            >&#8249;</button>
            <button
              className="conflict-nav-btn"
              disabled={isLast || busy}
              onClick={() => setIndex((i) => i + 1)}
              aria-label="Next conflict"
            >&#8250;</button>
          </span>
        </div>
        <div className="conflict-meta">
          <small className="conflict-source">{conflict.source}</small>
          <small className="conflict-time">{relativeTime(conflict.detectedAt)}</small>
        </div>
      </div>

      <div className="conflict-card-preview">{cardPreview}</div>

      <div className="conflict-diff">
        {allKeys.map((key) => {
          const localVal = conflict.localFields[key] ?? '';
          const incomingVal = conflict.incomingFields[key] ?? '';
          const { local, incoming } = diffTokens(localVal, incomingVal);
          const hasChange = localVal !== incomingVal;

          return (
            <div className={`conflict-field${hasChange ? ' conflict-field-changed' : ''}`} key={key}>
              <div className="conflict-field-label">{key}</div>
              <div className="conflict-side conflict-side-local">
                <small>Current (local)</small>
                <div><DiffView tokens={local} /></div>
              </div>
              <div className="conflict-side conflict-side-incoming">
                <small>Incoming (Anki)</small>
                <div><DiffView tokens={incoming} /></div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="conflict-actions">
        <div className="conflict-actions-primary">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => handleResolve(conflict.id, 'local')}
          >
            {resolving === 'local' ? 'Saving…' : 'Keep Local'}
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => handleResolve(conflict.id, 'incoming')}
          >
            {resolving === 'incoming' ? 'Saving…' : 'Keep Incoming'}
          </button>
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => handleResolve(conflict.id, 'skip')}
          >
            {resolving === 'skip' ? '…' : 'Skip'}
          </button>
        </div>
        {conflicts.length > 1 && (
          <div className="conflict-actions-batch">
            <button
              className="button ghost conflict-batch-btn"
              disabled={busy}
              onClick={() => handleBatchResolve('local')}
            >
              {batchResolving ? 'Resolving…' : `Keep all ${conflicts.length} local`}
            </button>
            <button
              className="button ghost conflict-batch-btn"
              disabled={busy}
              onClick={() => handleBatchResolve('incoming')}
            >
              {batchResolving ? 'Resolving…' : `Keep all ${conflicts.length} incoming`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export { ConflictResolution };
