import type { ApiError, AppState, Role, StorageAsset, User, DeckMember, DeckSummary } from './types';

function extractError(body: unknown, fallback: string) {
  const value = body as Partial<ApiError> & { error?: string | { message?: string }; legacyError?: string };
  if (typeof value?.error === 'string') return value.error;
  if (value?.error?.message) return value.error.message;
  if (value?.legacyError) return value.legacyError;
  return fallback;
}

async function jsonRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(extractError(body, `Request failed with ${response.status}`));
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => jsonRequest<{ ok: boolean; dataDir: string }>('/api/health'),
  me: () => jsonRequest<{ user: User; memberships: DeckMember[] }>('/api/me'),
  decks: () => jsonRequest<{ decks: DeckSummary[] }>('/api/decks'),
  deck: (deckId: string) => jsonRequest<AppState>(`/api/decks/${deckId}`),
  state: () => jsonRequest<AppState>('/api/state'),
  session: (payload: { role?: Role; activeDeckId?: string }) =>
    jsonRequest<AppState>('/api/session', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  uploadDeck: (file: File) => {
    const form = new FormData();
    form.append('deck', file);
    return jsonRequest<AppState>('/api/decks/upload', {
      method: 'POST',
      body: form
    });
  },
  createSuggestion: (payload: {
    deckId: string;
    cardId: string;
    authorId: string;
    reason: string;
    proposedFields: Record<string, string>;
    proposedTags: string[];
  }) =>
    jsonRequest<AppState>(`/api/decks/${payload.deckId}/suggestions`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  decideSuggestion: (id: string, decision: 'accepted' | 'rejected' | 'revision') =>
    jsonRequest<AppState>(`/api/suggestions/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision })
    }),
  ankiStatus: () => jsonRequest('/api/anki/status'),
  ankiPull: (deckId: string) =>
    jsonRequest<AppState>('/api/anki/pull', {
      method: 'POST',
      body: JSON.stringify({ deckId })
    }),
  ankiPush: (deckId: string) =>
    jsonRequest<{ state: AppState; result: { updatedNotes: number } }>('/api/anki/push', {
      method: 'POST',
      body: JSON.stringify({ deckId })
    }),
  recordSyncConflicts: (deckId: string, conflicts: AppState['sync']['conflicts']) =>
    jsonRequest<AppState>(`/api/decks/${deckId}/sync/conflicts`, {
      method: 'POST',
      body: JSON.stringify({ conflicts })
    }),
  exportDeck: async (deckId: string) => {
    const response = await fetch(`/api/decks/${deckId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(extractError(body, `Export failed with ${response.status}`));
    }
    const payload = await response.json() as { download: StorageAsset };
    const downloadResponse = await fetch(payload.download.url);
    if (!downloadResponse.ok) throw new Error(`Download failed with ${downloadResponse.status}`);
    const blob = await downloadResponse.blob();
    const filename = payload.download.filename || 'deck.apkg';
    return { blob, filename };
  }
};
