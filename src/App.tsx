import { ChangeEvent, FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { api, setApiAuthToken, type AddonDownloadAvailability, type AddonVersion, type MeResponse } from './api';
import type { AddonSyncResult, AiArtifact, AiDuplicateLink, AiQualityPulse, AppState, Deck, DeckCard, DeckMember, DeckSummary, Suggestion } from './types';
import { useRealtime } from './useRealtime';
import { ConnectAnkiWizard } from './ConnectAnkiWizard';
import { CardEditor } from './CardEditor';
import { StudyView } from './StudyView';
import { SuggestionDiscussion } from './SuggestionDiscussion';
import { NotificationsBell } from './NotificationsBell';
import { DiscoverView } from './DiscoverView';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import { ActivityTimeline } from './ActivityTimeline';
import { TemplateGallery } from './TemplateGallery';
import { ConflictResolution, readSavedConflictDecisions, saveConflictDecision, type Conflict } from './ConflictResolution';
import { DeckSettingsView } from './views/DeckSettingsView';
import { DeckStatsView } from './views/DeckStatsView';
import { StudyPrepView } from './views/StudyPrepView';
import { AnkiCardRenderer, renderCardHtml } from './AnkiCardRenderer';
import {
  deriveOwnerReviewQueue,
  deriveReviewBucketCounts,
  reviewItemMatchesBucket,
  selectCardForReview,
  selectSuggestionForReview,
  type QualityReviewItem,
  type ReviewBucket,
  type ReviewRiskLabel
} from './reviewModel';
export { deriveOwnerReviewQueue, deriveReviewBucketCounts, reviewItemMatchesBucket, selectCardForReview, selectSuggestionForReview } from './reviewModel';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface AddonPackageState {
  loading: boolean;
  version: AddonVersion | null;
  availability: AddonDownloadAvailability | null;
  error: string;
}

export interface SyncHealth {
  state: 'not-connected' | 'ready-to-test' | 'dry-run-passed' | 'sync-healthy' | 'conflicts' | 'package-missing' | 'api-unavailable' | 'token-failed';
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  title: string;
  badge: string;
  detail: string;
  packageLabel: string;
  deckLabel: string;
  localDeckLabel: string;
  lastCheckedLabel: string;
  lastSyncedLabel: string;
  conflictLabel: string;
  primaryAction: 'setup' | 'check' | 'conflicts';
  primaryLabel: string;
}

export interface OwnerAttentionItem {
  id: string;
  label: string;
  detail: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  action: 'setup' | 'suggestions' | 'conflicts' | 'cards' | 'settings' | 'study';
  actionLabel: string;
  artifactId?: string;
  subjectId?: string;
}

export type OwnerReviewQueueItem = QualityReviewItem;
export type WorkbenchTab = 'overview' | 'review' | 'study' | 'cards' | 'models' | 'stats' | 'analytics' | 'activity' | 'settings';
export type WorkbenchRailKind = 'overview' | 'card' | 'none';

const TOAST_ICONS: Record<Toast['type'], string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
};

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

function supabaseAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (supabaseUrl && urlStr.startsWith(supabaseUrl + '/auth/v1/')) {
    const suffix = urlStr.slice(supabaseUrl.length + '/auth/v1'.length);
    return fetch('/api/auth/proxy' + suffix, init);
  }
  return fetch(input, init);
}

const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
      global: { fetch: supabaseAuthFetch }
    })
  : null;
export const AUTH_REQUEST_TIMEOUT_MS = 20000;

const DEFAULT_AI_SETTINGS = Object.freeze({
  reviewBriefs: false,
  embeddings: false,
  conflictSummaries: false,
  diagnostics: false,
  qualityPulse: false,
  updatedAt: null,
  updatedBy: null
});

const statusColors: Record<string, string> = {
  New: 'blue',
  Learning: 'amber',
  Review: 'green',
  Suspended: 'red',
  Anki: 'neutral'
};

export function deriveWorkbenchRail({
  activeTab,
  hasDeck
}: {
  activeTab: WorkbenchTab;
  hasDeck: boolean;
}): WorkbenchRailKind {
  if (!hasDeck) return 'none';
  if (activeTab === 'overview') return 'overview';
  if (activeTab === 'cards') return 'card';
  return 'none';
}

function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}

