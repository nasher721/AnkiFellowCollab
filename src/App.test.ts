import { afterEach, describe, expect, it, vi } from 'vitest';
import { authMessage, deriveOwnerReviewQueue, deriveSyncHealth, mergeHydratedDeckState, stateFromMeResponse, withAuthTimeout } from './App';
import type { AiQualityPulse, AppState, Suggestion } from './types';

const NOW = new Date('2026-05-09T12:00:00.000Z').getTime();

afterEach(() => {
  vi.useRealTimers();
});

function suggestion(overrides: Partial<Suggestion>): Suggestion {
  return {
    id: 'suggestion-1',
    deckId: 'deck-1',
    cardId: 'card-1',
    authorId: 'author-1',
    authorName: 'Maya Patel',
    status: 'pending',
    reason: 'Clarify wording',
    createdAt: '2026-05-09T10:00:00.000Z',
    proposedFields: { Front: 'Updated front' },
    proposedTags: ['review'],
    ...overrides
  };
}

function conflict(overrides: Partial<AppState['sync']['conflicts'][number]> = {}): AppState['sync']['conflicts'][number] {
  return {
    id: 'conflict-1',
    deckId: 'deck-1',
    cardId: 'card-conflict',
    source: 'Anki add-on',
    detectedAt: '2026-05-09T11:00:00.000Z',
    incomingFields: { Front: 'Incoming' },
    localFields: { Front: 'Local' },
    ...overrides
  };
}

function pulse(overrides: Partial<AiQualityPulse> = {}): AiQualityPulse {
  return {
    enabled: true,
    status: 'attention',
    generatedAt: '2026-05-09T12:00:00.000Z',
    totalActive: 2,
    summary: { bySeverity: {}, bySubjectType: {}, byStaleness: {} },
    groups: { severity: [], subjectType: [], staleness: [] },
    items: [
      {
        artifactId: 'artifact-quality',
        subjectType: 'card',
        subjectId: 'card-quality',
        kind: 'quality-issue',
        severity: 'medium',
        staleness: 'old',
        action: 'card',
        label: 'Stale quality issue',
        detail: 'The card needs another owner pass.',
        createdAt: '2026-05-09T09:00:00.000Z'
      },
      {
        artifactId: 'artifact-suggestion-1',
        subjectType: 'suggestion',
        subjectId: 'suggestion-1',
        kind: 'review-brief',
        severity: 'high',
        staleness: 'fresh',
        action: 'suggestion',
        label: 'AI brief for pending suggestion',
        detail: 'Duplicate of the pending suggestion.',
        createdAt: '2026-05-09T11:30:00.000Z'
      }
    ],
    ...overrides
  };
}

describe('deriveSyncHealth', () => {
  it('summarizes protocol strip facts and blocks on conflicts before healthy sync', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const health = deriveSyncHealth({
      activeDeck: {
        id: 'deck-1',
        name: 'Neuro ICU',
        description: '',
        owner: 'You',
        importedAt: '2026-05-01T00:00:00.000Z',
        lastSyncedAt: '2026-05-09T08:00:00.000Z',
        cards: [],
        media: {},
        source: { filename: 'neuro.apkg', format: 'apkg', deckPath: 'Boards::Neuro ICU' }
      },
      addonPackage: {
        loading: false,
        version: { version: '0.2.2', minVersion: '0.2.0', downloadUrl: '/downloads/deckbridge-sync.ankiaddon' },
        availability: { available: true, status: 200, message: 'Ready' },
        error: ''
      },
      apiHealth: 'ok',
      sync: {
        ankiConnectUrl: '',
        connected: true,
        lastCheckedAt: '2026-05-09T11:45:00.000Z',
        lastPullAt: null,
        lastPushAt: null,
        lastAddonSync: null,
        conflicts: [conflict()]
      }
    });

    expect(health.state).toBe('conflicts');
    expect(health.packageLabel).toBe('Add-on v0.2.2');
    expect(health.deckLabel).toBe('Neuro ICU');
    expect(health.localDeckLabel).toBe('Boards::Neuro ICU');
    expect(health.lastCheckedLabel).toBe('15m ago');
    expect(health.conflictLabel).toBe('1 conflict');
    expect(health.primaryAction).toBe('conflicts');
  });
});

describe('auth helpers', () => {
  it('turns network failures into a recoverable auth notice', () => {
    expect(authMessage('Failed to fetch', 'sign-in')).toContain('could not reach the auth provider');
  });

  it('rejects auth requests that hang beyond the timeout', async () => {
    vi.useFakeTimers();
    const request = withAuthTimeout(new Promise(() => undefined), 1000);
    const assertion = expect(request).rejects.toThrow('DeckBridge auth request timed out');

    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });
});

