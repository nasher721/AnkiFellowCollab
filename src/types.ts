export type Role = 'owner' | 'collaborator';
export type MembershipRole = 'owner' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface DeckMember {
  deckId: string;
  userId: string;
  role: MembershipRole;
  createdAt: string;
}

export interface CardField {
  name: string;
  ordinal: number;
}

export interface DeckModel {
  id?: string;
  name: string;
  fields: CardField[];
}

export interface StorageAsset {
  filename: string;
  url: string;
  expiresAt: string | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface DeckCard {
  id: string;
  ankiNoteId: number | null;
  type: string;
  modelName?: string;
  fieldOrder?: string[];
  fields: Record<string, string>;
  tags: string[];
  due: number | null;
  state: string;
  modifiedAt: string;
  modifiedBy: string;
  suspended: boolean;
  mediaRefs?: string[];
  sourceDeckName?: string | null;
  sourceDeckPath?: string | null;
}

export interface Deck {
  id: string;
  name: string;
  description: string;
  owner: string;
  importedAt: string;
  lastSyncedAt: string | null;
  cards: DeckCard[];
  media: Record<string, unknown>;
  models?: DeckModel[];
  source: {
    filename: string;
    format: string;
    deckName?: string;
    deckPath?: string;
  };
}

export interface DeckSummary {
  id: string;
  name: string;
  description: string;
  cardCount: number;
  noteCount: number;
  tagCount: number;
  noteTypes: string[];
  pendingSuggestions: number;
  lastSyncedAt: string | null;
  importedAt: string;
}

export interface Collaborator {
  id: string;
  name: string;
  email: string;
  role: Role;
  accepted: number;
}

export interface Suggestion {
  id: string;
  deckId: string;
  cardId: string;
  authorId: string;
  authorName: string;
  status: 'pending' | 'accepted' | 'rejected' | 'revision';
  reason: string;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  proposedFields: Record<string, string>;
  proposedTags: string[];
}

export interface Activity {
  id: string;
  kind: string;
  text: string;
  at: string;
}

export interface SyncState {
  ankiConnectUrl: string;
  connected: boolean;
  lastCheckedAt: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError?: string | null;
  conflicts: Array<{
    id: string;
    deckId: string;
    cardId: string;
    source: string;
    detectedAt: string;
    incomingFields: Record<string, string>;
    localFields: Record<string, string>;
  }>;
}

export interface AppState {
  user?: User;
  memberships?: DeckMember[];
  decks: Deck[];
  summaries: DeckSummary[];
  activeDeckId: string | null;
  role: Role;
  collaborators: Collaborator[];
  suggestions: Suggestion[];
  activity: Activity[];
  sync: SyncState;
}
