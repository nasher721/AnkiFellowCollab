import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRating,
  buildStudyQueue,
  initialProgress,
  loadProgress,
  saveProgress,
  type CardProgress
} from './sm2';

const NOW = new Date('2026-05-07T12:00:00.000Z');

function progress(overrides: Partial<CardProgress> = {}): CardProgress {
  return {
    cardId: 'card-a',
    interval: 1,
    easeFactor: 2.5,
    repetitions: 0,
    nextDue: NOW.toISOString(),
    lastRating: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('SM-2 progress', () => {
  it('creates immediately due progress for a new card', () => {
    expect(initialProgress('new-card')).toEqual({
      cardId: 'new-card',
      interval: 1,
      easeFactor: 2.5,
      repetitions: 0,
      nextDue: NOW.toISOString(),
      lastRating: null
    });
  });

  it('resets repetitions for Again and lowers ease without going below the minimum', () => {
    const rated = applyRating(progress({
      interval: 12,
      easeFactor: 1.31,
      repetitions: 4
    }), 1);

    expect(rated).toMatchObject({
      cardId: 'card-a',
      interval: 1,
      easeFactor: 1.3,
      repetitions: 0,
      lastRating: 1
    });
    expect(rated.nextDue).toBe('2026-05-08T12:00:00.000Z');
  });

  it('advances first successful reviews and applies rating-specific ease changes', () => {
    const hard = applyRating(progress({ cardId: 'hard-card' }), 2);
    const good = applyRating(progress({ cardId: 'good-card' }), 3);
    const easy = applyRating(progress({ cardId: 'easy-card' }), 4);

    expect(hard).toMatchObject({
      cardId: 'hard-card',
      interval: 1,
      easeFactor: 2.36,
      repetitions: 1,
      lastRating: 2
    });
    expect(good).toMatchObject({
      cardId: 'good-card',
      interval: 1,
      easeFactor: 2.5,
      repetitions: 1,
      lastRating: 3
    });
    expect(easy).toMatchObject({
      cardId: 'easy-card',
      interval: 1,
      easeFactor: 2.6,
      repetitions: 1,
      lastRating: 4
    });
  });

  it('uses the six-day second interval and scales mature intervals by ease', () => {
    const secondGood = applyRating(progress({
      interval: 1,
      repetitions: 1
    }), 3);
    const matureEasy = applyRating(progress({
      interval: 10,
      easeFactor: 2,
      repetitions: 3
    }), 4);

    expect(secondGood).toMatchObject({
      interval: 6,
      repetitions: 2,
      lastRating: 3
    });
    expect(secondGood.nextDue).toBe('2026-05-13T12:00:00.000Z');

    expect(matureEasy).toMatchObject({
      interval: 26,
      easeFactor: 2.1,
      repetitions: 4,
      lastRating: 4
    });
    expect(matureEasy.nextDue).toBe('2026-06-02T12:00:00.000Z');
  });
});

describe('study queue and storage helpers', () => {
  it('filters to due cards and sorts them by oldest due date', () => {
    const queue = buildStudyQueue(['future', 'missing', 'old', 'now'], {
      future: progress({
        cardId: 'future',
        nextDue: '2026-05-08T12:00:00.000Z'
      }),
      old: progress({
        cardId: 'old',
        nextDue: '2026-05-01T12:00:00.000Z'
      }),
      now: progress({
        cardId: 'now',
        nextDue: NOW.toISOString()
      })
    });

    expect(queue).toEqual(['old', 'missing', 'now']);
  });

  it('round-trips progress through deck-scoped localStorage', () => {
    const all = {
      'card-a': progress({ repetitions: 2, lastRating: 3 })
    };

    saveProgress('deck-1', all);

    expect(JSON.parse(localStorage.getItem('db_study_deck-1') ?? '{}')).toEqual(all);
    expect(loadProgress('deck-1')).toEqual(all);
    expect(loadProgress('other-deck')).toEqual({});
  });

  it('returns empty progress when stored JSON is malformed', () => {
    localStorage.setItem('db_study_deck-1', '{bad json');

    expect(loadProgress('deck-1')).toEqual({});
  });
});