describe('authenticated boot helpers', () => {
  it('builds a lightweight workspace shell from /api/me without requiring card payloads', () => {
    const state = stateFromMeResponse({
      user: { id: 'you', email: 'you@example.com', name: 'You' },
      memberships: [{ deckId: 'deck-2', userId: 'you', role: 'owner', createdAt: '2026-05-09T10:00:00.000Z' }],
      decks: [
        {
          id: 'deck-1',
          name: 'Small deck',
          description: 'Quick deck',
          cardCount: 12,
          noteCount: 12,
          tagCount: 2,
          noteTypes: ['Basic'],
          pendingSuggestions: 0,
          lastSyncedAt: null,
          importedAt: '2026-05-09T10:00:00.000Z'
        },
        {
          id: 'deck-2',
          name: 'Neuro ICU',
          description: 'Large deck',
          cardCount: 4200,
          noteCount: 4200,
          tagCount: 120,
          noteTypes: ['Enhanced Cloze'],
          pendingSuggestions: 3,
          lastSyncedAt: '2026-05-09T11:00:00.000Z',
          importedAt: '2026-05-09T10:00:00.000Z'
        }
      ]
    }, 'deck-2');

    expect(state.activeDeckId).toBe('deck-2');
    expect(state.role).toBe('owner');
    expect(state.summaries).toHaveLength(2);
    expect(state.decks.find((deck) => deck.id === 'deck-2')?.cards).toEqual([]);
  });

  it('merges hydrated active deck details without dropping summary-only decks', () => {
    const shell = stateFromMeResponse({
      user: { id: 'you', email: 'you@example.com', name: 'You' },
      memberships: [
        { deckId: 'deck-1', userId: 'you', role: 'reviewer', createdAt: '2026-05-09T10:00:00.000Z' },
        { deckId: 'deck-2', userId: 'you', role: 'owner', createdAt: '2026-05-09T10:00:00.000Z' }
      ],
      decks: [
        {
          id: 'deck-1',
          name: 'Small deck',
          description: 'Quick deck',
          cardCount: 12,
          noteCount: 12,
          tagCount: 2,
          noteTypes: ['Basic'],
          pendingSuggestions: 0,
          lastSyncedAt: null,
          importedAt: '2026-05-09T10:00:00.000Z'
        },
        {
          id: 'deck-2',
          name: 'Neuro ICU',
          description: 'Large deck',
          cardCount: 4200,
          noteCount: 4200,
          tagCount: 120,
          noteTypes: ['Enhanced Cloze'],
          pendingSuggestions: 3,
          lastSyncedAt: '2026-05-09T11:00:00.000Z',
          importedAt: '2026-05-09T10:00:00.000Z'
        }
      ]
    }, 'deck-2');

    const hydrated = mergeHydratedDeckState(shell, {
      ...shell,
      activeDeckId: 'deck-2',
      decks: [{
        ...shell.decks[1],
        cards: [{
          id: 'card-1',
          ankiNoteId: 1,
          type: 'Enhanced Cloze',
          fields: { Text: 'Question' },
          tags: ['ncc'],
          due: null,
          state: 'Review',
          modifiedAt: '2026-05-09T11:00:00.000Z',
          modifiedBy: 'Anki',
          suspended: false
        }],
        media: {}
      }],
      summaries: [{
        ...shell.summaries[1],
        cardCount: 4201
      }],
      memberships: [shell.memberships![1]]
    });

    expect(hydrated.summaries.map((summary) => summary.id)).toEqual(['deck-1', 'deck-2']);
    expect(hydrated.decks.find((deck) => deck.id === 'deck-1')).toBeDefined();
    expect(hydrated.decks.find((deck) => deck.id === 'deck-2')?.cards).toHaveLength(1);
    expect(hydrated.summaries.find((summary) => summary.id === 'deck-2')?.cardCount).toBe(4201);
    expect(hydrated.role).toBe('owner');
  });
});

describe('deriveOwnerReviewQueue', () => {
  it('orders conflicts, pending suggestions, AI findings, and recent decisions by owner risk', () => {
    const queue = deriveOwnerReviewQueue({
      now: NOW,
      conflicts: [conflict()],
      pulse: pulse(),
      suggestions: [
        suggestion({ id: 'suggestion-1', cardId: 'card-1', createdAt: '2026-05-09T10:30:00.000Z' }),
        suggestion({
          id: 'suggestion-accepted',
          cardId: 'card-accepted',
          status: 'accepted',
          reviewedAt: '2026-05-09T08:30:00.000Z',
          createdAt: '2026-05-08T08:30:00.000Z',
          reason: 'Accepted source-backed edit'
        })
      ]
    });

    expect(queue.map((item) => item.id)).toEqual([
      'conflict:conflict-1',
      'suggestion:suggestion-1',
      'ai:artifact-quality',
      'recent:suggestion-accepted'
    ]);
    expect(queue.find((item) => item.id === 'recent:suggestion-accepted')).toMatchObject({
      kind: 'recent-change',
      status: 'accepted',
      affectsNextPull: true,
      actionLabel: 'Inspect'
    });
  });

  it('dedupes AI pulse items already represented by pending suggestions and excludes old accepted changes', () => {
    const queue = deriveOwnerReviewQueue({
      now: NOW,
      conflicts: [],
      pulse: pulse(),
      suggestions: [
        suggestion({ id: 'suggestion-1', cardId: 'card-1' }),
        suggestion({
          id: 'old-accepted',
          cardId: 'card-old',
          status: 'accepted',
          reviewedAt: '2026-04-01T08:30:00.000Z',
          createdAt: '2026-04-01T08:00:00.000Z'
        })
      ]
    });

    expect(queue.some((item) => item.id === 'ai:artifact-suggestion-1')).toBe(false);
    expect(queue.some((item) => item.id === 'recent:old-accepted')).toBe(false);
    expect(queue.map((item) => item.id)).toEqual(['suggestion:suggestion-1', 'ai:artifact-quality']);
  });
});
