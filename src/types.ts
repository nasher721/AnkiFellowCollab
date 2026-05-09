export type MembershipRole = 'owner' | 'editor' | 'reviewer' | 'contributor' | 'viewer';
export type DemoRole = MembershipRole;

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
    details?: Record<string, unknown>;
  };
  legacyError?: string;
}

export interface AiCapabilityStatus {
  state: 'disabled' | 'gateway-unreachable' | 'auth-required' | 'no-chat-model' | 'no-embedding-model' | 'ready';
  chatModel: string | null;
  embeddingModel: string | null;
  checkedAt: string | null;
  message: string;
}

export interface DeckAiSettings {
  reviewBriefs: boolean;
  embeddings: boolean;
  conflictSummaries: boolean;
  diagnostics: boolean;
  qualityPulse: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AiArtifact {
  id: string;
  deckId: string;
  subjectType: 'suggestion' | 'card' | 'conflict' | 'setup-error' | 'study-hint' | 'digest';
  subjectId: string;
  kind: 'review-brief' | 'duplicate-link' | 'conflict-summary' | 'quality-issue' | 'diagnostic' | 'hint' | 'digest';
  severity: 'info' | 'low' | 'medium' | 'high';
  status: 'active' | 'dismissed' | 'accepted' | 'rejected' | 'stale';
  confidence: number;
  model: string;
  promptVersion: string;
  inputHash: string;
  payload: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface AiQualityPulseItem {
  artifactId: string;
  subjectType: AiArtifact['subjectType'];
  subjectId: string;
  kind: AiArtifact['kind'];
  severity: AiArtifact['severity'];
  staleness: 'fresh' | 'aging' | 'old' | 'unknown';
  action: 'suggestion' | 'conflict' | 'setup' | 'card' | 'artifact';
  label: string;
  detail: string;
  createdAt: string;
}

export interface AiQualityPulse {
  enabled: boolean;
  status: 'disabled' | 'healthy' | 'attention';
  generatedAt: string;
  totalActive: number;
  summary: {
    bySeverity: Record<string, number>;
    bySubjectType: Record<string, number>;
    byStaleness: Record<string, number>;
  };
  groups: {
    severity: { key: string; count: number }[];
    subjectType: { key: string; count: number }[];
    staleness: { key: string; count: number }[];
  };
  items: AiQualityPulseItem[];
}

export interface AiSuggestionBriefPayload {
  category: 'grammar' | 'formatting' | 'factual-correction' | 'duplicate-risk' | 'style-cleanup' | 'quality-risk' | 'other';
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  recommendedAction: 'review' | 'accept-with-care' | 'request-revision' | 'compare-duplicate' | 'dismiss';
  rationale: string;
  evidence: string[];
  confidence: number;
}

export interface AiSuggestionBriefResult {
  status: 'created' | 'disabled' | 'unavailable' | 'invalid';
  code?: string;
  message?: string;
  artifact: AiArtifact | null;
}

export interface AiConflictSummaryPayload {
  summary: string;
  risk: 'low' | 'medium' | 'high';
  recommendation: 'keep-local' | 'use-incoming' | 'skip-for-now' | 'manual-review';
  rationale: string;
  evidence: string[];
  confidence: number;
}

export interface StructuredSetupError {
  code: string;
  path: string;
  message: string;
  status?: number | null;
  method?: string | null;
  source?: string;
  details?: Record<string, unknown>;
}

export interface AiSetupDiagnosticPayload {
  summary: string;
  risk: 'low' | 'medium' | 'high';
  recommendedAction: string;
  rationale: string;
  recoverySteps: string[];
  citedError: {
    code: string;
    path: string;
    message: string;
  };
  confidence: number;
}

export interface AiArtifactGenerationResult {
  status: 'created' | 'disabled' | 'unavailable' | 'invalid';
  code?: string;
  message?: string;
  artifact: AiArtifact | null;
}

export interface AiDuplicateLink {
  id: string;
  deckId: string;
  sourceCardId: string;
  targetCardId: string;
  artifactId: string | null;
  score: number;
  relationship: 'duplicate' | 'near-duplicate' | 'related';
  rationale: string;
  comparedFields: string[];
  status: 'active' | 'dismissed' | 'stale';
  createdAt: string;
  updatedAt: string;
}

export interface AiCardEmbedding {
  cardId: string;
  deckId: string;
  model: string;
  dimensions: number;
  inputHash: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  status: 'active' | 'stale';
  createdAt: string;
  updatedAt: string;
}

export interface AiCardEmbeddingResult {
  status: 'indexed' | 'disabled' | 'unavailable' | 'invalid';
  code?: string;
  message?: string;
  embedding: AiCardEmbedding | null;
  links: AiDuplicateLink[];
}

export interface AiRelatedCardsResult {
  status: 'ready' | 'disabled';
  code?: string;
  message?: string;
  links: AiDuplicateLink[];
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
  templateFront?: string;
  templateBack?: string;
  modelCss?: string;
  clozeOrd?: number;
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
  aiSettings?: DeckAiSettings;
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
  role: MembershipRole;
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

export type ActivityKind = 'import' | 'export' | 'sync' | 'suggestion' | 'accepted' | 'rejected' | 'revision' | 'study' | 'share' | 'template';

export interface Activity {
  id: string;
  kind: ActivityKind | string;
  text: string;
  at: string;
}

export interface StudySession {
  id: string;
  userId: string;
  deckId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  cardsStudied: number;
  cardsCorrect: number;
  newCards: number;
  reviewCards: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AddonSyncResult {
  syncedAt: string;
  source: string;
  client: {
    name: string;
    version: string;
    fingerprint?: string;
  } | null;
  stats: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    conflicts: number;
    dryRun: boolean;
  };
}

export interface SyncState {
  ankiConnectUrl: string;
  connected: boolean;
  lastCheckedAt: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastAddonSync: AddonSyncResult | null;
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
  role: DemoRole;
  collaborators: Collaborator[];
  suggestions: Suggestion[];
  activity: Activity[];
  sync: SyncState;
}
