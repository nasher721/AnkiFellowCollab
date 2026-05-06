/** Lightweight SM-2 spaced-repetition algorithm (client-side). */

export type Rating = 1 | 2 | 3 | 4; // Again | Hard | Good | Easy

export interface CardProgress {
  cardId: string;
  interval: number;   // days until next review
  easeFactor: number; // multiplier (starts at 2.5)
  repetitions: number;
  nextDue: string;    // ISO date string
  lastRating: Rating | null;
}

const INITIAL_EASE = 2.5;
const MIN_EASE = 1.3;

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + Math.max(1, Math.round(days)));
  return d.toISOString();
}

export function initialProgress(cardId: string): CardProgress {
  return {
    cardId,
    interval: 1,
    easeFactor: INITIAL_EASE,
    repetitions: 0,
    nextDue: new Date().toISOString(),
    lastRating: null,
  };
}

/**
 * Apply an SM-2 rating and return updated progress.
 * Ratings: 1=Again, 2=Hard, 3=Good, 4=Easy
 */
export function applyRating(prev: CardProgress, rating: Rating): CardProgress {
  let { interval, easeFactor, repetitions } = prev;

  if (rating === 1) {
    // Again — reset
    repetitions = 0;
    interval = 1;
  } else {
    // Hard/Good/Easy — advance
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions += 1;
  }

  // Adjust ease factor
  const delta = 0.1 - (4 - rating) * (0.08 + (4 - rating) * 0.02);
  easeFactor = Math.max(MIN_EASE, easeFactor + delta);

  // Hard shortens interval slightly
  if (rating === 2) interval = Math.max(1, Math.round(interval * 0.8));
  // Easy extends interval
  if (rating === 4) interval = Math.round(interval * 1.3);

  return {
    cardId: prev.cardId,
    interval,
    easeFactor,
    repetitions,
    nextDue: addDays(interval),
    lastRating: rating,
  };
}

/** Load all progress from localStorage for a deck. */
export function loadProgress(deckId: string): Record<string, CardProgress> {
  try {
    const raw = localStorage.getItem(`db_study_${deckId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Persist progress to localStorage. */
export function saveProgress(deckId: string, all: Record<string, CardProgress>): void {
  try {
    localStorage.setItem(`db_study_${deckId}`, JSON.stringify(all));
  } catch {
    // storage full — silently continue
  }
}

/** Build a study queue: cards due today, sorted by due date. */
export function buildStudyQueue(
  cardIds: string[],
  all: Record<string, CardProgress>
): string[] {
  const now = new Date();
  return cardIds
    .map((id) => all[id] ?? initialProgress(id))
    .filter((p) => new Date(p.nextDue) <= now)
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime())
    .map((p) => p.cardId);
}

export async function syncProgressToServer(deckId: string, cardId: string, state: CardProgress) {
  try {
    const mod = await import('./api');
    await mod.api.syncStudyProgress([{
      deckId,
      cardId,
      intervalDays: state.interval,
      easeFactor: state.easeFactor,
      repetitions: state.repetitions,
      nextDue: state.nextDue,
      lastRating: state.lastRating ?? null
    }]);
  } catch {}
}

export async function loadServerProgress(deckId: string): Promise<void> {
  try {
    const mod = await import('./api');
    const { progress } = await mod.api.fetchStudyProgress(deckId);
    const all = loadProgress(deckId);
    for (const p of progress) {
      const existing = all[p.cardId];
      if (!existing || new Date(p.updatedAt) > new Date(existing.nextDue)) {
        all[p.cardId] = {
          cardId: p.cardId,
          interval: p.intervalDays,
          easeFactor: p.easeFactor,
          repetitions: p.repetitions,
          nextDue: p.nextDue,
          lastRating: (p.lastRating as Rating) ?? null
        };
      }
    }
    saveProgress(deckId, all);
  } catch {}
}
