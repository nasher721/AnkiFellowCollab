import type { ApiError, AppState, DemoRole, StorageAsset, User, DeckMember, DeckSummary } from './types';

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
  token?: string;
}

export interface AddonVersion {
  version: string;
  minVersion: string;
  package?: string;
  name?: string;
  downloadUrl?: string;
}

export interface AddonDownloadAvailability {
  available: boolean;
  status: number | null;
  code?: 'addon_not_built' | 'download_unavailable' | 'network_error';
  message?: string;
}

export interface MeResponse {
  user: User;
  memberships: DeckMember[];
  decks?: DeckSummary[];
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

export interface NotificationPage {
  notifications: Notification[];
  unread: number;
  nextCursor: string | null;
}

export interface PublicDeck {
  id: string;
  name: string;
  description: string;
  ownerName: string;
  importedAt: string;
  downloadCount: number;
  starCount: number;
  forkedFrom: string | null;
  cardCount?: number;
  noteCount?: number;
  tagCount?: number;
  noteTypes?: string[];
  sampleCards?: Record<string, string>[];
}

export interface ShareLink {
  id: string;
  deckId: string;
  token: string;
  label: string;
  passwordProtected: boolean;
  expiresAt: string | null;
  disabledAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface DeckAnalytics {
  suggestions: {
    total: number;
    accepted: number;
    rejected: number;
    pending: number;
    acceptanceRate: number;
  };
  stars: number;
  leaderboard: { name: string; total: number; accepted: number }[];
  cards?: {
    total: number;
    byState: Record<string, number>;
  };
  study?: {
    sessions: {
      total: number;
      durationSeconds: number;
      cardsStudied: number;
      cardsCorrect: number;
      accuracyRate: number;
    };
    weeklyTrend: { date: string; count: number }[];
    strugglingCards: { cardId: string; easeFactor: number; repetitions: number; lastRating?: number; nextDue: string; front?: string; back?: string }[];
  };
}

export interface DeckInvite {
  id: string;
  deckId: string;
  email: string;
  role: 'viewer' | 'contributor' | 'reviewer' | 'editor';
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  expiresAt: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface InvitePreview {
  deckId: string;
  deckName: string | null;
  role: string;
  email: string;
  status: string;
  expiresAt: string | null;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  authorName: string;
  tags: string[];
  starCount: number;
  isFeatured: boolean;
  fields: { name: string; description: string }[];
  sampleCards: Record<string, string>[];
  createdAt: string;
}

export const api = {
  health: () => jsonRequest<{ ok: boolean; dataDir: string }>('/api/health'),
  addonVersion: () => jsonRequest<AddonVersion>('/api/addon/version'),
  addonDownloadAvailability: async (downloadUrl = '/api/addon/download'): Promise<AddonDownloadAvailability> => {
    try {
      const response = await fetch(downloadUrl, { method: 'HEAD' });
      if (response.ok) return { available: true, status: response.status };
      if (response.status === 404) {
        return {
          available: false,
          status: response.status,
          code: 'addon_not_built',
          message: 'Add-on package is not built yet. Run npm run package:anki-addon on the server, then retry the download.'
        };
      }
      return {
        available: false,
        status: response.status,
        code: 'download_unavailable',
        message: `Download endpoint returned ${response.status}.`
      };
    } catch (error) {
      return {
        available: false,
        status: null,
        code: 'network_error',
        message: error instanceof Error ? error.message : 'Unable to check add-on download availability.'
      };
    }
  },
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
    list: (params: { limit?: number; cursor?: string | null } = {}) => {
      const query = new URLSearchParams();
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.cursor) query.set('cursor', params.cursor);
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return jsonRequest<NotificationPage>(`/api/notifications${suffix}`);
    },
    readAll: () =>
      fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      }).then(() => undefined)
  },
  me: () => jsonRequest<MeResponse>('/api/me'),
  meWithToken: (token: string) =>
    jsonRequest<MeResponse>('/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    }),
  decks: () => jsonRequest<{ decks: DeckSummary[] }>('/api/decks'),
  deck: (deckId: string) => jsonRequest<AppState>(`/api/decks/${deckId}`),
  state: () => jsonRequest<AppState>('/api/state'),
  session: (payload: { role?: DemoRole; activeDeckId?: string }) =>
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
  },
  exportDeckCsv: async (deckId: string) => {
    const response = await fetch(`/api/decks/${deckId}/export/csv`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
    });
    if (!response.ok) throw new Error(`CSV export failed with ${response.status}`);
    const blob = await response.blob();
    const filename = response.headers.get('Content-Disposition')?.match(/filename="(.+?)"/)?.[1] || 'deck.csv';
    return { blob, filename };
  },
  exportActivityCsv: async (deckId: string) => {
    const response = await fetch(`/api/decks/${deckId}/export/activity`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
    });
    if (!response.ok) throw new Error(`Activity export failed with ${response.status}`);
    const blob = await response.blob();
    const filename = response.headers.get('Content-Disposition')?.match(/filename="(.+?)"/)?.[1] || 'activity.csv';
    return { blob, filename };
  },
  discover: (params?: { q?: string; sort?: string; page?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.page) qs.set('page', String(params.page));
    return jsonRequest<{ decks: PublicDeck[] }>(`/api/discover?${qs}`);
  },
  setVisibility: (deckId: string, visibility: 'public' | 'private' | 'unlisted') =>
    jsonRequest<{ visibility: string }>(`/api/decks/${deckId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility })
    }),
  shareLinks: {
    list: (deckId: string) =>
      jsonRequest<{ shareLinks: ShareLink[] }>(`/api/decks/${deckId}/share-links`),
    create: (deckId: string, payload?: { label?: string; password?: string; expiresAt?: string | null }) =>
      jsonRequest<{ shareLink: ShareLink }>(`/api/decks/${deckId}/share-links`, {
        method: 'POST',
        body: JSON.stringify(payload || {})
      })
  },
  forkDeck: (deckId: string) =>
    jsonRequest<{ deckId: string; name: string }>(`/api/decks/${deckId}/fork`, { method: 'POST' }),
  starDeck: (deckId: string) =>
    jsonRequest<{ starred: boolean; count: number }>(`/api/decks/${deckId}/star`, { method: 'POST' }),
  unstarDeck: (deckId: string) =>
    jsonRequest<{ starred: boolean; count: number }>(`/api/decks/${deckId}/star`, { method: 'DELETE' }),
  analytics: (deckId: string) =>
    jsonRequest<{ analytics: DeckAnalytics }>(`/api/decks/${deckId}/analytics`),
  templates: (category?: string) => {
    const qs = category && category !== 'all' ? `?category=${encodeURIComponent(category)}` : '';
    return jsonRequest<{ templates: Template[] }>(`/api/templates${qs}`);
  },
  useTemplate: (templateId: string, name?: string) =>
    jsonRequest<{ deckId: string; name: string }>(`/api/templates/${templateId}/use`, {
      method: 'POST',
      body: JSON.stringify({ name })
    }),
  bulkDeleteCards: (deckId: string, cardIds: string[]) =>
    jsonRequest<{ deleted: number }>(`/api/decks/${deckId}/cards`, {
      method: 'DELETE',
      body: JSON.stringify({ cardIds })
    }),
  syncStudyProgress: (updates: Array<{ deckId: string; cardId: string; intervalDays: number; easeFactor: number; repetitions: number; nextDue: string; lastRating: number | null }>) =>
    jsonRequest<{ ok: boolean; synced: number }>('/api/study/progress', {
      method: 'POST',
      body: JSON.stringify({ updates })
    }),
  fetchStudyProgress: (deckId: string) =>
    jsonRequest<{ progress: Array<{ cardId: string; intervalDays: number; easeFactor: number; repetitions: number; nextDue: string; lastRating: number | null; updatedAt: string }> }>(`/api/study/progress/${deckId}`),
  invites: {
    list: (deckId: string) =>
      jsonRequest<{ invites: DeckInvite[] }>(`/api/decks/${deckId}/invites`),
    create: (deckId: string, email: string, role: DeckInvite['role']) =>
      jsonRequest<{ invite: DeckInvite }>(`/api/decks/${deckId}/invites`, {
        method: 'POST',
        body: JSON.stringify({ email, role })
      }),
    revoke: (deckId: string, inviteId: string) =>
      fetch(`/api/decks/${deckId}/invites/${inviteId}`, {
        method: 'DELETE',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      }).then((r) => { if (!r.ok && r.status !== 204) throw new Error('Revoke failed'); }),
    accept: (token: string) =>
      jsonRequest<{ deckId: string; role: string }>(`/api/invites/${token}/accept`, { method: 'POST' }),
    preview: (token: string) =>
      jsonRequest<{ invite: InvitePreview }>(`/api/invites/${token}`)
  }
};
