import type { ApiError, AppState, Role, StorageAsset, User, DeckMember, DeckSummary } from './types';

let authToken: string | null = null;

export function setApiAuthToken(token: string | null) {
  authToken = token;
}

function extractError(body: unknown, fallback: string) {
  const value = body as Partial<ApiError> & { error?: string | { message?: string }; legacyError?: string };
  if (typeof value?.error === 'string') return value.error;
  if (value?.error?.message) return value.error.message;
  if (value?.legacyError) return value.legacyError;
  return fallback;
}

async function jsonRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(options.headers as Record<string, string> | undefined)
  };
  const response = await fetch(url, {
    ...options,
    headers
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(extractError(body, `Request failed with ${response.status}`));
  }
  return response.json() as Promise<T>;
}

export interface ApiToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedToken extends ApiToken {
  raw: string;
}

export interface Comment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface Notification {
  id: string;
  deckId: string | null;
  kind: string;
  body: string;
  refId: string | null;
  read: boolean;
  createdAt: string;
}

export const api = {
  health: () => jsonRequest<{ ok: boolean; dataDir: string }>('/api/health'),
  addonVersion: () => jsonRequest<{ version: string; minVersion: string }>('/api/addon/version'),
  tokens: {
    list: () => jsonRequest<{ tokens: ApiToken[] }>('/api/tokens'),
    create: (label?: string) =>
      jsonRequest<CreatedToken>('/api/tokens', {
        method: 'POST',
        body: JSON.stringify({ label: label || 'Anki Add-on' })
      }),
    revoke: (tokenId: string) =>
      fetch(`/api/tokens/${tokenId}`, {
        method: 'DELETE',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      }).then((r) => { if (!r.ok) throw new Error(`Revoke failed: ${r.status}`); })
  },
  comments: {
    list: (suggestionId: string) =>
      jsonRequest<{ comments: Comment[] }>(`/api/suggestions/${suggestionId}/comments`),
    create: (suggestionId: string, body: string, parentId?: string) =>
      jsonRequest<Comment>(`/api/suggestions/${suggestionId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body, parentId })
      })
  },
  reactions: {
    add: (suggestionId: string, emoji: string) =>
      jsonRequest<{ reactions: Record<string, number> }>(`/api/suggestions/${suggestionId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji })
      }),
    remove: (suggestionId: string, emoji: string) =>
      fetch(`/api/suggestions/${suggestionId}/reactions/${encodeURIComponent(emoji)}`, {
        method: 'DELETE',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      }).then((r) => { if (!r.ok && r.status !== 204) throw new Error('Remove reaction failed'); })
  },
  notifications: {
    list: () => jsonRequest<{ notifications: Notification[]; unread: number }>('/api/notifications'),
    readAll: () =>
      fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      }).then(() => undefined)
  },
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
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      },
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
