import { useState, useCallback, useEffect, useRef } from 'react';
import type { DeckCard } from './types';
import { api } from './api';
import { renderMediaHtml } from './media';
import {
  type CardProgress,
  type Rating,
  applyRating,
  buildStudyQueue,
  initialProgress,
  loadProgress,
  loadServerProgress,
  saveProgress,
  syncProgressToServer,
} from './sm2';

interface Props {
  deckId: string;
  cards: DeckCard[];
  modeLabel?: string;
  onClose: () => void;
}

function fieldVal(card: DeckCard, key: string) {
  return card.fields[key] ?? card.fields[key.toLowerCase()] ?? Object.values(card.fields)[0] ?? '';
}

const RATING_LABELS: Record<Rating, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};
const RATING_COLORS: Record<Rating, string> = {
  1: 'rating-again',
  2: 'rating-hard',
  3: 'rating-good',
  4: 'rating-easy',
};

interface SessionStats {
  again: number;
  hard: number;
  good: number;
  easy: number;
  skipped: number;
}

const initialSessionStats: SessionStats = {
  again: 0,
  hard: 0,
  good: 0,
  easy: 0,
  skipped: 0,
};

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable;
}

export function StudyView({ deckId, cards, modeLabel = 'Due cards', onClose }: Props) {
  const [allProgress, setAllProgress] = useState<Record<string, CardProgress>>(() =>
    loadProgress(deckId)
  );
  const [queue, setQueue] = useState<string[]>(() =>
    buildStudyQueue(cards.map((c) => c.id), loadProgress(deckId))
  );
  const [queueIndex, setQueueIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [sessionStats, setSessionStats] = useState<SessionStats>(initialSessionStats);
  const [done, setDone] = useState(false);
  const [serverProgressLoaded, setServerProgressLoaded] = useState(false);
  const [sessionSaved, setSessionSaved] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const sessionSavedRef = useRef(false);
  const startedAtRef = useRef(new Date().toISOString());
  const startTime = useRef(Date.now());

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });

    return () => {
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setServerProgressLoaded(false);
    loadServerProgress(deckId).then(() => {
      if (cancelled) return;
      const fresh = loadProgress(deckId);
      setAllProgress(fresh);
      setQueue(buildStudyQueue(cards.map((c) => c.id), fresh));
    }).finally(() => {
      if (!cancelled) setServerProgressLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [deckId, cards]);

  const currentCardId = queue[queueIndex];
  const currentCard = cards.find((c) => c.id === currentCardId);

  // Persist whenever progress changes
  useEffect(() => {
    saveProgress(deckId, allProgress);
  }, [deckId, allProgress]);

  const advanceQueue = useCallback((currentQueue: string[], currentIndex: number) => {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= currentQueue.length) {
      setDone(true);
      setQueueIndex(nextIndex);
      setFlipped(false);
      return;
    }
    setQueueIndex(nextIndex);
    setFlipped(false);
  }, []);

  const rate = useCallback((rating: Rating) => {
    if (!currentCardId) return;
    const prev = allProgress[currentCardId] ?? initialProgress(currentCardId);
    const next = applyRating(prev, rating);
    const updated = { ...allProgress, [currentCardId]: next };
    const nextQueue = rating === 1 ? [...queue, currentCardId] : queue;
    setAllProgress(updated);
    syncProgressToServer(deckId, currentCardId, next);
    setSessionStats((s) => ({
      ...s,
      again: s.again + (rating === 1 ? 1 : 0),
      hard: s.hard + (rating === 2 ? 1 : 0),
      good: s.good + (rating === 3 ? 1 : 0),
      easy: s.easy + (rating === 4 ? 1 : 0),
    }));

    // If "Again", push card to end of queue
    if (rating === 1) {
      setQueue(nextQueue);
    }

    advanceQueue(nextQueue, queueIndex);
  }, [currentCardId, allProgress, queue, deckId, advanceQueue, queueIndex]);

  const skipCard = useCallback(() => {
    if (!currentCardId) return;
    setSessionStats((s) => ({
      ...s,
      skipped: s.skipped + 1,
    }));
    advanceQueue(queue, queueIndex);
  }, [currentCardId, advanceQueue, queue, queueIndex]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isEditableShortcutTarget(e.target)) return;
      if (e.key === ' ' || e.key === 'Enter') {
        if (!flipped) setFlipped(true);
        else rate(3);
      } else if (flipped) {
        if (e.key === '1') rate(1);
        else if (e.key === '2') rate(2);
        else if (e.key === '3') rate(3);
        else if (e.key === '4') rate(4);
      }
      if (e.key === 's') skipCard();
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flipped, rate, skipCard, onClose]);

  const elapsed = Math.round((Date.now() - startTime.current) / 1000);
  const totalRated = sessionStats.again + sessionStats.hard + sessionStats.good + sessionStats.easy;
  const accuracy = totalRated ? Math.round(((sessionStats.good + sessionStats.easy) / totalRated) * 100) : 0;
  const totalActivity = totalRated + sessionStats.skipped;
  const remaining = Math.max(queue.length - queueIndex, 0);
  const progressCurrent = queue.length === 0 ? 0 : Math.min(queueIndex + 1, queue.length);
  const progressPercent = queue.length === 0 ? 100 : Math.round((progressCurrent / queue.length) * 100);

  const persistSessionSummary = useCallback(() => {
    if (!serverProgressLoaded || totalActivity === 0) return;
    if (sessionSavedRef.current) return;
    sessionSavedRef.current = true;
    setSessionSaved(true);
    const endedAt = new Date().toISOString();
    const cardsStudied = sessionStats.again + sessionStats.hard + sessionStats.good + sessionStats.easy;
    api.createStudySession({
      deckId,
      startedAt: startedAtRef.current,
      endedAt,
      durationSeconds: Math.round((Date.now() - startTime.current) / 1000),
      cardsStudied,
      cardsCorrect: sessionStats.good + sessionStats.easy,
      newCards: 0,
      reviewCards: cardsStudied,
      metadata: {
        ratings: sessionStats,
        modeLabel,
      },
    }).catch(() => undefined);
  }, [deckId, modeLabel, serverProgressLoaded, sessionStats, totalActivity]);

  useEffect(() => {
    if (serverProgressLoaded && done) {
      persistSessionSummary();
    }
  }, [done, persistSessionSummary, serverProgressLoaded]);

  if (!serverProgressLoaded && queue.length === 0 && !done) {
    return (
      <div className="study-overlay" role="dialog" aria-modal="true" aria-labelledby="study-title">
        <div className="study-panel study-done" ref={panelRef} tabIndex={-1}>
          <h2 id="study-title">Loading study session</h2>
          <p className="study-empty-msg">Checking current card progress...</p>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Cancel study session">Cancel</button>
        </div>
      </div>
    );
  }

  if ((serverProgressLoaded && queue.length === 0) || done) {
    return (
      <div className="study-overlay" role="dialog" aria-modal="true" aria-labelledby="study-title">
        <div className="study-panel study-done" ref={panelRef} tabIndex={-1}>
          <h2 id="study-title">Session complete</h2>
          <div className="study-stats-grid">
            <div><span className="stat-value">{totalRated}</span><span className="stat-label">Cards reviewed</span></div>
            <div><span className="stat-value">{accuracy}%</span><span className="stat-label">Accuracy</span></div>
            <div><span className="stat-value">{elapsed}s</span><span className="stat-label">Time spent</span></div>
          </div>
          <div className="study-rating-breakdown">
            <span className="rating-again">Again: {sessionStats.again}</span>
            <span className="rating-hard">Hard: {sessionStats.hard}</span>
            <span className="rating-good">Good: {sessionStats.good}</span>
            <span className="rating-easy">Easy: {sessionStats.easy}</span>
            <span className="rating-skipped">Skipped: {sessionStats.skipped}</span>
          </div>
          {queue.length === 0 && <p className="study-empty-msg">No cards are due right now. Come back tomorrow!</p>}
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  if (!currentCard) {
    return (
      <div className="study-overlay" role="dialog" aria-modal="true" aria-labelledby="study-title">
        <div className="study-panel study-done" ref={panelRef} tabIndex={-1}>
          <h2 id="study-title" className="sr-only">Study mode</h2>
          <p>Session complete!</p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="study-overlay" role="dialog" aria-modal="true" aria-labelledby="study-title">
      <div className="study-panel" ref={panelRef} tabIndex={-1}>
        <h2 id="study-title" className="sr-only">Study mode</h2>
        <div className="study-header">
          <div
            className="study-progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={queue.length}
            aria-valuenow={progressCurrent}
            aria-valuetext={`Card ${progressCurrent} of ${queue.length}`}
            aria-label="Study progress"
          >
            <div
              className="study-progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="study-meta" aria-live="polite">
            <span aria-label="Study session progress">Card {progressCurrent} of {queue.length}</span>
            <span>{remaining} remaining</span>
            <span>{modeLabel}</span>
            <span>{accuracy}% accuracy</span>
            {sessionSaved && <span>Session saved</span>}
            <button className="btn btn-ghost study-close" onClick={onClose} aria-label="Exit study mode">✕</button>
          </div>
        </div>

        <div
          className={`study-card ${flipped ? 'flipped' : ''}`}
          onClick={() => !flipped && setFlipped(true)}
          role="button"
          tabIndex={0}
          aria-label={flipped ? 'Card answer' : 'Card question — click to reveal'}
          onKeyDown={(e) => e.key === 'Enter' && !flipped && setFlipped(true)}
        >
          <div className="study-card-face study-card-front">
            <div
              className="study-card-content"
              dangerouslySetInnerHTML={{ __html: renderMediaHtml(deckId, fieldVal(currentCard, 'Front')) }}
            />
            {!flipped && <span className="study-flip-hint">Click or press Space to reveal</span>}
          </div>
          {flipped && (
            <div className="study-card-face study-card-back">
              <hr className="study-divider" />
              <div
                className="study-card-content"
                dangerouslySetInnerHTML={{ __html: renderMediaHtml(deckId, fieldVal(currentCard, 'Back')) }}
              />
            </div>
          )}
        </div>

        {flipped ? (
          <div className="study-rating-row">
            <button
              className="btn study-rate-btn study-skip rating-skipped"
              onClick={skipCard}
              aria-label="Skip card"
            >
              <span className="rate-label">Skip</span>
              <kbd>S</kbd>
            </button>
            {([1, 2, 3, 4] as Rating[]).map((r) => (
              <button
                key={r}
                className={`btn study-rate-btn ${RATING_COLORS[r]}`}
                onClick={() => rate(r)}
                aria-label={`Rate ${RATING_LABELS[r]}`}
              >
                <span className="rate-label">{RATING_LABELS[r]}</span>
                <kbd>{r}</kbd>
              </button>
            ))}
          </div>
        ) : (
          <div className="study-rating-row study-rating-placeholder">
            <button
              className="btn study-rate-btn study-skip rating-skipped"
              onClick={skipCard}
              aria-label="Skip card"
            >
              <span className="rate-label">Skip</span>
              <kbd>S</kbd>
            </button>
            <span>Rate yourself after reviewing the answer</span>
          </div>
        )}
      </div>
    </div>
  );
}
