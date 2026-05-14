import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import type { AddonSyncResult, AiQualityPulse, AppState, Deck, DeckCard, DeckMember, DeckSummary, Suggestion } from '../types';
import type { AddonDownloadAvailability, AddonVersion, MeResponse } from '../api';
import { renderCardHtml } from '../AnkiCardRenderer';
import type { QualityReviewItem, ReviewBucket, ReviewRiskLabel } from '../reviewModel';

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

export interface AddonPackageState {
  loading: boolean;
  version: AddonVersion | null;
  availability: AddonDownloadAvailability | null;
  error: string;
}

export type WorkbenchTab = 'overview' | 'review' | 'study' | 'cards' | 'models' | 'stats' | 'analytics' | 'activity' | 'settings';
export type WorkbenchRailKind = 'overview' | 'card' | 'none';

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

export const TOAST_ICONS: Record<Toast['type'], string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
};

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

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
      global: { fetch: supabaseAuthFetch }
    })
  : null;

export const AUTH_REQUEST_TIMEOUT_MS = 20000;

export const DEFAULT_AI_SETTINGS = Object.freeze({
  reviewBriefs: false,
  embeddings: false,
  conflictSummaries: false,
  diagnostics: false,
  qualityPulse: false,
  updatedAt: null,
  updatedBy: null
});

export const statusColors: Record<string, string> = {
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

export function initials(name: string) {
  return name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}

export function relativeTime(value?: string | null) {
  if (!value) return 'Not yet';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function fieldValue(card: DeckCard | undefined, key: string) {
  if (!card) return '';
  return card.fields[key] || card.fields[key.toLowerCase()] || '';
}

export function stripHtml(value: string) {
  if (typeof document !== 'undefined') {
    const element = document.createElement('div');
    element.innerHTML = value;
    return element.textContent || element.innerText || '';
  }
  return value.replace(/<[^>]*>/g, ' ');
}

export function searchableCardText(card: DeckCard, deckId: string) {
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

export function packageLabel(addonPackage: AddonPackageState) {
  if (addonPackage.loading) return 'Checking package';
  if (addonPackage.error) return 'Package check failed';
  if (!addonPackage.availability?.available) return 'Package missing';
  return addonPackage.version?.version ? `Add-on v${addonPackage.version.version}` : 'Add-on ready';
}

export function localDeckLabel(deck: Deck | undefined) {
  const sourceDeck = deck?.source?.deckPath || deck?.source?.deckName;
  if (sourceDeck) return sourceDeck;
  return deck?.cards.find((card) => card.sourceDeckName)?.sourceDeckName || 'Local deck not mapped';
}

export function changedInLastSync(deck: Deck | undefined, result: AddonSyncResult | null | undefined) {
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

export function deriveOwnerAttentionItems({
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
  } catch {
    return '';
  }
}

export function authMessage(error: unknown, mode: 'sign-in' | 'sign-up') {
  const message = authErrorText(error);
  const status = authErrorStatus(error);
  const lower = message.toLowerCase();
  const fingerprint = `${lower} ${status ?? ''}`.trim();
  if (fingerprint.includes('auth service is not configured')) {
    return 'DeckBridge authentication is not configured on this server. Contact the administrator or try again later.';
  }
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

export function emptySyncState(): AppState['sync'] {
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