function relativeTime(value?: string | null) {
  if (!value) return 'Not yet';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function fieldValue(card: DeckCard | undefined, key: string) {
  if (!card) return '';
  return card.fields[key] || card.fields[key.toLowerCase()] || '';
}

function stripHtml(value: string) {
  if (typeof document !== 'undefined') {
    const element = document.createElement('div');
    element.innerHTML = value;
    return element.textContent || element.innerText || '';
  }
  return value.replace(/<[^>]*>/g, ' ');
}

function searchableCardText(card: DeckCard, deckId: string) {
  const frontHtml = renderCardHtml(card, deckId, 'front', undefined, card.clozeOrd);
  const backHtml = renderCardHtml(card, deckId, 'back', frontHtml, card.clozeOrd);
  return [
    card.id,
    card.ankiNoteId,
    card.type,
    card.modelName,
    card.state,
    card.tags.join(' '),
    ...Object.values(card.fields),
    stripHtml(frontHtml),
    stripHtml(backHtml)
  ].join(' ').toLowerCase();
}

function packageLabel(addonPackage: AddonPackageState) {
  if (addonPackage.loading) return 'Checking package';
  if (addonPackage.error) return 'Package check failed';
  if (!addonPackage.availability?.available) return 'Package missing';
  return addonPackage.version?.version ? `Add-on v${addonPackage.version.version}` : 'Add-on ready';
}

function localDeckLabel(deck: Deck | undefined) {
  const sourceDeck = deck?.source?.deckPath || deck?.source?.deckName;
  if (sourceDeck) return sourceDeck;
  return deck?.cards.find((card) => card.sourceDeckName)?.sourceDeckName || 'Local deck not mapped';
}

function changedInLastSync(deck: Deck | undefined, result: AddonSyncResult | null | undefined) {
  if (!deck) return 0;
  if (result) return result.stats.dryRun ? 0 : result.stats.created + result.stats.updated;
  if (!deck.lastSyncedAt) return 0;
  const syncedAt = new Date(deck.lastSyncedAt).getTime();
  return deck.cards.filter((card) => {
    const modifiedAt = new Date(card.modifiedAt).getTime();
    return Number.isFinite(modifiedAt) && modifiedAt >= syncedAt && ['Anki', 'Import'].includes(card.modifiedBy);
  }).length;
}

export function deriveSyncHealth({
  activeDeck,
  addonPackage,
  apiHealth,
  sync
}: {
  activeDeck: Deck | undefined;
  addonPackage: AddonPackageState;
  apiHealth: 'checking' | 'ok' | 'down';
  sync: AppState['sync'];
}): SyncHealth {
  const lastAddonSync = sync.lastAddonSync;
  const conflictCount = sync.conflicts.length;
  const lastChecked = sync.lastCheckedAt || lastAddonSync?.syncedAt || null;
  const lastSynced = activeDeck?.lastSyncedAt || (!lastAddonSync?.stats.dryRun ? lastAddonSync?.syncedAt : null) || sync.lastPushAt || sync.lastPullAt || null;
  const deckLabel = activeDeck?.name || 'No DeckBridge deck';
  const labels = {
    packageLabel: packageLabel(addonPackage),
    deckLabel,
    localDeckLabel: localDeckLabel(activeDeck),
    lastCheckedLabel: relativeTime(lastChecked),
    lastSyncedLabel: relativeTime(lastSynced),
    conflictLabel: `${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`
  };

  if (apiHealth === 'down') {
    return {
      ...labels,
      state: 'api-unavailable',
      tone: 'danger',
      title: 'API unavailable',
      badge: 'Offline',
      detail: 'DeckBridge cannot verify sync state yet.',
      primaryAction: 'check',
      primaryLabel: 'Retry'
    };
  }
  if (!addonPackage.loading && addonPackage.availability && !addonPackage.availability.available) {
    return {
      ...labels,
      state: 'package-missing',
      tone: 'warning',
      title: 'Add-on package missing',
      badge: 'Build needed',
      detail: addonPackage.availability.message || 'The add-on download is not available.',
      primaryAction: 'setup',
      primaryLabel: 'Open setup'
    };
  }
  if (sync.lastError) {
    return {
      ...labels,
      state: 'token-failed',
      tone: 'danger',
      title: 'Connection needs attention',
      badge: 'Token failed',
      detail: sync.lastError,
      primaryAction: 'setup',
      primaryLabel: 'Repair setup'
    };
  }
  if (conflictCount > 0) {
    return {
      ...labels,
      state: 'conflicts',
      tone: 'warning',
      title: 'Conflicts need review',
      badge: labels.conflictLabel,
      detail: 'Review differences before pushing more changes.',
      primaryAction: 'conflicts',
      primaryLabel: 'Review'
    };
  }
  if (lastAddonSync?.stats.dryRun) {
    return {
      ...labels,
      state: 'dry-run-passed',
      tone: 'success',
      title: 'Dry-run passed',
      badge: `${lastAddonSync.stats.total} scanned`,
      detail: `${lastAddonSync.stats.created} new, ${lastAddonSync.stats.updated} updated, ${lastAddonSync.stats.skipped} unchanged.`,
      primaryAction: 'setup',
      primaryLabel: 'Finish setup'
    };
  }
  if (lastSynced) {
    return {
      ...labels,
      state: 'sync-healthy',
      tone: 'success',
      title: 'Sync healthy',
      badge: labels.lastSyncedLabel,
      detail: lastAddonSync ? `${lastAddonSync.stats.total} cards scanned by ${lastAddonSync.client?.name || lastAddonSync.source}.` : 'Deck has a verified sync timestamp.',
      primaryAction: 'check',
      primaryLabel: 'Check'
    };
  }
  if (activeDeck) {
    return {
      ...labels,
      state: 'ready-to-test',
      tone: 'info',
      title: 'Ready to test',
      badge: 'No proof yet',
      detail: 'Create a connection link, run a dry-run in Anki, then verify here.',
      primaryAction: 'setup',
      primaryLabel: 'Open setup'
    };
  }
  return {
    ...labels,
    state: 'not-connected',
    tone: 'neutral',
    title: 'Not connected',
    badge: 'Setup needed',
    detail: 'Import or sync an Anki deck to start the owner workflow.',
    primaryAction: 'setup',
    primaryLabel: 'Start setup'
  };
}

function deriveOwnerAttentionItems({
  canReview,
  changedCards,
  deckVisibility,
  pendingSuggestions,
  pulse,
  studyCards,
  syncHealth
}: {
  canReview: boolean;
  changedCards: number;
  deckVisibility: string;
  pendingSuggestions: number;
  pulse: AiQualityPulse | null;
  studyCards: number;
  syncHealth: SyncHealth;
}): OwnerAttentionItem[] {
  const items: OwnerAttentionItem[] = [];
  const pulseItems: OwnerAttentionItem[] = [];
  if (syncHealth.state !== 'sync-healthy' && syncHealth.state !== 'conflicts') {
    items.push({
      id: 'sync',
      label: syncHealth.title,
      detail: syncHealth.detail,
      tone: syncHealth.tone,
      action: syncHealth.primaryAction === 'conflicts' ? 'conflicts' : 'setup',
      actionLabel: syncHealth.primaryLabel
    });
  }
  if (pendingSuggestions > 0) {
    items.push({
      id: 'suggestions',
      label: `${pendingSuggestions} suggestion${pendingSuggestions === 1 ? '' : 's'} pending`,
      detail: canReview ? 'Review decisions are waiting.' : 'Reviewer access is needed.',
      tone: 'warning',
      action: 'suggestions',
      actionLabel: 'Review'
    });
  }
  if (pulse?.enabled && pulse.status === 'attention' && pulse.totalActive > 0) {
    for (const pulseItem of pulse.items.slice(0, 2)) {
      const action: OwnerAttentionItem['action'] = pulseItem.action === 'suggestion'
        ? 'suggestions'
        : pulseItem.action === 'conflict'
          ? 'conflicts'
          : pulseItem.action === 'setup'
            ? 'setup'
            : 'cards';
      pulseItems.push({
        id: `pulse-${pulseItem.artifactId}`,
        label: pulseItem.label,
        detail: `${pulseItem.severity} · ${pulseItem.staleness} · ${pulseItem.detail}`,
        tone: pulseItem.severity === 'high' ? 'danger' : pulseItem.severity === 'medium' ? 'warning' : 'info',
        action,
        actionLabel: action === 'setup' ? 'Setup' : action === 'conflicts' ? 'Open' : action === 'cards' ? 'Find' : 'Review',
        artifactId: pulseItem.artifactId,
        subjectId: pulseItem.subjectId
      });
    }
  }
  if (syncHealth.state === 'conflicts') {
    items.push({
      id: 'conflicts',
      label: syncHealth.conflictLabel,
      detail: 'Resolve sync conflicts before pushing accepted changes.',
      tone: 'danger',
      action: 'conflicts',
      actionLabel: 'Resolve'
    });
  }
  if (changedCards > 0) {
    items.push({
      id: 'changed-cards',
      label: `${changedCards} card${changedCards === 1 ? '' : 's'} changed in last sync`,
      detail: 'Spot-check recently synced content in the card browser.',
      tone: 'info',
      action: 'cards',
      actionLabel: 'Browse'
    });
  }
  if (deckVisibility === 'private') {
    items.push({
      id: 'visibility',
      label: 'Deck is private',
      detail: 'Owner access controls sharing.',
      tone: 'neutral',
      action: 'settings',
      actionLabel: 'Settings'
    });
  }
  if (studyCards === 0) {
    items.push({
      id: 'study',
      label: 'No studyable cards',
      detail: 'Approved, unsuspended cards are required for study mode.',
      tone: 'warning',
      action: 'study',
      actionLabel: 'Study'
    });
  }
  return [...items, ...pulseItems].slice(0, 5);
}

export async function withAuthTimeout<T>(request: Promise<T>, timeoutMs = AUTH_REQUEST_TIMEOUT_MS): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('DeckBridge auth request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function cleanAuthText(value: unknown) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '{}' || trimmed === '[object Object]' || trimmed === 'Error') return '';
  return trimmed;
}

function authErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const status = (error as Record<string, unknown>).status;
  if (typeof status === 'number') return status;
  if (typeof status === 'string') {
    const parsed = Number(status);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function authErrorText(error: unknown): string {
  const direct = cleanAuthText(error);
  if (direct) return direct;
  if (error instanceof Error) {
    return cleanAuthText(error.message) || cleanAuthText(error.name);
  }
  if (!error || typeof error !== 'object') return '';

  const value = error as Record<string, unknown>;
  for (const key of ['message', 'error_description', 'msg', 'detail', 'statusText', 'code', 'name']) {
    const text = cleanAuthText(value[key]);
    if (text) return text;
  }

  if (value.error && value.error !== error) {
    const nested = authErrorText(value.error);
    if (nested) return nested;
  }

  try {
    return cleanAuthText(JSON.stringify(value));
  } catch (_error) {
    return '';
  }
}

export function authMessage(error: unknown, mode: 'sign-in' | 'sign-up') {
  const message = authErrorText(error);
  const status = authErrorStatus(error);
  const lower = message.toLowerCase();
  const fingerprint = `${lower} ${status ?? ''}`.trim();
  if (
    fingerprint.includes('timed out') ||
    fingerprint.includes('failed to fetch') ||
    fingerprint.includes('networkerror') ||
    fingerprint.includes('authretryablefetcherror') ||
    status === 0 ||
    (status !== null && status >= 500)
  ) {
    return 'DeckBridge could not reach the auth provider. The Supabase project may be paused or temporarily unavailable; try again in a moment.';
  }
  if (!message) {
    return 'DeckBridge could not complete authentication because the auth provider returned an empty error. Try again in a moment.';
  }
  if (lower.includes('invalid login credentials')) {
    return 'That email and password did not match a DeckBridge account. Create an account here, or check the password and try again.';
  }
  if (lower.includes('email not confirmed') || lower.includes('confirm')) {
    return 'This account is waiting for email confirmation. If you just created it, try signing in again; hosted DeckBridge is configured for immediate access.';
  }
  if (lower.includes('rate limit')) {
    return 'The auth provider is rate limiting email messages. Try signing in with an existing account, or wait a few minutes before creating another account.';
  }
  if (lower.includes('already registered') || lower.includes('user already registered')) {
    return 'That email already has an account. Switch to sign in and use the same password.';
  }
  if (lower.includes('password')) {
    return mode === 'sign-up'
      ? 'Use a password with at least 6 characters.'
      : 'Check the password and try again.';
  }
  return message;
}

function emptySyncState(): AppState['sync'] {
  return {
    ankiConnectUrl: '',
    connected: false,
    lastCheckedAt: null,
    lastPullAt: null,
    lastPushAt: null,
    lastAddonSync: null,
    conflicts: []
  };
}

function deckShellFromSummary(summary: DeckSummary): Deck {
  return {
    id: summary.id,
    name: summary.name,
    description: summary.description,
    owner: 'Owner',
    importedAt: summary.importedAt,
    lastSyncedAt: summary.lastSyncedAt,
    cards: [],
    media: {},
    models: [],
    aiSettings: { ...DEFAULT_AI_SETTINGS },
    source: {
      filename: 'deckbridge.apkg',
      format: 'summary'
    }
  };
}

function roleForDeck(memberships: DeckMember[] = [], deckId: string | null): AppState['role'] {
  const role = memberships.find((membership) => membership.deckId === deckId)?.role || memberships[0]?.role;
  return role || 'contributor';
}

export function stateFromMeResponse(me: MeResponse, preferredDeckId?: string | null): AppState {
  const decks = (me.decks || []).map(deckShellFromSummary);
  const activeDeckId = decks.some((deck) => deck.id === preferredDeckId)
    ? preferredDeckId || null
    : decks[0]?.id || null;
  return {
    user: me.user,
    memberships: me.memberships,
    decks,
    summaries: me.decks || [],
    activeDeckId,
    role: roleForDeck(me.memberships, activeDeckId),
    collaborators: [],
    suggestions: [],
    activity: [],
    sync: emptySyncState()
  };
}

export function mergeHydratedDeckState(previous: AppState | null, next: AppState): AppState {
  if (!previous) return next;

  const decksById = new Map(previous.decks.map((deck) => [deck.id, deck]));
  for (const deck of next.decks) decksById.set(deck.id, deck);

  const summariesById = new Map(previous.summaries.map((summary) => [summary.id, summary]));
  for (const summary of next.summaries) summariesById.set(summary.id, summary);

  const membershipsByDeck = new Map((previous.memberships || []).map((membership) => [membership.deckId, membership]));
  for (const membership of next.memberships || []) membershipsByDeck.set(membership.deckId, membership);

  return {
    ...next,
    decks: Array.from(decksById.values()),
    summaries: Array.from(summariesById.values()),
    memberships: Array.from(membershipsByDeck.values()),
    role: roleForDeck(Array.from(membershipsByDeck.values()), next.activeDeckId)
  };
}

function Icon({ name }: { name: 'upload' | 'download' | 'sync' | 'search' | 'filter' | 'cards' | 'users' | 'check' | 'x' | 'spark' | 'moon' | 'sun' }) {
  const paths = {
    upload: 'M12 3v12m0-12 4 4m-4-4-4 4M4 17v3h16v-3',
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3',
    sync: 'M20 7h-5a5 5 0 0 0-8-2M4 17h5a5 5 0 0 0 8 2M20 7V3m0 4h-4M4 17v4m0-4h4',
    search: 'M10.5 18a7.5 7.5 0 1 1 5.3-12.8 7.5 7.5 0 0 1-5.3 12.8Zm5.5-2 4 4',
    filter: 'M4 6h16M7 12h10M10 18h4',
    cards: 'M4 7h16v12H4zM7 4h10',
    users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20a6 6 0 0 1 12 0M14 20a5 5 0 0 1 7-4.5',
    check: 'm5 13 4 4L19 7',
    x: 'M6 6l12 12M18 6 6 18',
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
    moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    sun: 'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z'
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="icon">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function AuthScreen({
  authMode,
  authEmail,
  authPassword,
  authBusy,
  authNotice,
  onSubmit,
  onEmailChange,
  onPasswordChange,
  onToggleMode
}: {
  authMode: 'sign-in' | 'sign-up';
  authEmail: string;
  authPassword: string;
  authBusy: boolean;
  authNotice: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onToggleMode: () => void;
}) {
  const isSignIn = authMode === 'sign-in';
  return (
    <div className="auth-screen">
      <section className="auth-hero" aria-label="DeckBridge sign in">
        <div className="auth-visual" aria-hidden="true">
          <div className="auth-visual-ribbon ribbon-a" />
          <div className="auth-visual-ribbon ribbon-b" />
          <div className="auth-visual-ribbon ribbon-c" />
          <div className="auth-preview-card preview-owner">
            <span>Owner review</span>
            <strong>12 changes ready</strong>
            <em>ABPN NCC deck</em>
          </div>
          <div className="auth-preview-card preview-sync">
            <span>Anki bridge</span>
            <strong>Dry-run passed</strong>
            <em>285 notes scanned</em>
          </div>
          <div className="auth-preview-card preview-source">
            <span>Source-backed edits</span>
            <strong>3 conflicts held</strong>
            <em>No silent overwrites</em>
          </div>
          <div className="auth-lattice">
            {Array.from({ length: 28 }, (_, index) => <i key={`lattice-${index}`} />)}
          </div>
        </div>
        <div className="auth-copy">
          <div className="auth-brandline">
            <span className="brand-mark"><Icon name="cards" /></span>
            <span>DeckBridge</span>
          </div>
          <h1>Bring every Anki deck review into one calm command center.</h1>
          <p>
            Sync from Anki, review collaborator edits, protect source-backed cards, and keep the owner in control before changes land.
          </p>
          <div className="auth-proof-strip" aria-label="DeckBridge highlights">
            <span><Icon name="sync" /> Local add-on sync</span>
            <span><Icon name="users" /> Study group review</span>
            <span><Icon name="check" /> Owner approval</span>
          </div>
        </div>
      </section>

      <section className="auth-panel" aria-label={isSignIn ? 'Sign in to DeckBridge' : 'Create a DeckBridge account'}>
        <div className="auth-panel-heading">
          <span className="auth-kicker">{isSignIn ? 'Welcome back' : 'Start your workspace'}</span>
          <h2>{isSignIn ? 'Sign in to DeckBridge' : 'Create your DeckBridge account'}</h2>
          <p className="auth-subtitle">
            {isSignIn
              ? 'One account unlocks the web workspace and the Anki add-on token flow.'
              : 'Create an account, then let DeckBridge issue the add-on credential for Anki.'}
          </p>
        </div>
        <form className="auth-form" onSubmit={onSubmit}>
          <label>
            <span>Email</span>
            <input
              aria-label="Email"
              autoComplete="email"
              placeholder="you@example.com"
              type="email"
              value={authEmail}
              onChange={(event) => onEmailChange(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              aria-label="Password"
              autoComplete={isSignIn ? 'current-password' : 'new-password'}
              placeholder="Enter your password"
              type="password"
              minLength={6}
              value={authPassword}
              onChange={(event) => onPasswordChange(event.target.value)}
              required
            />
          </label>
          <button className="button primary auth-submit" type="submit" disabled={authBusy}>
            {authBusy ? 'Working...' : isSignIn ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button className="auth-switch" type="button" onClick={onToggleMode}>
          {isSignIn ? 'Create a new DeckBridge account' : 'Use an existing DeckBridge account'}
        </button>
        {authNotice ? <p className="auth-notice" role="alert">{authNotice}</p> : null}
      </section>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
}

function SyncHealthStrip({ health, onAction }: { health: SyncHealth; onAction: (action: SyncHealth['primaryAction']) => void }) {
  return (
    <div className={`sync-strip sync-strip--${health.tone}`} aria-label="Sync health">
      <span className={`sync-light ${health.tone === 'success' ? 'on' : ''}`} />
      <div className="sync-strip-main">
        <strong>{health.title}</strong>
        <small>{health.packageLabel} · {health.deckLabel} · {health.localDeckLabel}</small>
      </div>
      <span className={`sync-badge sync-badge--${health.tone}`}>{health.badge}</span>
      <small className="sync-strip-detail">
        {health.state === 'dry-run-passed'
          ? health.detail
          : `Checked ${health.lastCheckedLabel} · Last success ${health.lastSyncedLabel} · ${health.conflictLabel}`}
      </small>
      <button className="icon-button" title={health.primaryLabel} onClick={() => onAction(health.primaryAction)}>
        <Icon name={health.primaryAction === 'conflicts' ? 'x' : 'sync'} />
      </button>
    </div>
  );
}

function OwnerAttentionPanel({
  items,
  onDismissArtifact,
  onAction,
  syncHealth
}: {
  items: OwnerAttentionItem[];
  onDismissArtifact?: (artifactId: string) => void;
  onAction: (item: OwnerAttentionItem) => void;
  syncHealth: SyncHealth;
}) {
  return (
    <section className="owner-attention" aria-label="Owner attention">
      <div className="owner-attention-heading">
        <strong>Owner Attention</strong>
        <span className={`sync-badge sync-badge--${syncHealth.tone}`}>{syncHealth.badge}</span>
      </div>
      <div className="owner-sync-proof">
        <span>{syncHealth.packageLabel}</span>
        <span>{syncHealth.lastCheckedLabel === 'Not yet' ? 'No bridge check yet' : `Checked ${syncHealth.lastCheckedLabel}`}</span>
      </div>
      {items.length ? (
        <div className="attention-list">
          {items.map((item) => (
            <div
              key={item.id}
              style={{ display: 'grid', gridTemplateColumns: item.artifactId ? '1fr 34px' : '1fr', gap: 6, alignItems: 'stretch' }}
              role="group"
              aria-label={`Attention item: ${item.label}`}
            >
              <button
                type="button"
                className={`attention-item attention-item--${item.tone}`}
                aria-label={`Open attention item: ${item.label}`}
                onClick={() => onAction(item)}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <b>{item.actionLabel}</b>
              </button>
              {item.artifactId ? (
                <button
                  type="button"
                  className="icon-button"
                  title="Dismiss AI artifact"
                  aria-label={`Dismiss AI artifact: ${item.label}`}
                  onClick={() => onDismissArtifact?.(item.artifactId!)}
                >
                  <Icon name="x" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="attention-clear">
          <Icon name="check" />
          <span>
            <strong>Owner queue clear</strong>
            <small>Sync, review, and study readiness have no urgent blockers.</small>
          </span>
        </div>
      )}
    </section>
  );
}

function WorkbenchLayout({
  railKind,
  rail,
  children
}: {
  railKind: WorkbenchRailKind;
  rail?: ReactNode;
  children: ReactNode;
}) {
  const hasRail = railKind !== 'none' && Boolean(rail);
  return (
    <div className={`content-grid content-grid--${hasRail ? 'with-rail' : 'full'} content-grid--rail-${railKind}`}>
      <section className="deck-panel">
        {children}
      </section>
      {hasRail ? (
        <aside className={`review-panel context-rail context-rail--${railKind}`} aria-label="Workbench context">
          {rail}
        </aside>
      ) : null}
    </div>
  );
}

function OverviewRail({
  ownerAttentionItems,
  syncHealth,
  reviewCount,
  reviewBucketCounts,
  conflictCount,
  onDismissArtifact,
  onOwnerAction,
  onOpenReviewBucket,
  onOpenReview
}: {
  ownerAttentionItems: OwnerAttentionItem[];
  syncHealth: SyncHealth;
  reviewCount: number;
  reviewBucketCounts: ReturnType<typeof deriveReviewBucketCounts>;
  conflictCount: number;
  onDismissArtifact: (artifactId: string) => void;
  onOwnerAction: (item: OwnerAttentionItem) => void;
  onOpenReviewBucket: (bucket: ReviewBucket) => void;
  onOpenReview: () => void;
}) {
  return (
    <>
      <OwnerAttentionPanel
        items={ownerAttentionItems}
        onDismissArtifact={onDismissArtifact}
        syncHealth={syncHealth}
        onAction={onOwnerAction}
      />
      <section className="review-entry-card">
        <div className="review-heading">
          <strong>Quality Review <span>{reviewCount}</span></strong>
        </div>
        <div className="review-entry-grid">
          <button type="button" onClick={() => onOpenReviewBucket('answer')}>
            <small>Answer changed</small>
            <strong>{reviewBucketCounts.answer}</strong>
          </button>
          <button type="button" onClick={() => onOpenReviewBucket('source')}>
            <small>Source check</small>
            <strong>{reviewBucketCounts.source}</strong>
          </button>
          <button type="button" onClick={() => onOpenReviewBucket('conflict')}>
            <small>Sync conflict</small>
            <strong>{reviewBucketCounts.conflict}</strong>
          </button>
        </div>
        <button className="button primary review-open-button" type="button" onClick={onOpenReview}>
          Open review workspace
        </button>
        {conflictCount > 0 ? (
          <small className="conflict-block-rationale">
            Push blocked because unresolved sync conflicts could overwrite local Anki or DeckBridge edits.
          </small>
        ) : <small className="review-entry-clear">No sync conflicts are blocking push-back.</small>}
      </section>
    </>
  );
}

function CardRail({
  deckId,
  card,
  pendingSuggestion,
  duplicateCount,
  canSuggest,
  onEditCard,
  onOpenSuggestion
}: {
  deckId: string;
  card?: DeckCard;
  pendingSuggestion?: Suggestion;
  duplicateCount: number;
  canSuggest: boolean;
  onEditCard: (cardId: string) => void;
  onOpenSuggestion: (suggestion: Suggestion) => void;
}) {
  if (!card) {
    return (
      <section className="card-context-card" aria-label="Selected card context">
        <div className="card-context-heading">
          <span>Card Context</span>
          <strong>Select a card</strong>
        </div>
        <p className="card-context-empty">Choose a row in Cards to inspect rendered preview, note metadata, and linked review work.</p>
      </section>
    );
  }

  const frontHtml = renderCardHtml(card, deckId, 'front', undefined, card.clozeOrd);
  const visibleTags = card.tags.slice(0, 5);

  return (
    <section className="card-context-card" aria-label="Selected card context">
      <div className="card-context-heading">
        <span>Card Context</span>
        <strong>{fieldValue(card, 'Front') || Object.values(card.fields)[0] || card.id}</strong>
      </div>

      <div className="card-context-preview" aria-label="Selected card preview">
        <small>Rendered preview</small>
        <span className="card-preview-side-label">Front</span>
        <AnkiCardRenderer card={card} deckId={deckId} side="front" />
        <span className="card-preview-side-label">Back</span>
        <AnkiCardRenderer card={card} deckId={deckId} side="back" frontHtml={frontHtml} />
      </div>

      <dl className="card-context-meta">
        <div><dt>Note type</dt><dd>{card.modelName || card.type}</dd></div>
        <div><dt>State</dt><dd><b className={`state-chip ${statusColors[card.state] || 'neutral'}`}>{card.state}</b></dd></div>
        <div><dt>Due</dt><dd>{card.due ?? '-'}</dd></div>
        <div><dt>Modified</dt><dd>{relativeTime(card.modifiedAt)} by {card.modifiedBy}</dd></div>
        <div><dt>Anki note</dt><dd>{card.ankiNoteId ?? card.id}</dd></div>
      </dl>

      <div className="card-context-tags" aria-label="Selected card tags">
        {visibleTags.length ? visibleTags.map((tag) => <em key={tag}>{tag}</em>) : <small>No tags</small>}
        {card.tags.length > visibleTags.length ? <small>+{card.tags.length - visibleTags.length} more</small> : null}
      </div>

      {pendingSuggestion ? (
        <div className="card-context-linked-review">
          <small>Pending suggestion</small>
          <strong>{pendingSuggestion.authorName}</strong>
          <span>{pendingSuggestion.reason || 'Review proposed card changes.'}</span>
          <button className="button secondary" type="button" onClick={() => onOpenSuggestion(pendingSuggestion)}>
            Open in Review
          </button>
        </div>
      ) : null}

      {duplicateCount > 0 ? (
        <small className="card-context-signal">{duplicateCount} related or duplicate candidate{duplicateCount === 1 ? '' : 's'} linked to this card.</small>
      ) : null}

      {canSuggest ? (
        <button className="button primary card-context-action" type="button" onClick={() => onEditCard(card.id)}>
          Suggest edit
        </button>
      ) : null}
    </section>
  );
}

const REVIEW_BUCKETS: Array<{ key: ReviewBucket; label: string; detail: string }> = [
  { key: 'all', label: 'All review', detail: 'Every item' },
  { key: 'answer', label: 'Answer changed', detail: 'Check facts' },
  { key: 'source', label: 'Source check', detail: 'Needs evidence' },
  { key: 'tag', label: 'Tag-only', detail: 'Cleanup' },
  { key: 'render', label: 'Formatting/render', detail: 'Preview risk' },
  { key: 'conflict', label: 'Sync conflict', detail: 'Blocks push' }
];

function ReviewRiskBadge({ label }: { label: ReviewRiskLabel }) {
  const className = label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '');
  return <span className={`review-risk-badge review-risk-badge--${className}`}>{label}</span>;
}

function ReviewQualitySummary({
  activeBucket,
  counts,
  onBucketChange
}: {
  activeBucket: ReviewBucket;
  counts: Record<ReviewBucket, number>;
  onBucketChange: (bucket: ReviewBucket) => void;
}) {
  return (
    <div className="review-quality-summary" aria-label="Quality review buckets">
      {REVIEW_BUCKETS.map((bucket) => (
        <button
          key={bucket.key}
          type="button"
          className={`review-bucket ${activeBucket === bucket.key ? 'active' : ''}`}
          onClick={() => onBucketChange(bucket.key)}
          aria-pressed={activeBucket === bucket.key}
        >
          <span>{bucket.label}</span>
          <strong>{counts[bucket.key]}</strong>
          <small>{bucket.detail}</small>
        </button>
      ))}
    </div>
  );
}

function ReviewQueueList({
  items,
  selectedItem,
  suggestions,
  cards,
  sourceCheckByReviewItem,
  canReview,
  selectedSuggestionIds,
  onSelect,
  onToggleSuggestion
}: {
  items: QualityReviewItem[];
  selectedItem?: QualityReviewItem;
  suggestions: Suggestion[];
  cards: DeckCard[];
  sourceCheckByReviewItem: Record<string, 'needs' | 'checked'>;
  canReview: boolean;
  selectedSuggestionIds: Set<string>;
  onSelect: (item: QualityReviewItem) => void;
  onToggleSuggestion: (suggestionId: string) => void;
}) {
  if (!items.length) {
    return <EmptyState message="No quality review items match the current filters." />;
  }

  return (
    <div className="quality-queue-list" aria-label="Quality review queue">
      {items.map((item) => {
        const suggestion = item.suggestionId ? suggestions.find((candidate) => candidate.id === item.suggestionId) : undefined;
        const card = item.cardId ? cards.find((candidate) => candidate.id === item.cardId) : undefined;
        const prompt = reviewCardPrompt(card);
        const affected = affectedFieldsLabel(item);
        const sourceStatus = sourceCheckLabel(item, sourceCheckByReviewItem[item.id]);
        return (
          <div className={`quality-queue-item ${item.id === selectedItem?.id ? 'active' : ''}`} key={item.id}>
            {canReview && suggestion?.status === 'pending' ? (
              <input
                type="checkbox"
                className="queue-select"
                checked={selectedSuggestionIds.has(suggestion.id)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation();
                  onToggleSuggestion(suggestion.id);
                }}
                aria-label={`${selectedSuggestionIds.has(suggestion.id) ? 'Deselect' : 'Select'} ${suggestion.authorName}'s suggestion`}
              />
            ) : <span className="queue-select-spacer" aria-hidden="true" />}
            <button type="button" className="quality-queue-main" onClick={() => onSelect(item)}>
              <span className={`risk-dot risk-dot--${item.risk}`} aria-hidden="true" />
              <span className="quality-queue-copy">
                <strong>{prompt}</strong>
                <small>{item.label} · {item.source} · {relativeTime(item.sortAt)}</small>
                <small className="quality-queue-affected">Affected: {affected}</small>
                <small className={`quality-queue-source quality-queue-source--${sourceCheckByReviewItem[item.id] || (item.needsSourceCheck ? 'needs' : 'checked')}`}>
                  {sourceStatus}
                </small>
                <span className="quality-queue-labels">
                  {item.labels.slice(0, 3).map((label) => <ReviewRiskBadge key={label} label={label} />)}
                </span>
              </span>
              <b className={`queue-status ${item.status}`}>{item.status}</b>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function formatFieldValue(value?: string) {
  const trimmed = (value || '').trim();
  return trimmed || 'Empty';
}

function reviewCardPrompt(card?: DeckCard) {
  if (!card) return 'Card not found';
  return fieldValue(card, 'Front') || Object.values(card.fields)[0] || card.id;
}

function affectedFieldsLabel(item: QualityReviewItem) {
  const fields = [...item.changedFields];
  if (item.changedTags) fields.push('Tags');
  return fields.length ? fields.join(', ') : 'Card context';
}

function hasRenderFallback(card: DeckCard, side: 'front' | 'back') {
  const rendered = side === 'front' ? card.renderedFront : card.renderedBack;
  const template = side === 'front' ? card.templateFront : card.templateBack;
  return !rendered?.trim() && !template?.trim();
}

function sourceCheckLabel(item: QualityReviewItem, sourceCheckState?: 'needs' | 'checked') {
  if (sourceCheckState === 'checked') return 'Source checked this session';
  if (sourceCheckState === 'needs') return 'Needs source check this session';
  if (item.needsSourceCheck) return 'Needs source check';
  return 'Source checked';
}

function ChangedFieldRows({ currentCard, suggestion, conflict }: {
  currentCard?: DeckCard;
  suggestion?: Suggestion;
  conflict?: AppState['sync']['conflicts'][number];
}) {
  const fields = suggestion
    ? Object.keys(suggestion.proposedFields || {}).filter((field) => (currentCard?.fields[field] || '') !== (suggestion.proposedFields[field] || ''))
    : conflict
      ? Array.from(new Set([...Object.keys(conflict.localFields || {}), ...Object.keys(conflict.incomingFields || {})])).sort()
      : [];

  if (!fields.length) {
    return <EmptyState message="No raw field changes are available for this item." />;
  }

  return (
    <div className="raw-change-list">
      {fields.map((field) => {
        const before = conflict ? conflict.localFields[field] : currentCard?.fields[field];
        const after = conflict ? conflict.incomingFields[field] : suggestion?.proposedFields[field];
        return <DiffBlock key={field} label={field} before={formatFieldValue(before)} after={formatFieldValue(after)} />;
      })}
    </div>
  );
}

function ReviewDecisionBar({
  item,
  canReview,
  busy,
  hasSuggestion,
  hasConflicts,
  renderFallback,
  canSuggest,
  sourceCheckState,
  onDecideSuggestion,
  onResolveConflict,
  onMarkNeedsSourceCheck,
  onMarkSourceChecked,
  onCreateSuggestion,
  onPushToAnki
}: {
  item?: QualityReviewItem;
  canReview: boolean;
  busy: boolean;
  hasSuggestion: boolean;
  hasConflicts: boolean;
  renderFallback: boolean;
  canSuggest: boolean;
  sourceCheckState: 'needs' | 'checked' | undefined;
  onDecideSuggestion: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onResolveConflict: (resolution: 'local' | 'incoming' | 'skip') => void;
  onMarkNeedsSourceCheck: () => void;
  onMarkSourceChecked: () => void;
  onCreateSuggestion: () => void;
  onPushToAnki: () => void;
}) {
  if (item?.kind === 'conflict') {
    return (
      <div className="review-decision-bar review-decision-bar--conflict">
        <span>
          <strong>Source-of-truth decision</strong>
          <small>Push to Anki stays blocked until this conflict is resolved.</small>
        </span>
        <button className="button secondary" onClick={() => onResolveConflict('skip')} disabled={busy}>Skip for now</button>
        <button className="button secondary" onClick={() => onResolveConflict('local')} disabled={busy}>Keep local Anki</button>
        <button className="button primary" onClick={() => onResolveConflict('incoming')} disabled={busy}>Use DeckBridge</button>
        <button
          className="button secondary"
          disabled
          title="Push blocked: resolve sync conflicts before writing accepted changes back to Anki."
        >
          <Icon name="sync" /> Push to Anki blocked
        </button>
      </div>
    );
  }

  if (canReview && hasSuggestion) {
    const cautious = item?.needsSourceCheck || item?.risk === 'high' || renderFallback;
    return (
      <div className={`review-decision-bar ${cautious ? 'review-decision-bar--cautious' : ''}`}>
        <span>
          <strong>{cautious ? 'Check source before accepting' : 'Suggestion decision'}</strong>
          <small>{renderFallback ? 'Rendered HTML is missing; compare the field-rendered preview with raw diffs before accepting.' : cautious ? 'Request revision is the safer action until the evidence is checked.' : 'Approved changes become canonical for the deck.'}</small>
        </span>
        <button className="button secondary" onClick={() => onDecideSuggestion('rejected')} disabled={busy}><Icon name="x" /> Reject</button>
        <button className={cautious ? 'button primary' : 'button secondary'} onClick={() => onDecideSuggestion('revision')} disabled={busy}>Request revision</button>
        {sourceCheckState === 'checked' ? (
          <button className="button secondary" onClick={onMarkNeedsSourceCheck} disabled={busy}>Mark needs source check</button>
        ) : (
          <button className={cautious ? 'button primary' : 'button secondary'} onClick={onMarkSourceChecked} disabled={busy}>Mark checked</button>
        )}
        <button className={cautious ? 'button secondary' : 'button primary'} onClick={() => onDecideSuggestion('accepted')} disabled={busy}><Icon name="check" /> Accept</button>
      </div>
    );
  }

  return (
    <div className="review-decision-bar">
      <span>
        <strong>Card actions</strong>
        <small>{hasConflicts ? 'Push blocked by unresolved sync conflicts.' : 'Accepted changes can be pushed back to Anki.'}</small>
      </span>
      <button className="button secondary" onClick={onCreateSuggestion} disabled={busy || !canSuggest}><Icon name="spark" /> Suggest edit</button>
      {item ? <button className="button secondary" onClick={onMarkNeedsSourceCheck} disabled={busy}>Mark needs source check</button> : null}
      <button
        className="button primary"
        disabled={busy || hasConflicts}
        title={hasConflicts ? 'Push blocked: resolve sync conflicts before writing accepted changes back to Anki.' : undefined}
        onClick={onPushToAnki}
      >
        <Icon name="sync" /> Push to Anki
      </button>
    </div>
  );
}

function ReviewInspectionPanel({
  item,
  deck,
  currentCard,
  suggestion,
  conflict,
  reviewTab,
  setReviewTab,
  currentUserId,
  currentUserName,
  commentsVersion,
  brief,
  aiReviewEnabled,
  canManageAi,
  briefBusy,
  canReview,
  busy,
  hasConflicts,
  canSuggest,
  sourceCheckState,
  draftReason,
  setDraftReason,
  onGenerateBrief,
  onMarkBriefUseful,
  onDismissBrief,
  onDecideSuggestion,
  onResolveConflict,
  onMarkNeedsSourceCheck,
  onMarkSourceChecked,
  onCreateSuggestion,
  onPushToAnki
}: {
  item?: QualityReviewItem;
  deck: Deck;
  currentCard?: DeckCard;
  suggestion?: Suggestion;
  conflict?: AppState['sync']['conflicts'][number];
  reviewTab: 'changes' | 'discussion';
  setReviewTab: (tab: 'changes' | 'discussion') => void;
  currentUserId: string;
  currentUserName: string;
  commentsVersion: number;
  brief: AiArtifact | null;
  aiReviewEnabled: boolean;
  canManageAi: boolean;
  briefBusy: boolean;
  canReview: boolean;
  busy: boolean;
  hasConflicts: boolean;
  canSuggest: boolean;
  sourceCheckState: 'needs' | 'checked' | undefined;
  draftReason: string;
  setDraftReason: (value: string) => void;
  onGenerateBrief: () => void;
  onMarkBriefUseful: (artifactId: string) => void;
  onDismissBrief: (artifactId: string) => void;
  onDecideSuggestion: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onResolveConflict: (resolution: 'local' | 'incoming' | 'skip') => void;
  onMarkNeedsSourceCheck: () => void;
  onMarkSourceChecked: () => void;
  onCreateSuggestion: () => void;
  onPushToAnki: () => void;
}) {
  if (!currentCard) {
    return (
      <section className="review-inspection-panel">
        <EmptyState message="Select a quality review item to inspect the rendered card and raw changes." />
      </section>
    );
  }

  if (!item) {
    const currentFrontHtml = renderCardHtml(currentCard, deck.id, 'front', undefined, currentCard.clozeOrd);
    return (
      <section className="review-inspection-panel">
        <div className="review-inspection-header">
          <div>
            <small>Card context</small>
            <h2>{fieldValue(currentCard, 'Front') || Object.values(currentCard.fields)[0] || currentCard.id}</h2>
            <p>No queue item is selected. You can browse the card or propose a new owner-review change.</p>
          </div>
        </div>
        <div className="card-preview-single">
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={currentCard} deckId={deck.id} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={currentCard} deckId={deck.id} side="back" frontHtml={currentFrontHtml} />
        </div>
        <ReviewDecisionBar
          canReview={canReview}
          busy={busy}
          hasSuggestion={false}
          hasConflicts={hasConflicts}
          renderFallback={hasRenderFallback(currentCard, 'front') || hasRenderFallback(currentCard, 'back')}
          canSuggest={canSuggest}
          sourceCheckState={sourceCheckState}
          onDecideSuggestion={onDecideSuggestion}
          onResolveConflict={onResolveConflict}
          onMarkNeedsSourceCheck={onMarkNeedsSourceCheck}
          onMarkSourceChecked={onMarkSourceChecked}
          onCreateSuggestion={onCreateSuggestion}
          onPushToAnki={onPushToAnki}
        />
      </section>
    );
  }

  const proposedCard: DeckCard = suggestion
    ? { ...currentCard, fields: { ...currentCard.fields, ...suggestion.proposedFields }, tags: suggestion.proposedTags, renderedFront: undefined, renderedBack: undefined }
    : currentCard;
  const showRendered = item.kind !== 'conflict' && !(item.labels.includes('Tag-only') && !item.labels.includes('Formatting/render'));
  const prompt = reviewCardPrompt(currentCard);
  const effectiveNeedsSourceCheck = sourceCheckState === 'checked' ? false : sourceCheckState === 'needs' ? true : item.needsSourceCheck;
  const effectiveLabels = effectiveNeedsSourceCheck && !item.labels.includes('Source check')
    ? [...item.labels, 'Source check' as const]
    : item.labels;
  const renderFallback = item.kind !== 'conflict' && (
    hasRenderFallback(currentCard, 'front') ||
    hasRenderFallback(currentCard, 'back') ||
    (suggestion ? hasRenderFallback(proposedCard, 'front') || hasRenderFallback(proposedCard, 'back') : false)
  );

  return (
    <section className={`review-inspection-panel review-inspection-panel--${item.kind}`}>
      <div className="review-inspection-header">
        <div>
          <small>{item.kind === 'conflict' ? 'Conflict review' : 'Card quality review'}</small>
          <h2>{prompt}</h2>
          <p>{item.kind === 'conflict' ? 'Which source of truth should win?' : 'Should this proposed change become canonical?'}</p>
        </div>
        <div className="review-risk-stack">
          <b className={`review-risk-score review-risk-score--${item.risk}`}>{item.risk} risk</b>
          {effectiveLabels.map((label) => <ReviewRiskBadge key={label} label={label} />)}
        </div>
      </div>

      {item.blocksPush ? (
        <div className="review-warning">
          Push to Anki is blocked because unresolved sync conflicts could overwrite local Anki or DeckBridge edits.
        </div>
      ) : effectiveNeedsSourceCheck ? (
        <div className="review-warning">
          Source check recommended before quiet acceptance. Use Mark checked only after source evidence has been reviewed.
        </div>
      ) : null}

      {sourceCheckState === 'checked' ? (
        <div className="review-source-checked">Source check marked checked in this review session.</div>
      ) : null}

      <div className="review-tabs">
        <button className={reviewTab === 'changes' ? 'active' : ''} onClick={() => setReviewTab('changes')}>Inspection</button>
        <button className={reviewTab === 'discussion' ? 'active' : ''} onClick={() => setReviewTab('discussion')} disabled={!suggestion}>Discussion</button>
      </div>

      {reviewTab === 'changes' ? (
        <>
          {showRendered ? (
            <CardPreviewComparison
              currentCard={currentCard}
              proposedCard={proposedCard}
              deckId={deck.id}
              hasSuggestion={!!suggestion}
            />
          ) : (
            <div className="review-render-collapsed">
              <strong>Rendered preview collapsed for tag-only review.</strong>
              <span>Raw tag changes are the primary quality check for this item.</span>
            </div>
          )}

          <div className="review-detail-grid">
            <section className="review-detail-section">
              <div className="review-section-heading">
                <strong>Raw field changes</strong>
                <small>{item.changedFields.length ? item.changedFields.join(', ') : 'No field changes'}</small>
              </div>
              <ChangedFieldRows currentCard={currentCard} suggestion={suggestion} conflict={conflict} />
            </section>

            <section className="review-detail-section">
              <div className="review-section-heading">
                <strong>Tags and source cues</strong>
                <small>{item.changedTags ? 'Tags changed' : 'Tags unchanged'}</small>
              </div>
              <div className="tag-diff">
                <span>{currentCard.tags.join(', ') || 'No tags'}</span>
                <strong>→</strong>
                <span>{suggestion?.proposedTags.join(', ') || currentCard.tags.join(', ') || 'No tags'}</span>
              </div>
              <div className="source-cue-list">
                <span>{effectiveNeedsSourceCheck ? 'Needs source check' : 'Source checked'}</span>
                <span>{item.affectsNextPull ? 'Affects next pull' : 'No next-pull impact'}</span>
                <span>{item.blocksPush ? 'Blocks push' : 'Does not block push'}</span>
                {renderFallback ? <span>Rendered HTML missing: field-rendered preview active</span> : null}
              </div>
              {suggestion ? (
                <label className="reason-box">
                  <span>Reason for change</span>
                  <textarea id="suggestion-reason" name="suggestion-reason" aria-label="Reason for change" value={suggestion.reason || draftReason} onChange={(event) => setDraftReason(event.target.value)} />
                </label>
              ) : null}
            </section>
          </div>
        </>
      ) : (
        suggestion ? (
          <SuggestionDiscussion
            suggestionId={suggestion.id}
            deckId={deck.id}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            commentsVersion={commentsVersion}
            brief={brief}
            aiEnabled={aiReviewEnabled}
            canManageAi={canManageAi}
            briefBusy={briefBusy}
            onGenerateBrief={onGenerateBrief}
            onMarkBriefUseful={onMarkBriefUseful}
            onDismissBrief={onDismissBrief}
          />
        ) : <EmptyState message="Discussion is available for suggestion items." />
      )}

      <ReviewDecisionBar
        item={item}
        canReview={canReview}
        busy={busy}
        hasSuggestion={!!suggestion}
        hasConflicts={hasConflicts}
        renderFallback={renderFallback}
        canSuggest={canSuggest}
        sourceCheckState={sourceCheckState}
        onDecideSuggestion={onDecideSuggestion}
        onResolveConflict={onResolveConflict}
        onMarkNeedsSourceCheck={onMarkNeedsSourceCheck}
        onMarkSourceChecked={onMarkSourceChecked}
        onCreateSuggestion={onCreateSuggestion}
        onPushToAnki={onPushToAnki}
      />
    </section>
  );
}

function ReviewWorkspace({
  deck,
  items,
  selectedItem,
  selectedCard,
  selectedSuggestion,
  selectedConflict,
  suggestions,
  bucketCounts,
  activeBucket,
  onBucketChange,
  statusFilter,
  onStatusFilterChange,
  authorFilter,
  onAuthorFilterChange,
  authors,
  canReview,
  canManageDeck,
  busy,
  selectedSuggestionIds,
  onToggleSuggestion,
  onSelectItem,
  onResetFilters,
  onBulkDecision,
  onClearSelection,
  reviewTab,
  setReviewTab,
  currentUserId,
  currentUserName,
  commentsVersion,
  brief,
  briefBusy,
  draftReason,
  setDraftReason,
  onGenerateBrief,
  onMarkBriefUseful,
  onDismissBrief,
  onDecideSuggestion,
  onResolveConflict,
  sourceCheckByReviewItem,
  onMarkNeedsSourceCheck,
  onMarkSourceChecked,
  onCreateSuggestion,
  onPushToAnki,
  hasConflicts,
  canSuggest,
}: {
  deck: Deck;
  items: QualityReviewItem[];
  selectedItem?: QualityReviewItem;
  selectedCard?: DeckCard;
  selectedSuggestion?: Suggestion;
  selectedConflict?: AppState['sync']['conflicts'][number];
  suggestions: Suggestion[];
  bucketCounts: Record<ReviewBucket, number>;
  activeBucket: ReviewBucket;
  onBucketChange: (bucket: ReviewBucket) => void;
  statusFilter: 'pending' | 'accepted' | 'rejected' | 'revision' | 'all';
  onStatusFilterChange: (status: 'pending' | 'accepted' | 'rejected' | 'revision' | 'all') => void;
  authorFilter: string;
  onAuthorFilterChange: (author: string) => void;
  authors: string[];
  canReview: boolean;
  canManageDeck: boolean;
  busy: boolean;
  selectedSuggestionIds: Set<string>;
  onToggleSuggestion: (suggestionId: string) => void;
  onSelectItem: (item: QualityReviewItem) => void;
  onResetFilters: () => void;
  onBulkDecision: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onClearSelection: () => void;
  reviewTab: 'changes' | 'discussion';
  setReviewTab: (tab: 'changes' | 'discussion') => void;
  currentUserId: string;
  currentUserName: string;
  commentsVersion: number;
  brief: AiArtifact | null;
  briefBusy: boolean;
  draftReason: string;
  setDraftReason: (value: string) => void;
  onGenerateBrief: () => void;
  onMarkBriefUseful: (artifactId: string) => void;
  onDismissBrief: (artifactId: string) => void;
  onDecideSuggestion: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onResolveConflict: (resolution: 'local' | 'incoming' | 'skip') => void;
  sourceCheckByReviewItem: Record<string, 'needs' | 'checked'>;
  onMarkNeedsSourceCheck: (itemId: string) => void;
  onMarkSourceChecked: (itemId: string) => void;
  onCreateSuggestion: () => void;
  onPushToAnki: () => void;
  hasConflicts: boolean;
  canSuggest: boolean;
}) {
  return (
    <div className="quality-review-workspace">
      <div className="quality-review-header">
        <div>
          <small>Quality Review Workspace</small>
          <h1>{deck.name}</h1>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={onResetFilters}
          disabled={activeBucket === 'all' && statusFilter === 'pending' && authorFilter === 'All'}
        >
          <Icon name="filter" /> Reset review filters
        </button>
      </div>

      <ReviewQualitySummary
        activeBucket={activeBucket}
        counts={bucketCounts}
        onBucketChange={onBucketChange}
      />

      <div className="quality-review-layout">
        <aside className="quality-queue-panel">
          <div className="review-filter-bar" aria-label="Review queue filters">
            <label>
              <span>Status</span>
              <select
                aria-label="Filter review queue by status"
                value={statusFilter}
                onChange={(event) => onStatusFilterChange(event.target.value as typeof statusFilter)}
              >
                <option value="pending">Pending</option>
                <option value="revision">Needs revision</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
                <option value="all">All statuses</option>
              </select>
            </label>
            <label>
              <span>Author</span>
              <select
                aria-label="Filter review queue by author"
                value={authorFilter}
                onChange={(event) => onAuthorFilterChange(event.target.value)}
              >
                {authors.map((author) => <option key={author}>{author}</option>)}
              </select>
            </label>
          </div>
          <ReviewQueueList
            items={items}
            selectedItem={selectedItem}
            suggestions={suggestions}
            cards={deck.cards}
            sourceCheckByReviewItem={sourceCheckByReviewItem}
            canReview={canReview}
            selectedSuggestionIds={selectedSuggestionIds}
            onSelect={onSelectItem}
            onToggleSuggestion={onToggleSuggestion}
          />
          {canReview && selectedSuggestionIds.size > 0 ? (
            <div className="suggestion-bulk-toolbar" role="toolbar" aria-label="Bulk suggestion decisions">
              <span>{selectedSuggestionIds.size} selected</span>
              <button className="button secondary" onClick={() => onBulkDecision('rejected')} disabled={busy}>Reject</button>
              <button className="button secondary" onClick={() => onBulkDecision('revision')} disabled={busy}>Request revision</button>
              <button className="button primary" onClick={() => onBulkDecision('accepted')} disabled={busy}>Accept</button>
              <button className="button secondary" onClick={onClearSelection} disabled={busy}>Clear</button>
            </div>
          ) : null}
        </aside>

        <ReviewInspectionPanel
          item={selectedItem}
          deck={deck}
          currentCard={selectedCard}
          suggestion={selectedSuggestion}
          conflict={selectedConflict}
          reviewTab={reviewTab}
          setReviewTab={setReviewTab}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          commentsVersion={commentsVersion}
          brief={brief}
          aiReviewEnabled={deck.aiSettings?.reviewBriefs === true}
          canManageAi={canManageDeck}
          briefBusy={briefBusy}
          canReview={canReview}
          busy={busy}
          hasConflicts={hasConflicts}
          canSuggest={canSuggest}
          sourceCheckState={sourceCheckByReviewItem[selectedItem?.id || '']}
          draftReason={draftReason}
          setDraftReason={setDraftReason}
          onGenerateBrief={onGenerateBrief}
          onMarkBriefUseful={onMarkBriefUseful}
          onDismissBrief={onDismissBrief}
          onDecideSuggestion={onDecideSuggestion}
          onResolveConflict={onResolveConflict}
          onMarkNeedsSourceCheck={() => selectedItem && onMarkNeedsSourceCheck(selectedItem.id)}
          onMarkSourceChecked={() => selectedItem && onMarkSourceChecked(selectedItem.id)}
          onCreateSuggestion={onCreateSuggestion}
          onPushToAnki={onPushToAnki}
        />
      </div>
    </div>
  );
}

function ModelTemplateEditor({ deck, busy, onSave }: {
  deck: Deck;
  busy: boolean;
  onSave: (modelName: string, payload: { templateFront: string; templateBack: string; modelCss: string }) => void;
}) {
  const models = useMemo(() => (
    Array.from(new Set(deck.cards.map((card) => card.modelName || card.type || 'Basic'))).sort()
  ), [deck.cards]);
  const [selectedModel, setSelectedModel] = useState(models[0] || '');
  const modelCards = useMemo(
    () => deck.cards.filter((card) => (card.modelName || card.type || 'Basic') === selectedModel),
    [deck.cards, selectedModel]
  );
  const previewCard = modelCards[0];
  const [templateForm, setTemplateForm] = useState({ templateFront: '', templateBack: '', modelCss: '' });

  useEffect(() => {
    if (!models.includes(selectedModel)) setSelectedModel(models[0] || '');
  }, [models, selectedModel]);

  useEffect(() => {
    setTemplateForm({
      templateFront: previewCard?.templateFront || '{{Front}}',
      templateBack: previewCard?.templateBack || '{{FrontSide}}<hr id=answer>{{Back}}',
      modelCss: previewCard?.modelCss || ''
    });
  }, [previewCard?.id, previewCard?.templateFront, previewCard?.templateBack, previewCard?.modelCss]);

  if (!models.length || !previewCard) {
    return <EmptyState message="This deck has no cards to preview." />;
  }

  const draftCard: DeckCard = {
    ...previewCard,
    ...templateForm,
    renderedFront: undefined,
    renderedBack: undefined
  };
  const frontHtml = renderCardHtml(draftCard, deck.id, 'front', undefined, draftCard.clozeOrd);

  return (
    <div className="model-editor">
      <div className="model-editor-header">
        <div>
          <small>Model editor</small>
          <strong>{selectedModel}</strong>
        </div>
        <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} aria-label="Select card model">
          {models.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </div>
      <div className="model-editor-grid">
        <section>
          <label>
            <span>Front template</span>
            <textarea value={templateForm.templateFront} onChange={(event) => setTemplateForm((prev) => ({ ...prev, templateFront: event.target.value }))} rows={8} spellCheck={false} />
          </label>
          <label>
            <span>Back template</span>
            <textarea value={templateForm.templateBack} onChange={(event) => setTemplateForm((prev) => ({ ...prev, templateBack: event.target.value }))} rows={8} spellCheck={false} />
          </label>
          <label>
            <span>Model CSS</span>
            <textarea value={templateForm.modelCss} onChange={(event) => setTemplateForm((prev) => ({ ...prev, modelCss: event.target.value }))} rows={8} spellCheck={false} />
          </label>
          <button className="button primary" disabled={busy} onClick={() => onSave(selectedModel, templateForm)}>
            Save template
          </button>
        </section>
        <section className="model-preview">
          <small>Preview card</small>
          <strong>{fieldValue(previewCard, 'Front') || Object.values(previewCard.fields)[0] || previewCard.id}</strong>
          <AnkiCardRenderer card={draftCard} deckId={deck.id} side="front" frontHtml={frontHtml} clozeOrd={draftCard.clozeOrd} />
          <AnkiCardRenderer card={draftCard} deckId={deck.id} side="back" frontHtml={frontHtml} clozeOrd={draftCard.clozeOrd} />
        </section>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null);
  const [selectedOwnerQueueItemId, setSelectedOwnerQueueItemId] = useState<string | null>(null);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(new Set());
  const [commentsVersion, setCommentsVersion] = useState(0);
  const [queryInput, setQueryInput] = useState('');
  const query = useDebounce(queryInput, 220);
  const [tagFilter, setTagFilter] = useState('All');
  const [cardStateFilter, setCardStateFilter] = useState('All');
  const [draftReason, setDraftReason] = useState('Clarified wording and improved tagging.');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [authNotice, setAuthNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [apiHealth, setApiHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [authReady, setAuthReady] = useState(!supabase);
  const [session, setSession] = useState<Session | null>(null);
  const [deckLoading, setDeckLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [showConnectWizard, setShowConnectWizard] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'tag-add' | 'tag-remove' | 'delete' | null>(null);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('overview');
  const [showStudy, setShowStudy] = useState(false);
  const [studyApprovedOnly, setStudyApprovedOnly] = useState(true);
  const [reviewTab, setReviewTab] = useState<'changes' | 'discussion'>('changes');
  const [reviewRiskFilter, setReviewRiskFilter] = useState<ReviewBucket>('all');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<'pending' | 'accepted' | 'rejected' | 'revision' | 'all'>('pending');
  const [reviewAuthorFilter, setReviewAuthorFilter] = useState('All');
  const [sourceCheckByReviewItem, setSourceCheckByReviewItem] = useState<Record<string, 'needs' | 'checked'>>({});
  const [suggestionBriefs, setSuggestionBriefs] = useState<Record<string, AiArtifact | null>>({});
  const [qualityPulse, setQualityPulse] = useState<AiQualityPulse | null>(null);
  const [qualityPulseBusy, setQualityPulseBusy] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [duplicateLinks, setDuplicateLinks] = useState<AiDuplicateLink[]>([]);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [conflictReviewSnapshot, setConflictReviewSnapshot] = useState<Conflict[]>([]);
  const [topView, setTopView] = useState<'workspace' | 'discover' | 'templates'>('workspace');
  const [deckVisibility, setDeckVisibility] = useState<Record<string, string>>({});
  const [copiedShare, setCopiedShare] = useState('');
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('deckbridge-dark') === 'true');
  const [addonPackage, setAddonPackage] = useState<AddonPackageState>({
    loading: true,
    version: null,
    availability: null,
    error: ''
  });
  const toastTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const retainConflictReviewSnapshot = useRef(false);
  const overviewTabRef = useRef<HTMLButtonElement>(null);
  const suggestionImportRef = useRef<HTMLInputElement>(null);
  const activeDeck = state?.decks.find((deck) => deck.id === state.activeDeckId) || state?.decks[0];

  function applyAuthoritativeState(next: AppState) {
    retainConflictReviewSnapshot.current = false;
    setState(next);
  }

  function applyHydratedDeckState(next: AppState) {
    retainConflictReviewSnapshot.current = false;
    setState((previous) => mergeHydratedDeckState(previous, next));
  }

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setApiAuthToken(data.session?.access_token || null);
      setAuthReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setApiAuthToken(nextSession?.access_token || null);
      setAuthReady(true);
      if (!nextSession) setState(null);
    });
    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady || (supabase && !session)) return;
    let cancelled = false;

    async function loadDemoState() {
      try {
        const [next] = await Promise.all([api.state(), api.health()]);
        if (cancelled) return;
        applyAuthoritativeState(next);
        setApiHealth('ok');
        const nextActiveDeck = next.decks.find((deck) => deck.id === next.activeDeckId);
        setSelectedCardId(nextActiveDeck?.cards[0]?.id || null);
        setSelectedSuggestionId(next.suggestions.find((item) => item.status === 'pending')?.id || null);
      } catch (error) {
        if (cancelled) return;
        setApiHealth('down');
        pushToast(error instanceof Error ? error.message : 'Unable to load DeckBridge workspace', 'error');
      }
    }

    async function loadAuthenticatedState() {
      try {
        const [me, healthOk] = await Promise.all([
          api.me(),
          api.health().then(() => true).catch(() => false)
        ]);
        if (cancelled) return;

        const shell = stateFromMeResponse(me, state?.activeDeckId);
        applyAuthoritativeState(shell);
        setApiHealth(healthOk ? 'ok' : 'down');

        if (!shell.activeDeckId) return;
        setDeckLoading(true);
        const next = await api.deck(shell.activeDeckId);
        if (cancelled) return;
        applyHydratedDeckState(next);
        const nextActiveDeck = next.decks.find((deck) => deck.id === next.activeDeckId);
        setSelectedCardId(nextActiveDeck?.cards[0]?.id || null);
        setSelectedSuggestionId(next.suggestions.find((item) => item.status === 'pending')?.id || null);
      } catch (error) {
        if (cancelled) return;
        setApiHealth('down');
        pushToast(error instanceof Error ? error.message : 'Unable to load DeckBridge workspace', 'error');
      } finally {
        if (!cancelled) setDeckLoading(false);
      }
    }

    if (supabase) void loadAuthenticatedState();
    else void loadDemoState();

    return () => {
      cancelled = true;
    };
  }, [authReady, session?.access_token]);

  useEffect(() => {
    if (supabase && !session) return undefined;
    if (!state?.activeDeckId) return undefined;
    const timer = window.setInterval(() => {
      api.ankiStatus()
        .then(() => api.deck(state.activeDeckId!))
        .then(applyHydratedDeckState)
        .catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [session?.access_token, state?.activeDeckId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('deckbridge-dark', String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    let mounted = true;
    setAddonPackage((current) => ({ ...current, loading: true }));
    api.addonVersion()
      .then(async (version) => {
        const availability = await api.addonDownloadAvailability(version.downloadUrl || '/api/addon/download');
        if (!mounted) return;
        setAddonPackage({ loading: false, version, availability, error: '' });
      })
      .catch(async (error) => {
        const availability = await api.addonDownloadAvailability('/api/addon/download');
        if (!mounted) return;
        setAddonPackage({
          loading: false,
          version: null,
          availability,
          error: error instanceof Error ? error.message : 'Unable to load add-on package details'
        });
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, tagFilter, cardStateFilter, activeDeck?.id]);

  function pushToast(message: string, type: Toast['type'] = 'info') {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-2), { id, message, type }]);
    toastTimers.current[id] = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      delete toastTimers.current[id];
    }, 4500);
  }

  function dismissToast(id: string) {
    clearTimeout(toastTimers.current[id]);
    delete toastTimers.current[id];
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  const refreshActiveDeckState = useCallback(() => {
    const deckId = state?.activeDeckId;
    const task = deckId ? api.deck(deckId).then(applyHydratedDeckState) : api.state().then(applyAuthoritativeState);
    return task.catch(() => undefined);
  }, [state?.activeDeckId]);

  const handleSuggestionChange = useCallback(() => {
    void refreshActiveDeckState();
  }, [refreshActiveDeckState]);

  const handleCommentChange = useCallback(() => {
    setCommentsVersion((version) => version + 1);
    void refreshActiveDeckState();
  }, [refreshActiveDeckState]);

  useRealtime({
    supabase,
    deckId: activeDeck?.id,
    onSuggestionChange: handleSuggestionChange,
    onCommentChange: handleCommentChange,
    enabled: !!session,
  });

  const activeSummary = state?.summaries.find((summary) => summary.id === activeDeck?.id);
  const currentMembership = state?.memberships?.find((item) => item.deckId === activeDeck?.id);
  const isDevDemo = import.meta.env.DEV;
  const membershipRole = isDevDemo
    ? (state?.role || 'contributor')
    : currentMembership?.role || (state?.role === 'owner' ? 'owner' : 'contributor');
  const canReview = ['owner', 'editor', 'reviewer'].includes(membershipRole);
  const canManageDeck = membershipRole === 'owner';
  const canSuggest = ['owner', 'editor', 'reviewer', 'contributor'].includes(membershipRole);
  const syncSnapshot = state?.sync || {
    ankiConnectUrl: '',
    connected: false,
    lastCheckedAt: null,
    lastPullAt: null,
    lastPushAt: null,
    lastAddonSync: null,
    conflicts: []
  };
  const activeSyncConflicts = syncSnapshot.conflicts;
  const pendingConflictIds = useMemo(() => activeSyncConflicts.map((conflict) => conflict.id), [activeSyncConflicts]);
  useEffect(() => {
    if (!activeSyncConflicts.length) return;
    const savedDecisions = readSavedConflictDecisions(activeSyncConflicts);
    const decidedConflictIds = new Set(Object.keys(savedDecisions));
    if (!decidedConflictIds.size) return;

    retainConflictReviewSnapshot.current = true;
    setState((previous) => previous ? {
      ...previous,
      sync: {
        ...previous.sync,
        conflicts: previous.sync.conflicts.filter((conflict) => !decidedConflictIds.has(conflict.id))
      }
    } : previous);
  }, [activeSyncConflicts]);
  const suggestions = useMemo(
    () => (state?.suggestions || []).filter((item) => item.deckId === activeDeck?.id),
    [state, activeDeck]
  );
  const pendingSuggestions = useMemo(() => suggestions.filter((item) => item.status === 'pending'), [suggestions]);
  const reviewAuthors = useMemo(() => ['All', ...Array.from(new Set(suggestions.map((item) => item.authorName))).sort()], [suggestions]);
  const ownerReviewQueue = useMemo(() => deriveOwnerReviewQueue({
    suggestions,
    conflicts: activeSyncConflicts,
    pulse: qualityPulse,
    cards: activeDeck?.cards || []
  }), [activeDeck?.cards, activeSyncConflicts, qualityPulse, suggestions]);
  const reviewBucketCounts = useMemo(() => deriveReviewBucketCounts(ownerReviewQueue), [ownerReviewQueue]);
  const queueItems = useMemo(() => ownerReviewQueue.filter((item) => {
    const bucketMatch = reviewItemMatchesBucket(item, reviewRiskFilter);
    const statusMatch = reviewStatusFilter === 'all' || item.status === reviewStatusFilter;
    const authorMatch = reviewAuthorFilter === 'All' || !item.authorName || item.authorName === reviewAuthorFilter;
    return bucketMatch && statusMatch && authorMatch;
  }), [ownerReviewQueue, reviewRiskFilter, reviewStatusFilter, reviewAuthorFilter]);
  const selectedOwnerQueueItem = queueItems.find((item) => item.id === selectedOwnerQueueItemId) || queueItems[0];
  const selectedSuggestion = selectSuggestionForReview(selectedOwnerQueueItem, suggestions, selectedSuggestionId);
  const selectedConflict = selectedOwnerQueueItem?.conflictId
    ? activeSyncConflicts.find((item) => item.id === selectedOwnerQueueItem.conflictId) || conflictReviewSnapshot.find((item) => item.id === selectedOwnerQueueItem.conflictId)
    : undefined;
  const selectedCard = activeDeck ? selectCardForReview(selectedOwnerQueueItem, selectedSuggestion, activeDeck.cards, selectedCardId) : undefined;
  const selectedSuggestionBrief = selectedSuggestion ? suggestionBriefs[selectedSuggestion.id] : null;
  const selectedDuplicateLinks = useMemo(() => duplicateLinks.filter((link) => (
    selectedCard && (link.sourceCardId === selectedCard.id || link.targetCardId === selectedCard.id)
  )), [duplicateLinks, selectedCard]);
  const duplicateCountsByCard = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of duplicateLinks) {
      counts.set(link.sourceCardId, (counts.get(link.sourceCardId) || 0) + 1);
      counts.set(link.targetCardId, (counts.get(link.targetCardId) || 0) + 1);
    }
    return counts;
  }, [duplicateLinks]);
  const allTags = useMemo(() => ['All', ...Array.from(new Set(activeDeck?.cards.flatMap((card) => card.tags) || [])).sort()], [activeDeck]);
  const cardStates = useMemo(() => ['All', ...Array.from(new Set(activeDeck?.cards.map((card) => card.state) || [])).sort()], [activeDeck]);
  const filteredCards = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (activeDeck?.cards || []).filter((card) => {
      const textMatch = !normalized || searchableCardText(card, activeDeck?.id || '').includes(normalized);
      const tagMatch = tagFilter === 'All' || card.tags.includes(tagFilter);
      const stateMatch = cardStateFilter === 'All' || card.state === cardStateFilter;
      return textMatch && tagMatch && stateMatch;
    });
  }, [activeDeck, query, tagFilter, cardStateFilter]);
  const maxPage = Math.max(1, Math.ceil(filteredCards.length / pageSize));
  const safePage = Math.min(page, maxPage);
  const pagedCards = filteredCards.slice((safePage - 1) * pageSize, safePage * pageSize);
  const currentStart = filteredCards.length ? (safePage - 1) * pageSize + 1 : 0;
  const currentEnd = Math.min(safePage * pageSize, filteredCards.length);
  const cardsWithPendingSuggestions = useMemo(() => new Set(pendingSuggestions.map((item) => item.cardId)), [pendingSuggestions]);

  useEffect(() => {
    const pendingIds = new Set(pendingSuggestions.map((item) => item.id));
    setSelectedSuggestionIds((prev) => {
      const next = new Set([...prev].filter((id) => pendingIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pendingSuggestions]);
  const approvedStudyCards = useMemo(() => (activeDeck?.cards || []).filter((card) => (
    !card.suspended && !cardsWithPendingSuggestions.has(card.id)
  )), [activeDeck, cardsWithPendingSuggestions]);
  const studyCards = studyApprovedOnly ? approvedStudyCards : (activeDeck?.cards || []);
  const closeStudyView = useCallback(() => {
    setShowStudy(false);
    setActiveTab('overview');
    window.requestAnimationFrame(() => {
      overviewTabRef.current?.focus({ preventScroll: true });
    });
  }, []);
  const suggestionStats = useMemo(() => {
    const total = suggestions.length;
    const accepted = suggestions.filter((item) => item.status === 'accepted').length;
    const rejected = suggestions.filter((item) => item.status === 'rejected').length;
    const pending = suggestions.filter((item) => item.status === 'pending').length;
    const revision = suggestions.filter((item) => item.status === 'revision').length;
    return {
      total,
      accepted,
      rejected,
      pending,
      revision,
      acceptanceRate: total ? Math.round((accepted / total) * 100) : 0
    };
  }, [suggestions]);
  const deckEmbedCode = activeDeck ? `<iframe src="${window.location.origin}/embed/decks/${activeDeck.id}" title="${activeDeck.name}" loading="lazy"></iframe>` : '';
  useEffect(() => {
    setConflictReviewSnapshot((previous) => {
      if (!activeDeck?.id) return previous.length ? [] : previous;
      if (previous.some((conflict) => conflict.deckId !== activeDeck.id)) return activeSyncConflicts.length ? activeSyncConflicts : [];
      if (!activeSyncConflicts.length) {
        return retainConflictReviewSnapshot.current || !previous.length ? previous : [];
      }

      const previousIds = new Set(previous.map((conflict) => conflict.id));
      const isResolutionShrink = previous.length > 0 &&
        activeSyncConflicts.length < previous.length &&
        activeSyncConflicts.every((conflict) => previousIds.has(conflict.id));

      return isResolutionShrink ? previous : activeSyncConflicts;
    });
  }, [activeDeck?.id, activeSyncConflicts]);
  const syncHealth = useMemo(() => deriveSyncHealth({
    activeDeck,
    addonPackage,
    apiHealth,
    sync: syncSnapshot
  }), [activeDeck, addonPackage, apiHealth, syncSnapshot]);
  const activeDeckVisibility = activeDeck ? (deckVisibility[activeDeck.id] ?? 'private') : 'private';
  const changedCards = useMemo(
    () => changedInLastSync(activeDeck, syncSnapshot.lastAddonSync),
    [activeDeck, syncSnapshot.lastAddonSync]
  );
  const ownerAttentionItems = useMemo(() => deriveOwnerAttentionItems({
    canReview,
    changedCards,
    deckVisibility: activeDeckVisibility,
    pendingSuggestions: pendingSuggestions.length,
    pulse: qualityPulse,
    studyCards: studyCards.length,
    syncHealth
  }), [activeDeckVisibility, canReview, changedCards, pendingSuggestions.length, qualityPulse, studyCards.length, syncHealth]);
  const activeRail = deriveWorkbenchRail({ activeTab, hasDeck: Boolean(activeDeck) });
  const cardRailCard = activeDeck?.cards.find((card) => card.id === selectedCardId) || selectedCard;
  const highlightedCard = activeTab === 'cards' ? cardRailCard : selectedCard;
  const cardRailPendingSuggestion = cardRailCard
    ? pendingSuggestions.find((item) => item.cardId === cardRailCard.id)
    : undefined;
  const contextRail = activeRail === 'overview' ? (
    <OverviewRail
      ownerAttentionItems={ownerAttentionItems}
      syncHealth={syncHealth}
      reviewCount={ownerReviewQueue.length}
      reviewBucketCounts={reviewBucketCounts}
      conflictCount={activeSyncConflicts.length}
      onDismissArtifact={dismissOwnerArtifact}
      onOwnerAction={handleOwnerAttentionAction}
      onOpenReviewBucket={(bucket) => {
        setReviewRiskFilter(bucket);
        setReviewStatusFilter('pending');
        setSelectedOwnerQueueItemId(null);
        setActiveTab('review');
      }}
      onOpenReview={() => setActiveTab('review')}
    />
  ) : activeRail === 'card' && activeDeck ? (
    <CardRail
      deckId={activeDeck.id}
      card={cardRailCard}
      pendingSuggestion={cardRailPendingSuggestion}
      duplicateCount={cardRailCard ? duplicateCountsByCard.get(cardRailCard.id) || 0 : 0}
      canSuggest={canSuggest}
      onEditCard={(cardId) => {
        setSelectedCardId(cardId);
        setEditingCardId(cardId);
      }}
      onOpenSuggestion={(suggestion) => {
        setSelectedSuggestionId(suggestion.id);
        setSelectedOwnerQueueItemId(`suggestion:${suggestion.id}`);
        setReviewRiskFilter('all');
        setReviewStatusFilter('pending');
        setActiveTab('review');
      }}
    />
  ) : null;

  const refreshQualityPulse = useCallback(async () => {
    if (!activeDeck?.id || !activeDeck.aiSettings?.qualityPulse) {
      setQualityPulse(null);
      return null;
    }
    setQualityPulseBusy(true);
    try {
      const pulse = await api.aiArtifacts.pulse(activeDeck.id);
      setQualityPulse(pulse);
      return pulse;
    } catch (_error) {
      setQualityPulse(null);
      return null;
    } finally {
      setQualityPulseBusy(false);
    }
  }, [activeDeck?.id, activeDeck?.aiSettings?.qualityPulse]);

  useEffect(() => {
    let mounted = true;
    if (!activeDeck?.id || !activeDeck.aiSettings?.qualityPulse) {
      setQualityPulse(null);
      return;
    }
    setQualityPulseBusy(true);
    api.aiArtifacts.pulse(activeDeck.id)
      .then((pulse) => {
        if (mounted) setQualityPulse(pulse);
      })
      .catch(() => {
        if (mounted) setQualityPulse(null);
      })
      .finally(() => {
        if (mounted) setQualityPulseBusy(false);
      });
    return () => {
      mounted = false;
    };
  }, [activeDeck?.id, activeDeck?.aiSettings?.qualityPulse]);

  useEffect(() => {
    if (!activeDeck?.id || !selectedSuggestion?.id || !activeDeck.aiSettings?.reviewBriefs) return;
    let mounted = true;
    api.aiArtifacts.list(activeDeck.id, {
      kind: 'review-brief',
      subjectType: 'suggestion',
      subjectId: selectedSuggestion.id
    }).then(({ artifacts }) => {
      if (!mounted) return;
      setSuggestionBriefs((prev) => ({
        ...prev,
        [selectedSuggestion.id]: artifacts.find((item) => item.status === 'active') || artifacts[0] || null
      }));
    }).catch(() => {
      if (mounted) setSuggestionBriefs((prev) => ({ ...prev, [selectedSuggestion.id]: null }));
    });
    return () => {
      mounted = false;
    };
  }, [activeDeck?.id, activeDeck?.aiSettings?.reviewBriefs, selectedSuggestion?.id]);

  useEffect(() => {
    if (!activeDeck?.id || !selectedCard?.id || !activeDeck.aiSettings?.embeddings) {
      setDuplicateLinks([]);
      return;
    }
    let mounted = true;
    setDuplicateBusy(true);
    api.aiCardEmbeddings.related(activeDeck.id, selectedCard.id, { limit: 8, minScore: 0.78 })
      .then((result) => {
        if (mounted) setDuplicateLinks(result.links || []);
      })
      .catch(() => {
        if (mounted) setDuplicateLinks([]);
      })
      .finally(() => {
        if (mounted) setDuplicateBusy(false);
      });
    return () => {
      mounted = false;
    };
  }, [activeDeck?.id, activeDeck?.aiSettings?.embeddings, selectedCard?.id]);

  async function refreshWith<T extends AppState | unknown>(task: Promise<T>, success: string, map?: (value: T) => AppState) {
    setBusy(true);
    try {
      const result = await task;
      if (map) applyAuthoritativeState(map(result));
      else if (result && typeof result === 'object' && 'decks' in result) applyAuthoritativeState(result as unknown as AppState);
      pushToast(success, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Something went wrong', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refreshState() {
    const next = state?.activeDeckId ? await api.deck(state.activeDeckId) : await api.state();
    applyHydratedDeckState(next);
    return next;
  }

  function uploadDeck(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    refreshWith(api.uploadDeck(file), `Imported ${file.name}`);
    event.target.value = '';
  }

  async function importSuggestionSpreadsheet(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !activeDeck) return;
    setBusy(true);
    try {
      const content = await file.text();
      const result = await api.importSuggestionSpreadsheet(activeDeck.id, file.name, content);
      applyAuthoritativeState(result.state);
      const suffix = result.truncated ? ' First 200 changed rows were imported.' : '';
      pushToast(`Imported ${result.imported} suggestion${result.imported === 1 ? '' : 's'}.${suffix}`, 'success');
      setReviewStatusFilter('pending');
      setReviewAuthorFilter('All');
      setReviewRiskFilter('all');
      setActiveTab('review');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Import failed', 'error');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true);
    setAuthNotice('');
    try {
      const credentials = { email: authEmail, password: authPassword };
      const { error } = await withAuthTimeout(
        authMode === 'sign-in'
          ? supabase.auth.signInWithPassword(credentials)
          : supabase.auth.signUp({ ...credentials, options: { data: { name: authEmail } } })
      );
      if (error) {
        setAuthNotice(authMessage(error, authMode));
      } else if (authMode === 'sign-up') {
        setAuthNotice('Account created. DeckBridge will sign you in automatically.');
      }
    } catch (error) {
      setAuthNotice(authMessage(error, authMode));
    } finally {
      setAuthBusy(false);
    }
  }

  function switchDeck(deckId: string) {
    setSelectedSuggestionId(null);
    setSelectedCardId(null);
    setSelectedSuggestionIds(new Set());
    retainConflictReviewSnapshot.current = false;
    setConflictReviewSnapshot([]);
    setDeckLoading(true);
    api.deck(deckId)
      .then((next) => {
        applyHydratedDeckState(next);
        const nextActiveDeck = next.decks.find((deck) => deck.id === next.activeDeckId);
        setSelectedCardId(nextActiveDeck?.cards[0]?.id || null);
        pushToast('Deck switched', 'success');
      })
      .catch((error) => {
        pushToast(error instanceof Error ? error.message : 'Deck switch failed', 'error');
      })
      .finally(() => setDeckLoading(false));
  }

  async function removeActiveDeckFromDeckBridge(deckId: string, deckName: string) {
    setBusy(true);
    try {
      const result = await api.removeDeck(deckId);
      setSelectedSuggestionId(null);
      setSelectedCardId(null);
      setSelectedSuggestionIds(new Set());
      setSelectedCardIds(new Set());
      retainConflictReviewSnapshot.current = false;
      setConflictReviewSnapshot([]);
      setActiveTab('overview');
      applyAuthoritativeState(result.state);
      pushToast(`Removed ${deckName} from DeckBridge. Your Anki deck was not changed.`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to remove deck', 'error');
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function switchRole(role: AppState['role']) {
    if (!isDevDemo) return;
    refreshWith(api.session({ role }), ['owner', 'editor', 'reviewer'].includes(role) ? 'Review controls updated' : 'Contributor suggestion mode enabled');
  }

  function toggleCardSelection(cardId: string) {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      next.has(cardId) ? next.delete(cardId) : next.add(cardId);
      return next;
    });
  }

  function handleBulkTagAdd(tag: string) {
    if (!tag.trim() || !activeDeck || !state) return;
    const trimmed = tag.trim();
    const cards = activeDeck.cards.filter((c) => selectedCardIds.has(c.id));
    const tasks = cards.flatMap((c) =>
      !c.tags.includes(trimmed) ? [api.createSuggestion({
        deckId: activeDeck.id,
        cardId: c.id,
        authorId: state.user?.id || 'you',
        reason: `Bulk: add tag "${trimmed}"`,
        proposedFields: c.fields,
        proposedTags: [...c.tags, trimmed],
      })] : []
    );
    if (tasks.length === 0) { setBulkAction(null); setBulkTagInput(''); return; }
    refreshWith(
      Promise.all(tasks).then(() => api.deck(activeDeck.id)),
      `Tag "${trimmed}" suggested for ${tasks.length} card(s)`
    );
    setBulkAction(null);
    setBulkTagInput('');
    setSelectedCardIds(new Set());
  }

  function handleBulkTagRemove(tag: string) {
    if (!tag.trim() || !activeDeck || !state) return;
    const trimmed = tag.trim();
    const cards = activeDeck.cards.filter((c) => selectedCardIds.has(c.id));
    const tasks = cards.flatMap((c) =>
      c.tags.includes(trimmed) ? [api.createSuggestion({
        deckId: activeDeck.id,
        cardId: c.id,
        authorId: state.user?.id || 'you',
        reason: `Bulk: remove tag "${trimmed}"`,
        proposedFields: c.fields,
        proposedTags: c.tags.filter((t) => t !== trimmed),
      })] : []
    );
    if (tasks.length === 0) { setBulkAction(null); setBulkTagInput(''); return; }
    refreshWith(
      Promise.all(tasks).then(() => api.deck(activeDeck.id)),
      `Tag removal suggested for ${tasks.length} card(s)`
    );
    setBulkAction(null);
    setBulkTagInput('');
    setSelectedCardIds(new Set());
  }

  function handleBulkDelete() {
    if (!activeDeck || selectedCardIds.size === 0) return;
    const ids = [...selectedCardIds];
    refreshWith(
      api.bulkDeleteCards(activeDeck.id, ids).then(() => api.deck(activeDeck.id)),
      `${ids.length} card(s) deleted`
    );
    setBulkAction(null);
    setSelectedCardIds(new Set());
  }

  function handleSyncAction(action: SyncHealth['primaryAction']) {
    if (action === 'check') {
      refreshWith(api.ankiStatus().then(() => api.state()), 'Sync status refreshed');
      return;
    }
    if (action === 'conflicts') {
      setActiveTab('overview');
      return;
    }
    setShowConnectWizard(true);
  }

  function handleOwnerAttentionAction(item: OwnerAttentionItem) {
    const action = item.action;
    if (action === 'setup') {
      setShowConnectWizard(true);
      return;
    }
    if (action === 'suggestions') {
      setReviewStatusFilter(item.subjectId ? 'all' : 'pending');
      setReviewAuthorFilter('All');
      setReviewRiskFilter('all');
      if (item.subjectId) {
        setSelectedSuggestionId(item.subjectId);
        setSelectedOwnerQueueItemId(`suggestion:${item.subjectId}`);
      }
      setActiveTab('review');
      setReviewTab('changes');
      return;
    }
    if (action === 'conflicts') {
      setReviewRiskFilter('conflict');
      setReviewStatusFilter('pending');
      setActiveTab('review');
      return;
    }
    if (action === 'cards') {
      if (item.subjectId) {
        const targetIndex = activeDeck?.cards.findIndex((card) => card.id === item.subjectId) ?? -1;
        const targetPage = targetIndex >= 0 ? Math.floor(targetIndex / pageSize) + 1 : 1;
        setQueryInput('');
        setTagFilter('All');
        setCardStateFilter('All');
        setPage(targetPage);
        setSelectedSuggestionId(null);
        setSelectedOwnerQueueItemId(null);
        setSelectedCardId(item.subjectId);
        window.setTimeout(() => setPage(targetPage), 260);
      }
      setActiveTab('cards');
      return;
    }
    if (action === 'settings') {
      setActiveTab('settings');
      return;
    }
    setActiveTab('study');
  }

  function createSuggestion() {
    if (!activeDeck || !selectedCard || !state || !canSuggest) return;
    const author = state.collaborators.find((item) => item.role !== 'owner') || state.collaborators[0];
    const front = fieldValue(selectedCard, 'Front');
    const back = fieldValue(selectedCard, 'Back');
    refreshWith(api.createSuggestion({
      deckId: activeDeck.id,
      cardId: selectedCard.id,
      authorId: author.id,
      reason: draftReason,
      proposedFields: {
        ...selectedCard.fields,
        Front: front.includes('[suggested]') ? front : `${front} [suggested]`,
        Back: back.includes('Reviewed:') ? back : `Reviewed: ${back}`
      },
      proposedTags: Array.from(new Set([...selectedCard.tags, 'Needs-owner-review']))
    }), 'Suggestion added to owner review queue');
  }

  function selectOwnerQueueItem(item: OwnerReviewQueueItem) {
    setSelectedOwnerQueueItemId(item.id);
    if (item.suggestionId) setSelectedSuggestionId(item.suggestionId);
    else setSelectedSuggestionId(null);

    if (item.cardId) {
      setSelectedCardId(item.cardId);
      setQueryInput('');
      setTagFilter('All');
      setCardStateFilter('All');
      const targetIndex = activeDeck?.cards.findIndex((card) => card.id === item.cardId) ?? -1;
      if (targetIndex >= 0) setPage(Math.floor(targetIndex / pageSize) + 1);
    }

    if (item.kind === 'conflict') {
      setReviewRiskFilter('conflict');
      setActiveTab('review');
    } else if (item.kind === 'ai' && item.conflictId) {
      setReviewRiskFilter('conflict');
      setActiveTab('review');
    } else if (item.cardId) {
      setActiveTab('review');
    }
    setReviewTab('changes');
  }

  function decideSuggestion(decision: 'accepted' | 'rejected' | 'revision') {
    if (!selectedSuggestion) return;
    refreshWith(api.decideSuggestion(selectedSuggestion.id, decision), `Suggestion ${decision}`);
  }

  function resolveSelectedConflict(resolution: 'local' | 'incoming' | 'skip') {
    if (!selectedConflict) return;
    retainConflictReviewSnapshot.current = true;
    const decisionConflicts = conflictReviewSnapshot.some((conflict) => conflict.id === selectedConflict.id)
      ? conflictReviewSnapshot
      : activeSyncConflicts;
    saveConflictDecision(decisionConflicts, selectedConflict, resolution);
    setState(prev => prev ? {
      ...prev,
      sync: {
        ...prev.sync,
        conflicts: prev.sync.conflicts.filter(c => c.id !== selectedConflict.id)
      }
    } : prev);
    pushToast(resolution === 'local' ? 'Kept local Anki version' : resolution === 'incoming' ? 'Applied DeckBridge version' : 'Skipped conflict for now', 'info');
  }

  async function generateSuggestionBrief() {
    if (!activeDeck || !selectedSuggestion) return;
    setBriefBusy(true);
    try {
      const result = await api.aiSuggestionBriefs.generate(activeDeck.id, selectedSuggestion.id);
      if (result.artifact) {
        setSuggestionBriefs((prev) => ({ ...prev, [selectedSuggestion.id]: result.artifact }));
        pushToast('AI review brief generated', 'success');
      } else {
        pushToast(result.message || 'AI review brief is unavailable', result.status === 'disabled' ? 'info' : 'error');
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'AI review brief failed', 'error');
    } finally {
      setBriefBusy(false);
    }
  }

  async function updateSuggestionBriefStatus(artifactId: string, action: 'useful' | 'dismiss') {
    if (!activeDeck || !selectedSuggestion) return;
    setBriefBusy(true);
    try {
      const { artifact } = action === 'useful'
        ? await api.aiSuggestionBriefs.markUseful(activeDeck.id, artifactId)
        : await api.aiSuggestionBriefs.dismiss(activeDeck.id, artifactId);
      setSuggestionBriefs((prev) => ({ ...prev, [selectedSuggestion.id]: artifact }));
      pushToast(action === 'useful' ? 'Brief marked useful' : 'Brief dismissed', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to update brief', 'error');
    } finally {
      setBriefBusy(false);
    }
  }

  async function dismissOwnerArtifact(artifactId: string) {
    if (!activeDeck) return;
    try {
      await api.aiArtifacts.dismiss(activeDeck.id, artifactId);
      await refreshQualityPulse();
      pushToast('Owner artifact dismissed', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to dismiss artifact', 'error');
    }
  }

  async function indexSelectedCardEmbedding() {
    if (!activeDeck || !selectedCard) return;
    setEmbeddingBusy(true);
    try {
      const result = await api.aiCardEmbeddings.embed(activeDeck.id, selectedCard.id, { limit: 8, minScore: 0.78 });
      if (result.status === 'indexed') {
        setDuplicateLinks(result.links || []);
        pushToast(result.links.length ? `Found ${result.links.length} related card(s)` : 'Card indexed for duplicate search', 'success');
      } else {
        pushToast(result.message || 'AI duplicate indexing is unavailable', result.status === 'disabled' ? 'info' : 'error');
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to index card', 'error');
    } finally {
      setEmbeddingBusy(false);
    }
  }

  async function indexVisibleCardEmbeddings() {
    if (!activeDeck) return;
    setEmbeddingBusy(true);
    try {
      const result = await api.aiCardEmbeddings.embedBatch(activeDeck.id, {
        cardIds: filteredCards.slice(0, 25).map((card) => card.id),
        limit: 25,
        minScore: 0.78
      });
      pushToast(result.status === 'disabled' ? 'AI duplicate indexing is disabled' : `Indexed ${result.indexed || 0} card(s)`, result.status === 'disabled' ? 'info' : 'success');
      if (selectedCard) {
        const related = await api.aiCardEmbeddings.related(activeDeck.id, selectedCard.id, { limit: 8, minScore: 0.78 });
        setDuplicateLinks(related.links || []);
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to index visible cards', 'error');
    } finally {
      setEmbeddingBusy(false);
    }
  }

  function toggleSuggestionSelection(suggestionId: string) {
    setSelectedSuggestionIds((prev) => {
      const next = new Set(prev);
      next.has(suggestionId) ? next.delete(suggestionId) : next.add(suggestionId);
      return next;
    });
  }

  function clearSuggestionSelection() {
    setSelectedSuggestionIds(new Set());
  }

  function bulkDecideSuggestions(decision: 'accepted' | 'rejected' | 'revision') {
    if (!activeDeck || selectedSuggestionIds.size === 0) return;
    const ids = [...selectedSuggestionIds];
    refreshWith(
      api.bulkDecideSuggestions(activeDeck.id, ids, decision),
      `${ids.length} suggestion(s) ${decision}`
    );
    clearSuggestionSelection();
  }

  async function exportDeck() {
    if (!activeDeck) return;
    setBusy(true);
    try {
      const { blob, filename } = await api.exportDeck(activeDeck.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      const next = await api.state();
      applyAuthoritativeState(next);
      pushToast(`Exported ${filename}`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (supabase && authReady && !session) {
    return (
      <AuthScreen
        authMode={authMode}
        authEmail={authEmail}
        authPassword={authPassword}
        authBusy={authBusy}
        authNotice={authNotice}
        onSubmit={submitAuth}
        onEmailChange={setAuthEmail}
        onPasswordChange={setAuthPassword}
        onToggleMode={() => setAuthMode(authMode === 'sign-in' ? 'sign-up' : 'sign-in')}
      />
    );
  }

  if (!state) {
    return (
      <div className="loading">
        <div className="loading-spinner" aria-hidden="true" />
        <strong>Loading DeckBridge…</strong>
        {apiHealth === 'down' ? <span>API bridge is unavailable. Start it with npm run dev:server.</span> : null}
      </div>
    );
  }

  if (!activeDeck) {
    return (
      <div className="empty-workspace">
        <div className="brand-row">
          <div className="brand-mark"><Icon name="cards" /></div>
          <span>DeckBridge</span>
        </div>
        <section className="empty-import">
          <Icon name="upload" />
          <h1>Import your first Anki deck</h1>
          <p>Upload an <code>.apkg</code> file to create a collaborative workspace. Invite teammates, review suggestions, and export approved changes back to Anki.</p>
          <label className="button primary">
            <Icon name="upload" />
            Import .apkg
            <input className="file-input-hidden" type="file" accept=".apkg" onChange={uploadDeck} />
          </label>
        </section>
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><Icon name="cards" /></div>
          <span>DeckBridge</span>
        </div>

        <nav className="sidebar-nav">
          <button className={`nav-item ${topView === 'workspace' ? 'active' : ''}`} onClick={() => setTopView('workspace')}>
            <Icon name="cards" /> Workspace
          </button>
          <button className={`nav-item ${topView === 'discover' ? 'active' : ''}`} onClick={() => setTopView('discover')}>
            <Icon name="search" /> Discover
          </button>
          <button className={`nav-item ${topView === 'templates' ? 'active' : ''}`} onClick={() => setTopView('templates')}>
            <Icon name="spark" /> Templates
          </button>
        </nav>

        <section className="side-section">
          <div className="section-heading">
            <span>Decks</span>
            <span className="mini-actions">+ ⌕</span>
          </div>
          <div className="deck-list">
            {state.summaries.map((summary) => (
              <button
                className={`deck-item ${summary.id === activeDeck.id ? 'active' : ''}`}
                key={summary.id}
                onClick={() => switchDeck(summary.id)}
              >
                <Icon name="cards" />
                <span>
                  <strong>{summary.name}</strong>
                  <small>{summary.cardCount.toLocaleString()} cards</small>
                </span>
                <span className="people-dot"><Icon name="users" /></span>
              </button>
            ))}
          </div>
        </section>

        <section className="side-section collaborator-section">
          <div className="section-heading">
            <span>Collaborators</span>
            <span>+</span>
          </div>
          {state.collaborators.map((person) => (
            <div className="person-row" key={person.id}>
              <span className={`avatar ${person.role === 'owner' ? 'owner' : ''}`}>{initials(person.name)}</span>
              <span>
                <strong>{person.name}{person.role === 'owner' ? ' (Deck Owner)' : ''}</strong>
                <small>{person.email}</small>
              </span>
              {person.role === 'owner' ? <span className="crown">♛</span> : <span className="accepted-count">{person.accepted}</span>}
            </div>
          ))}
        </section>

        <section className="side-section activity-section">
          <div className="section-heading">Recent activity</div>
          {state.activity.slice(0, 6).map((item) => (
            <div className="activity-row" key={item.id}>
              <span className="activity-icon"><Icon name={item.kind === 'export' ? 'download' : item.kind === 'sync' ? 'sync' : 'spark'} /></span>
              <span>{item.text}</span>
              <small>{relativeTime(item.at)}</small>
            </div>
          ))}
        </section>

        <button
          className="dark-toggle"
          onClick={() => setDarkMode((d) => !d)}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <Icon name={darkMode ? 'sun' : 'moon'} />
          {darkMode ? 'Light mode' : 'Dark mode'}
        </button>
      </aside>

      {topView === 'discover' && (
        <section className="workspace">
          <DiscoverView
            onFork={(deckId, name) => {
              setTopView('workspace');
              pushToast(`Forked "${name}" into your workspace`, 'success');
              api.state().then(applyAuthoritativeState).catch(() => undefined);
            }}
          />
        </section>
      )}

      {topView === 'templates' && (
        <section className="workspace">
          <TemplateGallery
            onUse={(deckId, name) => {
              setTopView('workspace');
              pushToast(`Created "${name}" from template`, 'success');
              api.state().then(applyAuthoritativeState).catch(() => undefined);
            }}
          />
        </section>
      )}

      {topView === 'workspace' && <section className="workspace">
        <header className="topbar">
          <div className="topbar-actions">
            <label className="button secondary">
              <Icon name="upload" />
              Upload .apkg
              <input id="deck-upload" type="file" name="deck-upload" aria-label="Upload Anki deck package" accept=".apkg" onChange={uploadDeck} hidden />
            </label>
            <button className="button secondary" onClick={() => activeDeck && refreshWith(api.ankiPull(activeDeck.id), 'Pulled current Anki deck')}>
              <Icon name="sync" />
              Import from Anki
            </button>
            <button className="button primary" onClick={() => setShowConnectWizard(true)}>
              <Icon name="sync" />
              Connect Anki
            </button>
          </div>

          <SyncHealthStrip health={syncHealth} onAction={handleSyncAction} />

          <div className="right-actions">
            {isDevDemo ? (
              <div className="role-toggle" aria-label="Role selector">
                <button className={membershipRole === 'owner' ? 'selected' : ''} onClick={() => switchRole('owner')}>Owner</button>
                <button className={membershipRole === 'editor' ? 'selected' : ''} onClick={() => switchRole('editor')}>Editor</button>
                <button className={membershipRole === 'reviewer' ? 'selected' : ''} onClick={() => switchRole('reviewer')}>Reviewer</button>
                <button className={membershipRole === 'contributor' ? 'selected' : ''} onClick={() => switchRole('contributor')}>Contributor</button>
              </div>
            ) : null}
            <NotificationsBell />
            <div className="export-dropdown">
              <button className="button primary" onClick={exportDeck} disabled={busy}>
                <Icon name="download" /> Export/Download
              </button>
              <div className="export-menu">
                <button onClick={exportDeck} disabled={busy}>.apkg (Anki)</button>
                <button onClick={async () => {
                  if (!activeDeck) return;
                  try {
                    setBusy(true);
                    const { blob, filename } = await api.exportDeckCsv(activeDeck.id);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(url);
                    pushToast(`Exported ${filename}`, 'success');
                  } catch (e) { pushToast(e instanceof Error ? e.message : 'Export failed', 'error'); }
                  finally { setBusy(false); }
                }} disabled={busy}>.csv (Spreadsheet)</button>
                <button onClick={() => suggestionImportRef.current?.click()} disabled={busy || !canSuggest}>Upload spreadsheet changes</button>
                <button onClick={async () => {
                  if (!activeDeck) return;
                  try {
                    setBusy(true);
                    const { blob, filename } = await api.exportActivityCsv(activeDeck.id);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(url);
                    pushToast(`Exported ${filename}`, 'success');
                  } catch (e) { pushToast(e instanceof Error ? e.message : 'Export failed', 'error'); }
                  finally { setBusy(false); }
                }} disabled={busy}>Activity Log (.csv)</button>
              </div>
            </div>
            <input
              ref={suggestionImportRef}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              onChange={importSuggestionSpreadsheet}
              hidden
            />
          </div>
        </header>

        <WorkbenchLayout railKind={activeRail} rail={contextRail}>
            <div className="breadcrumb">Decks <span>/</span> {activeDeck.name}</div>
            <div className="tabs">
              <button ref={overviewTabRef} className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
              <button className={activeTab === 'review' ? 'active' : ''} onClick={() => setActiveTab('review')}>Review</button>
              <button className={activeTab === 'study' ? 'active' : ''} onClick={() => setActiveTab('study')}>Study</button>
              <button className={activeTab === 'cards' ? 'active' : ''} onClick={() => setActiveTab('cards')}>Cards</button>
              {canManageDeck ? <button className={activeTab === 'models' ? 'active' : ''} onClick={() => setActiveTab('models')}>Models</button> : null}
              <button className={activeTab === 'stats' ? 'active' : ''} onClick={() => setActiveTab('stats')}>Stats</button>
              <button className={activeTab === 'analytics' ? 'active' : ''} onClick={() => setActiveTab('analytics')}>Analytics</button>
              <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}>Activity</button>
              <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>Settings</button>
              {pendingSuggestions.length > 0 && (
                <span className="pending-callout" title={`${pendingSuggestions.length} suggestion${pendingSuggestions.length === 1 ? '' : 's'} pending owner review`}>
                  {pendingSuggestions.length} pending
                </span>
              )}
            </div>

            {deckLoading && activeDeck.cards.length === 0 && (activeSummary?.cardCount || 0) > 0 ? (
              <div className="inline-notice">
                Loading {activeSummary?.cardCount.toLocaleString()} cards for {activeDeck.name}. The workspace is ready while card details hydrate.
              </div>
            ) : null}

            {activeTab === 'study' && activeDeck ? (
              <StudyPrepView
                totalCards={activeDeck.cards.length}
                studyCards={studyCards.length}
                approvedCards={approvedStudyCards.length}
                pendingBlocked={cardsWithPendingSuggestions.size}
                approvedOnly={studyApprovedOnly}
                onApprovedOnlyChange={setStudyApprovedOnly}
                onStart={() => setShowStudy(true)}
              />
            ) : null}

            {activeTab === 'stats' && activeDeck ? (
              <DeckStatsView
                deck={activeDeck}
                summary={activeSummary}
                suggestions={suggestionStats}
                filteredCount={filteredCards.length}
              />
            ) : null}

            {activeTab === 'analytics' && activeDeck ? (
              <AnalyticsDashboard
                deckId={activeDeck.id}
                deckName={activeDeck.name}
                isOwner={canManageDeck}
                currentVisibility={activeDeckVisibility}
                onSetVisibility={(v) => setDeckVisibility((prev) => ({ ...prev, [activeDeck.id]: v }))}
              />
            ) : null}

            {activeTab === 'activity' && activeDeck ? (
              <ActivityTimeline
                deckId={activeDeck.id}
                deckName={activeDeck.name}
                activities={state.activity}
                suggestionStats={suggestionStats}
              />
            ) : null}

            {activeTab === 'models' && activeDeck && canManageDeck ? (
              <ModelTemplateEditor
                deck={activeDeck}
                busy={busy}
                onSave={(modelName, payload) => refreshWith(api.updateModelTemplate(activeDeck.id, modelName, payload), `${modelName} template updated`)}
              />
            ) : null}

            {activeTab === 'settings' && activeDeck ? (
              <DeckSettingsView
                deck={activeDeck}
                visibility={activeDeckVisibility}
                canReview={canManageDeck}
                embedCode={deckEmbedCode}
                copiedShare={copiedShare}
                onCopied={setCopiedShare}
                onSetVisibility={(v) => {
                  refreshWith(api.setVisibility(activeDeck.id, v), `Deck visibility set to ${v}`, () => {
                    setDeckVisibility((prev) => ({ ...prev, [activeDeck.id]: v }));
                    return state;
                  });
                }}
                onRemoveDeck={() => removeActiveDeckFromDeckBridge(activeDeck.id, activeDeck.name)}
              />
            ) : null}

            {activeTab === 'review' && activeDeck ? (
              <ReviewWorkspace
                deck={activeDeck}
                items={queueItems}
                selectedItem={selectedOwnerQueueItem}
                selectedCard={selectedCard}
                selectedSuggestion={selectedSuggestion}
                selectedConflict={selectedConflict}
                suggestions={suggestions}
                bucketCounts={reviewBucketCounts}
                activeBucket={reviewRiskFilter}
                onBucketChange={(bucket) => {
                  setReviewRiskFilter(bucket);
                  setSelectedOwnerQueueItemId(null);
                }}
                statusFilter={reviewStatusFilter}
                onStatusFilterChange={(status) => {
                  setReviewStatusFilter(status);
                  setSelectedOwnerQueueItemId(null);
                }}
                authorFilter={reviewAuthorFilter}
                onAuthorFilterChange={(author) => {
                  setReviewAuthorFilter(author);
                  setSelectedOwnerQueueItemId(null);
                }}
                authors={reviewAuthors}
                canReview={canReview}
                canManageDeck={canManageDeck}
                busy={busy}
                selectedSuggestionIds={selectedSuggestionIds}
                onToggleSuggestion={toggleSuggestionSelection}
                onSelectItem={selectOwnerQueueItem}
                onResetFilters={() => {
                  setReviewRiskFilter('all');
                  setReviewStatusFilter('pending');
                  setReviewAuthorFilter('All');
                  setSelectedOwnerQueueItemId(null);
                }}
                onBulkDecision={bulkDecideSuggestions}
                onClearSelection={clearSuggestionSelection}
                reviewTab={reviewTab}
                setReviewTab={setReviewTab}
                currentUserId={state.user?.id || 'you'}
                currentUserName={state.user?.name || 'You'}
                commentsVersion={commentsVersion}
                brief={selectedSuggestionBrief}
                briefBusy={briefBusy}
                draftReason={draftReason}
                setDraftReason={setDraftReason}
                onGenerateBrief={generateSuggestionBrief}
                onMarkBriefUseful={(artifactId) => updateSuggestionBriefStatus(artifactId, 'useful')}
                onDismissBrief={(artifactId) => updateSuggestionBriefStatus(artifactId, 'dismiss')}
                onDecideSuggestion={decideSuggestion}
                onResolveConflict={resolveSelectedConflict}
                sourceCheckByReviewItem={sourceCheckByReviewItem}
                onMarkNeedsSourceCheck={(itemId) => {
                  setSourceCheckByReviewItem((prev) => ({ ...prev, [itemId]: 'needs' }));
                  pushToast('Marked needs source check for this review session', 'info');
                }}
                onMarkSourceChecked={(itemId) => {
                  setSourceCheckByReviewItem((prev) => ({ ...prev, [itemId]: 'checked' }));
                  pushToast('Marked source checked for this review session', 'success');
                }}
                onCreateSuggestion={createSuggestion}
                onPushToAnki={() => refreshWith(api.ankiPush(activeDeck.id), 'Pushed accepted note updates', (value) => value.state)}
                hasConflicts={state.sync.conflicts.length > 0}
                canSuggest={canSuggest}
              />
            ) : null}

            {conflictReviewSnapshot.length ? (
              <ConflictResolution
                conflicts={conflictReviewSnapshot}
                pendingConflictIds={pendingConflictIds}
                onResolve={(conflictId, resolution) => {
                  retainConflictReviewSnapshot.current = true;
                  setState(prev => prev ? {
                    ...prev,
                    sync: {
                      ...prev.sync,
                      conflicts: prev.sync.conflicts.filter(c => c.id !== conflictId)
                    }
                  } : prev);
                  if (resolution !== 'skip') {
                    pushToast(resolution === 'local' ? 'Kept local version' : 'Applied incoming changes', 'info');
                  }
                }}
                onClearReview={() => setConflictReviewSnapshot([])}
              />
            ) : null}

            {(activeTab === 'overview' || activeTab === 'cards') ? (<>
            <div className="summary-band">
              <div>
                <small>Deck description</small>
                <strong>{activeDeck.description}</strong>
              </div>
              <div><small>Cards</small><strong>{activeSummary?.cardCount.toLocaleString()}</strong></div>
              <div><small>Notes</small><strong>{activeSummary?.noteCount.toLocaleString()}</strong></div>
              <div><small>Tags</small><strong>{activeSummary?.tagCount.toLocaleString()}</strong></div>
              <div><small>Last synced</small><strong>{relativeTime(activeDeck.lastSyncedAt)}</strong></div>
            </div>

            <div className="table-panel">
              <div className="table-tools">
                <label className="sr-only" htmlFor="card-search">Search cards</label>
                <label className="search-box">
                  <Icon name="search" />
                  <input id="card-search" name="card-search" aria-label="Search cards" placeholder="Search cards..." value={queryInput} onChange={(event) => setQueryInput(event.target.value)} />
                </label>
                <label className="sr-only" htmlFor="tag-filter">Filter by tag</label>
                <select id="tag-filter" name="tag-filter" aria-label="Filter by tag" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
                  {allTags.map((tag) => <option key={tag}>{tag}</option>)}
                </select>
                <label className="sr-only" htmlFor="card-state-filter">Filter by card state</label>
                <select id="card-state-filter" name="card-state-filter" aria-label="Filter by card state" value={cardStateFilter} onChange={(event) => setCardStateFilter(event.target.value)}>
                  {cardStates.map((item) => <option key={item}>{item}</option>)}
                </select>
                <button
                  className="button secondary"
                  onClick={() => {
                    setQueryInput('');
                    setTagFilter('All');
                    setCardStateFilter('All');
                  }}
                  disabled={!queryInput && tagFilter === 'All' && cardStateFilter === 'All'}
                >
                  <Icon name="filter" /> Clear filters
                </button>
                {canManageDeck && activeDeck.aiSettings?.embeddings ? (
                  <button className="button secondary" onClick={indexVisibleCardEmbeddings} disabled={embeddingBusy || !filteredCards.length}>
                    <Icon name="spark" /> Index visible
                  </button>
                ) : null}
              </div>

              {selectedCardIds.size > 0 && (
                <div className="bulk-toolbar">
                  <span className="bulk-count">{selectedCardIds.size} selected</span>
                  {bulkAction === 'tag-add' && (
                    <span className="bulk-tag-form">
                      <input
                        className="bulk-tag-input"
                        placeholder="Tag name…"
                        value={bulkTagInput}
                        onChange={(e) => setBulkTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleBulkTagAdd(bulkTagInput); if (e.key === 'Escape') setBulkAction(null); }}
                      />
                      <button className="button primary" onClick={() => handleBulkTagAdd(bulkTagInput)}>Apply</button>
                      <button className="button secondary" onClick={() => { setBulkAction(null); setBulkTagInput(''); }}>Cancel</button>
                    </span>
                  )}
                  {bulkAction === 'tag-remove' && (
                    <span className="bulk-tag-form">
                      <input
                        className="bulk-tag-input"
                        placeholder="Tag to remove…"
                        value={bulkTagInput}
                        onChange={(e) => setBulkTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleBulkTagRemove(bulkTagInput); if (e.key === 'Escape') setBulkAction(null); }}
                      />
                      <button className="button primary" onClick={() => handleBulkTagRemove(bulkTagInput)}>Apply</button>
                      <button className="button secondary" onClick={() => { setBulkAction(null); setBulkTagInput(''); }}>Cancel</button>
                    </span>
                  )}
                  {bulkAction === 'delete' && (
                    <span className="bulk-confirm">
                      <span>Delete {selectedCardIds.size} card(s)? This cannot be undone.</span>
                      <button className="button danger" onClick={handleBulkDelete}>Confirm delete</button>
                      <button className="button secondary" onClick={() => setBulkAction(null)}>Cancel</button>
                    </span>
                  )}
                  {bulkAction === null && canSuggest && (
                    <>
                      <button className="button secondary" onClick={() => setBulkAction('tag-add')}>+ Add tag</button>
                      <button className="button secondary" onClick={() => setBulkAction('tag-remove')}>- Remove tag</button>
                      {canManageDeck && <button className="button danger-outline" onClick={() => setBulkAction('delete')}>Delete</button>}
                    </>
                  )}
                  <button className="button secondary" onClick={() => { setSelectedCardIds(new Set()); setBulkAction(null); }}>Clear selection</button>
                </div>
              )}

              <div className="card-table" role="table">
                <div className="table-header" role="row">
                  <span role="columnheader">
                    <input
                      type="checkbox"
                      aria-label="Select all on page"
                      checked={pagedCards.length > 0 && pagedCards.every((c) => selectedCardIds.has(c.id))}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedCardIds((prev) => { const next = new Set(prev); pagedCards.forEach((c) => next.add(c.id)); return next; });
                        } else {
                          setSelectedCardIds((prev) => { const next = new Set(prev); pagedCards.forEach((c) => next.delete(c.id)); return next; });
                        }
                      }}
                    />
                  </span>
                  <span role="columnheader">Card</span>
                  <span role="columnheader">Note Type</span>
                  <span role="columnheader">Tags</span>
                  <span role="columnheader">Due</span>
                  <span role="columnheader">State</span>
                  <span role="columnheader">Last Modified</span>
                </div>
                {pagedCards.length ? pagedCards.map((card) => (
                  editingCardId === card.id ? (
                    <div key={card.id} className="table-row editing" role="row">
                      <div role="cell" className="table-editor-cell">
                      <CardEditor
                        card={card}
                        canSuggest={canSuggest}
                        busy={busy}
                        onSubmit={(proposedFields, proposedTags, reason) => {
                          setEditingCardId(null);
                          refreshWith(api.createSuggestion({
                            deckId: activeDeck.id,
                            cardId: card.id,
                            authorId: state.user?.id || 'you',
                            reason,
                            proposedFields,
                            proposedTags,
                          }), 'Suggestion submitted for review');
                        }}
                        onCancel={() => setEditingCardId(null)}
                      />
                      </div>
                    </div>
                  ) : (
                  <div
                    className={`table-row ${card.id === highlightedCard?.id ? 'selected' : ''} ${selectedCardIds.has(card.id) ? 'checked' : ''}`}
                    key={card.id}
                    onClick={(e) => {
                      if (selectedCardIds.size > 0 || e.shiftKey) {
                        toggleCardSelection(card.id);
                        return;
                      }
                      setSelectedCardId(card.id);
                      const linked = suggestions.find((item) => item.cardId === card.id && item.status === 'pending');
                      if (linked) {
                        setSelectedSuggestionId(linked.id);
                        setSelectedOwnerQueueItemId(`suggestion:${linked.id}`);
                      } else {
                        setSelectedOwnerQueueItemId(null);
                      }
                    }}
                    onDoubleClick={() => canSuggest && selectedCardIds.size === 0 && setEditingCardId(card.id)}
                    title={canSuggest ? 'Double-click to edit / Shift-click to select' : 'Shift-click to select'}
                    role="row"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCardSelection(card.id); } }}
                  >
                    <span role="cell">
                      <span
                        className={`checkbox${selectedCardIds.has(card.id) ? ' checked' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleCardSelection(card.id); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); toggleCardSelection(card.id); } }}
                        aria-label={selectedCardIds.has(card.id) ? 'Deselect card' : 'Select card'}
                        role="checkbox"
                        aria-checked={selectedCardIds.has(card.id)}
                        tabIndex={-1}
                      />
                    </span>
                    <span role="cell" className="card-front">
                      {fieldValue(card, 'Front') || Object.values(card.fields)[0]}
                      {duplicateCountsByCard.get(card.id) ? <em title="AI duplicate or related-card candidate"> Related {duplicateCountsByCard.get(card.id)}</em> : null}
                    </span>
                    <span role="cell">{card.type}</span>
                    <span role="cell" className="tag-list">{card.tags.slice(0, 2).map((tag) => <em key={tag}>{tag}</em>)}</span>
                    <span role="cell">{card.due ?? '-'}</span>
                    <span role="cell"><b className={`state-chip ${statusColors[card.state] || 'neutral'}`}>{card.state}</b></span>
                    <span role="cell"><small>{relativeTime(card.modifiedAt)}<br />{card.modifiedBy}</small></span>
                  </div>
                  )
                )) : <EmptyState message="No cards match the current filters." />}
              </div>

              <div className="pagination-row">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  Rows
                  <select
                    className="page-size-select"
                    value={pageSize}
                    onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                    aria-label="Rows per page"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <span>{currentStart}-{currentEnd} of {filteredCards.length.toLocaleString()}</span>
                <span className="pager">
                  <button aria-label="First page" onClick={() => setPage(1)} disabled={safePage === 1}>«</button>
                  <button aria-label="Previous page" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage === 1}>‹</button>
                  <strong>{safePage} / {maxPage}</strong>
                  <button aria-label="Next page" onClick={() => setPage((value) => Math.min(maxPage, value + 1))} disabled={safePage === maxPage}>›</button>
                  <button aria-label="Last page" onClick={() => setPage(maxPage)} disabled={safePage === maxPage}>»</button>
                </span>
              </div>
            </div>
            </>) : null}
        </WorkbenchLayout>
      </section>}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {busy ? <div className="busy-bar" /> : null}
      {showConnectWizard && (
        <ConnectAnkiWizard
          decks={state.summaries}
          platformUrl={window.location.origin}
          currentState={state}
          onRefreshState={refreshState}
          onClose={() => setShowConnectWizard(false)}
        />
      )}
      {showStudy && activeDeck && (
        <StudyView
          deckId={activeDeck.id}
          cards={studyCards}
          modeLabel={studyApprovedOnly ? 'Approved cards only' : 'All cards'}
          onClose={closeStudyView}
        />
      )}
    </main>
  );
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <span className="toast__icon" aria-hidden="true">{TOAST_ICONS[t.type]}</span>
          <span className="toast__message">{t.message}</span>
          <button className="toast__dismiss" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">✕</button>
        </div>
      ))}
    </div>
  );
}

function DiffBlock({ label, before, after }: { label: string; before?: string; after?: string }) {
  return (
    <div className="diff-block">
      <label>{label}</label>
      <div className="diff-lines">
        <p className="removed">- {before || 'Empty'}</p>
        <p className="added">+ {after || before || 'No suggested change'}</p>
      </div>
    </div>
  );
}

function CardPreviewComparison({ currentCard, proposedCard, deckId, hasSuggestion }: {
  currentCard: DeckCard;
  proposedCard: DeckCard;
  deckId: string;
  hasSuggestion: boolean;
}) {
  const currentFrontHtml = useMemo(
    () => renderCardHtml(currentCard, deckId, 'front'),
    [currentCard, deckId],
  );
  const proposedFrontHtml = useMemo(
    () => renderCardHtml(proposedCard, deckId, 'front'),
    [proposedCard, deckId],
  );
  const currentRenderFallback = hasRenderFallback(currentCard, 'front') || hasRenderFallback(currentCard, 'back');
  const proposedRenderFallback = hasSuggestion && (hasRenderFallback(proposedCard, 'front') || hasRenderFallback(proposedCard, 'back'));
  const renderFallback = currentRenderFallback || proposedRenderFallback;

  const renderFallbackNotice = renderFallback ? (
    <div className="render-unavailable" role="status">
      <strong>Rendered HTML missing</strong>
      <span>
        {currentRenderFallback && proposedRenderFallback
          ? 'Current and proposed previews are field-rendered from card data.'
          : currentRenderFallback
            ? 'Current preview is field-rendered from card data.'
            : 'Proposed preview is field-rendered from card data.'}
        {' '}Use the raw field diff below before accepting.
      </span>
    </div>
  ) : null;

  if (!hasSuggestion) {
    return (
      <>
        {renderFallbackNotice}
        <div className="card-preview-single">
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="back" frontHtml={currentFrontHtml} />
        </div>
      </>
    );
  }

  return (
    <>
      {renderFallbackNotice}
      <div className="card-preview-comparison">
        <div className="card-preview-col">
          <span className="card-preview-label">Current</span>
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={currentCard} deckId={deckId} side="back" frontHtml={currentFrontHtml} />
        </div>
        <div className="card-preview-col">
          <span className="card-preview-label proposed">Proposed</span>
          <span className="card-preview-side-label">Front</span>
          <AnkiCardRenderer card={proposedCard} deckId={deckId} side="front" />
          <span className="card-preview-side-label">Back</span>
          <AnkiCardRenderer card={proposedCard} deckId={deckId} side="back" frontHtml={proposedFrontHtml} />
        </div>
      </div>
    </>
  );
}
