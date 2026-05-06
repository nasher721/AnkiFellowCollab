import { useState, useCallback, useEffect, useRef } from 'react';
import type { DeckCard } from './types';
import {
  type CardProgress,
  type Rating,
  applyRating,
  buildStudyQueue,
  initialProgress,
  loadProgress,
  saveProgress,
} from './sm2';

interface Props {
  deckId: string;
  cards: DeckCard[];
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

export function StudyView({ deckId, cards, onClose }: Props) {
  const [allProgress, setAllProgress] = useState<Record<string, CardProgress>>(() =>
    loadProgress(deckId)
  );
  const [queue, setQueue] = useState<string[]>(() =>
    buildStudyQueue(cards.map((c) => c.id), loadProgress(deckId))
  );
  const [queueIndex, setQueueIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [sessionStats, setSessionStats] = useState({ again: 0, hard: 0, good: 0, easy: 0 });
  const [done, setDone] = useState(false);
  const startTime = useRef(Date.now());

  const currentCardId = queue[queueIndex];
  const currentCard = cards.find((c) => c.id === currentCardId);

  // Persist whenever progress changes
  useEffect(() => {
    saveProgress(deckId, allProgress);
  }, [deckId, allProgress]);

  const rate = useCallback((rating: Rating) => {
    if (!currentCardId) return;
    const prev = allProgress[currentCardId] ?? initialProgress(currentCardId);
    const next = applyRating(prev, rating);
    const updated = { ...allProgress, [currentCardId]: next };
    setAllProgress(updated);
    setSessionStats((s) => ({
      ...s,
      again: s.again + (rating === 1 ? 1 : 0),
      hard: s.hard + (rating === 2 ? 1 : 0),
      good: s.good + (rating === 3 ? 1 : 0),
      easy: s.easy + (rating === 4 ? 1 : 0),
    }));

    // If "Again", push card to end of queue
    if (rating === 1) {
      setQueue((q) => [...q, currentCardId]);
    }

    const nextIndex = queueIndex + 1;
    if (nextIndex >= queue.length || (rating !== 1 && nextIndex >= queue.length)) {
      const newQueue = buildStudyQueue(cards.map((c) => c.id), updated);
      if (newQueue.length === 0) {
        setDone(true);
        return;
      }
    }
    setQueueIndex(nextIndex);
    setFlipped(false);
  }, [currentCardId, allProgress, queueIndex, queue, cards]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === ' ' || e.key === 'Enter') {
        if (!flipped) setFlipped(true);
        else rate(3);
      } else if (flipped) {
        if (e.key === '1') rate(1);
        else if (e.key === '2') rate(2);
        else if (e.key === '3') rate(3);
        else if (e.key === '4') rate(4);
      }
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flipped, rate, onClose]);

  const elapsed = Math.round((Date.now() - startTime.current) / 1000);
  const totalRated = sessionStats.again + sessionStats.hard + sessionStats.good + sessionStats.easy;
  const accuracy = totalRated ? Math.round(((sessionStats.good + sessionStats.easy) / totalRated) * 100) : 0;
  const remaining = queue.length - queueIndex;

  if (queue.length === 0 || done) {
    return (
      <div className="study-overlay" role="dialog" aria-modal="true">
        <div className="study-panel study-done">
          <h2>Session complete</h2>
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
          </div>
          {queue.length === 0 && <p className="study-empty-msg">No cards are due right now. Come back tomorrow!</p>}
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  if (!currentCard) {
    return (
      <div className="study-overlay" role="dialog" aria-modal="true">
        <div className="study-panel study-done">
          <p>Session complete!</p>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="study-overlay" role="dialog" aria-modal="true" aria-label="Study mode">
      <div className="study-panel">
        <div className="study-header">
          <div className="study-progress-bar">
            <div
              className="study-progress-fill"
              style={{ width: `${Math.round((queueIndex / queue.length) * 100)}%` }}
            />
          </div>
          <div className="study-meta">
            <span>{remaining} remaining</span>
            <span>{accuracy}% accuracy</span>
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
              dangerouslySetInnerHTML={{ __html: fieldVal(currentCard, 'Front') }}
            />
            {!flipped && <span className="study-flip-hint">Click or press Space to reveal</span>}
          </div>
          {flipped && (
            <div className="study-card-face study-card-back">
              <hr className="study-divider" />
              <div
                className="study-card-content"
                dangerouslySetInnerHTML={{ __html: fieldVal(currentCard, 'Back') }}
              />
            </div>
          )}
        </div>

        {flipped ? (
          <div className="study-rating-row">
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
            <span>Rate yourself after reviewing the answer</span>
          </div>
        )}
      </div>
    </div>
  );
}
