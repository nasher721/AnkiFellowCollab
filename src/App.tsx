import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { api, setApiAuthToken, type AddonDownloadAvailability, type AddonVersion } from './api';
import type { AddonSyncResult, AiArtifact, AiDuplicateLink, AiQualityPulse, AppState, Deck, DeckCard, Suggestion } from './types';
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
import { ConflictResolution, type Conflict } from './ConflictResolution';
import { DeckSettingsView } from './views/DeckSettingsView';
import { DeckStatsView } from './views/DeckStatsView';
import { StudyPrepView } from './views/StudyPrepView';
import { AnkiCardRenderer, renderCardHtml } from './AnkiCardRenderer';

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

export interface OwnerReviewQueueItem {
  id: string;
  kind: 'conflict' | 'suggestion' | 'ai' | 'recent-change';
  source: string;
  label: string;
  detail: string;
  status: 'pending' | 'revision' | 'accepted' | 'rejected';
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  risk: 'low' | 'medium' | 'high';
  actionLabel: string;
  affectsNextPull: boolean;
  sortAt: string;
  priority: number;
  cardId?: string;
  suggestionId?: string;
  conflictId?: string;
  artifactId?: string;
  authorName?: string;
}

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
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

const statusColors: Record<string, string> = {
  New: 'blue',
  Learning: 'amber',
  Review: 'green',
  Suspended: 'red',
  Anki: 'neutral'
};

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

function severityRisk(severity: AiQualityPulse['items'][number]['severity']): OwnerReviewQueueItem['risk'] {
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function severityTone(severity: AiQualityPulse['items'][number]['severity']): OwnerReviewQueueItem['tone'] {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  return 'info';
}

function recentSuggestionCutoff(nowMs: number) {
  return nowMs - 7 * 24 * 60 * 60 * 1000;
}

export function deriveOwnerReviewQueue({
  suggestions,
  conflicts,
  pulse,
  now = Date.now()
}: {
  suggestions: Suggestion[];
  conflicts: AppState['sync']['conflicts'];
  pulse: AiQualityPulse | null;
  now?: number;
}): OwnerReviewQueueItem[] {
  const items = new Map<string, OwnerReviewQueueItem>();
  const addItem = (item: OwnerReviewQueueItem) => {
    const existing = items.get(item.id);
    if (!existing || item.priority < existing.priority || (item.priority === existing.priority && item.sortAt > existing.sortAt)) {
      items.set(item.id, item);
    }
  };

  for (const conflict of conflicts) {
    addItem({
      id: `conflict:${conflict.id}`,
      kind: 'conflict',
      source: conflict.source || 'Sync conflict',
      label: 'Sync conflict',
      detail: `Resolve field differences before accepted changes can push back to Anki.`,
      status: 'pending',
      tone: 'danger',
      risk: 'high',
      actionLabel: 'Resolve',
      affectsNextPull: true,
      sortAt: conflict.detectedAt,
      priority: 10,
      cardId: conflict.cardId,
      conflictId: conflict.id
    });
  }

  const recentCutoff = recentSuggestionCutoff(now);
  for (const suggestion of suggestions) {
    const sortAt = suggestion.reviewedAt || suggestion.createdAt;
    if (suggestion.status === 'pending' || suggestion.status === 'revision') {
      addItem({
        id: `suggestion:${suggestion.id}`,
        kind: 'suggestion',
        source: suggestion.authorName,
        label: suggestion.status === 'revision' ? 'Revision requested' : 'Pending suggestion',
        detail: suggestion.reason || 'Review proposed card changes.',
        status: suggestion.status,
        tone: suggestion.status === 'revision' ? 'info' : 'warning',
        risk: 'medium',
        actionLabel: suggestion.status === 'revision' ? 'Review' : 'Decide',
        affectsNextPull: suggestion.status === 'pending',
        sortAt,
        priority: suggestion.status === 'pending' ? 20 : 35,
        cardId: suggestion.cardId,
        suggestionId: suggestion.id,
        authorName: suggestion.authorName
      });
      continue;
    }

    if (new Date(sortAt).getTime() >= recentCutoff) {
      addItem({
        id: `recent:${suggestion.id}`,
        kind: 'recent-change',
        source: suggestion.authorName,
        label: suggestion.status === 'accepted' ? 'Recently accepted' : 'Recently rejected',
        detail: suggestion.reason || 'Recent owner decision.',
        status: suggestion.status,
        tone: suggestion.status === 'accepted' ? 'success' : 'neutral',
        risk: 'low',
        actionLabel: 'Inspect',
        affectsNextPull: suggestion.status === 'accepted',
        sortAt,
        priority: suggestion.status === 'accepted' ? 55 : 60,
        cardId: suggestion.cardId,
        suggestionId: suggestion.id,
        authorName: suggestion.authorName
      });
    }
  }

  if (pulse?.enabled && pulse.status === 'attention') {
    for (const pulseItem of pulse.items) {
      const subjectKey = pulseItem.subjectId || pulseItem.artifactId;
      const duplicateKey = pulseItem.subjectType === 'suggestion'
        ? `suggestion:${pulseItem.subjectId}`
        : pulseItem.subjectType === 'conflict'
          ? `conflict:${pulseItem.subjectId}`
          : '';
      if (duplicateKey && items.has(duplicateKey)) continue;

      const staleQualityFinding = pulseItem.kind === 'quality-issue' && pulseItem.staleness !== 'fresh';
      addItem({
        id: `ai:${pulseItem.artifactId || subjectKey}`,
        kind: 'ai',
        source: pulseItem.kind === 'review-brief' ? 'AI review brief' : staleQualityFinding ? 'Stale quality finding' : 'AI pulse',
        label: pulseItem.label,
        detail: `${pulseItem.severity} risk · ${pulseItem.staleness} · ${pulseItem.detail}`,
        status: 'pending',
        tone: severityTone(pulseItem.severity),
        risk: severityRisk(pulseItem.severity),
        actionLabel: pulseItem.action === 'conflict' ? 'Resolve' : pulseItem.action === 'setup' ? 'Repair' : 'Inspect',
        affectsNextPull: pulseItem.action === 'suggestion' || pulseItem.action === 'conflict' || staleQualityFinding,
        sortAt: pulseItem.createdAt,
        priority: pulseItem.severity === 'high' ? 25 : pulseItem.severity === 'medium' ? 40 : 50,
        cardId: pulseItem.subjectType === 'card' ? pulseItem.subjectId : undefined,
        suggestionId: pulseItem.subjectType === 'suggestion' ? pulseItem.subjectId : undefined,
        conflictId: pulseItem.subjectType === 'conflict' ? pulseItem.subjectId : undefined,
        artifactId: pulseItem.artifactId
      });
    }
  }

  return Array.from(items.values()).sort((left, right) => (
    left.priority - right.priority || new Date(right.sortAt).getTime() - new Date(left.sortAt).getTime() || left.id.localeCompare(right.id)
  ));
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

function authMessage(message: string, mode: 'sign-in' | 'sign-up') {
  const lower = message.toLowerCase();
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
  const [templateFront, setTemplateFront] = useState('');
  const [templateBack, setTemplateBack] = useState('');
  const [modelCss, setModelCss] = useState('');

  useEffect(() => {
    if (!models.includes(selectedModel)) setSelectedModel(models[0] || '');
  }, [models, selectedModel]);

  useEffect(() => {
    setTemplateFront(previewCard?.templateFront || '{{Front}}');
    setTemplateBack(previewCard?.templateBack || '{{FrontSide}}<hr id=answer>{{Back}}');
    setModelCss(previewCard?.modelCss || '');
  }, [previewCard?.id, previewCard?.templateFront, previewCard?.templateBack, previewCard?.modelCss]);

  if (!models.length || !previewCard) {
    return <EmptyState message="This deck has no cards to preview." />;
  }

  const draftCard: DeckCard = {
    ...previewCard,
    templateFront,
    templateBack,
    modelCss,
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
            <textarea value={templateFront} onChange={(event) => setTemplateFront(event.target.value)} rows={8} spellCheck={false} />
          </label>
          <label>
            <span>Back template</span>
            <textarea value={templateBack} onChange={(event) => setTemplateBack(event.target.value)} rows={8} spellCheck={false} />
          </label>
          <label>
            <span>Model CSS</span>
            <textarea value={modelCss} onChange={(event) => setModelCss(event.target.value)} rows={8} spellCheck={false} />
          </label>
          <button className="button primary" disabled={busy} onClick={() => onSave(selectedModel, { templateFront, templateBack, modelCss })}>
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
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [showConnectWizard, setShowConnectWizard] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'tag-add' | 'tag-remove' | 'delete' | null>(null);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'study' | 'cards' | 'models' | 'stats' | 'analytics' | 'activity' | 'settings'>('overview');
  const [showStudy, setShowStudy] = useState(false);
  const [studyApprovedOnly, setStudyApprovedOnly] = useState(true);
  const [reviewTab, setReviewTab] = useState<'changes' | 'discussion'>('changes');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<'pending' | 'accepted' | 'rejected' | 'revision' | 'all'>('pending');
  const [reviewAuthorFilter, setReviewAuthorFilter] = useState('All');
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
    Promise.all([api.state(), api.health()])
      .then(([next]) => {
        applyAuthoritativeState(next);
        setApiHealth('ok');
        const nextActiveDeck = next.decks.find((deck) => deck.id === next.activeDeckId);
        setSelectedCardId(nextActiveDeck?.cards[0]?.id || null);
        setSelectedSuggestionId(next.suggestions.find((item) => item.status === 'pending')?.id || null);
      }).catch((error) => {
        setApiHealth('down');
        pushToast(error.message, 'error');
      });
  }, [authReady, session]);

  useEffect(() => {
    if (supabase && !session) return undefined;
    const timer = window.setInterval(() => {
      api.ankiStatus().then(() => api.state()).then(applyAuthoritativeState).catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [session]);

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

  const handleSuggestionChange = useCallback(() => {
    api.state().then(applyAuthoritativeState).catch(() => undefined);
  }, []);

  const handleCommentChange = useCallback(() => {
    setCommentsVersion((version) => version + 1);
    api.state().then(applyAuthoritativeState).catch(() => undefined);
  }, []);

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
  const suggestions = useMemo(
    () => (state?.suggestions || []).filter((item) => item.deckId === activeDeck?.id),
    [state, activeDeck]
  );
  const pendingSuggestions = useMemo(() => suggestions.filter((item) => item.status === 'pending'), [suggestions]);
  const reviewAuthors = useMemo(() => ['All', ...Array.from(new Set(suggestions.map((item) => item.authorName))).sort()], [suggestions]);
  const ownerReviewQueue = useMemo(() => deriveOwnerReviewQueue({
    suggestions,
    conflicts: activeSyncConflicts,
    pulse: qualityPulse
  }), [activeSyncConflicts, qualityPulse, suggestions]);
  const queueItems = useMemo(() => ownerReviewQueue.filter((item) => {
    const statusMatch = reviewStatusFilter === 'all' || item.status === reviewStatusFilter;
    const authorMatch = reviewAuthorFilter === 'All' || !item.authorName || item.authorName === reviewAuthorFilter;
    return statusMatch && authorMatch;
  }), [ownerReviewQueue, reviewStatusFilter, reviewAuthorFilter]);
  const selectedOwnerQueueItem = queueItems.find((item) => item.id === selectedOwnerQueueItemId) || queueItems[0];
  const selectedSuggestion = suggestions.find((item) => item.id === (selectedOwnerQueueItem?.suggestionId || selectedSuggestionId)) ||
    suggestions.find((item) => item.id === selectedSuggestionId);
  const selectedCard = activeDeck?.cards.find((card) => card.id === (selectedSuggestion?.cardId || selectedOwnerQueueItem?.cardId || selectedCardId)) || activeDeck?.cards[0];
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
    const next = await api.state();
    applyAuthoritativeState(next);
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
    const credentials = { email: authEmail, password: authPassword };
    const { error } = authMode === 'sign-in'
      ? await supabase.auth.signInWithPassword(credentials)
      : await supabase.auth.signUp({ ...credentials, options: { data: { name: authEmail } } });
    if (error) {
      setAuthNotice(authMessage(error.message, authMode));
    } else if (authMode === 'sign-up') {
      setAuthNotice('Account created. DeckBridge will sign you in automatically.');
    }
    setAuthBusy(false);
  }

  function switchDeck(deckId: string) {
    setSelectedSuggestionId(null);
    setSelectedCardId(null);
    setSelectedSuggestionIds(new Set());
    retainConflictReviewSnapshot.current = false;
    setConflictReviewSnapshot([]);
    refreshWith(api.session({ activeDeckId: deckId }), 'Deck switched');
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
    const tasks = cards
      .filter((c) => !c.tags.includes(trimmed))
      .map((c) => api.createSuggestion({
        deckId: activeDeck.id,
        cardId: c.id,
        authorId: state.user?.id || 'you',
        reason: `Bulk: add tag "${trimmed}"`,
        proposedFields: c.fields,
        proposedTags: [...c.tags, trimmed],
      }));
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
    const tasks = cards
      .filter((c) => c.tags.includes(trimmed))
      .map((c) => api.createSuggestion({
        deckId: activeDeck.id,
        cardId: c.id,
        authorId: state.user?.id || 'you',
        reason: `Bulk: remove tag "${trimmed}"`,
        proposedFields: c.fields,
        proposedTags: c.tags.filter((t) => t !== trimmed),
      }));
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
      if (item.subjectId) {
        setSelectedSuggestionId(item.subjectId);
        setSelectedOwnerQueueItemId(`suggestion:${item.subjectId}`);
      }
      setReviewTab('changes');
      return;
    }
    if (action === 'conflicts') {
      setActiveTab('overview');
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
      setActiveTab('overview');
    } else if (item.kind === 'ai' && item.conflictId) {
      setActiveTab('overview');
    } else if (item.cardId) {
      setActiveTab('cards');
    }
    setReviewTab('changes');
  }

  function decideSuggestion(decision: 'accepted' | 'rejected' | 'revision') {
    if (!selectedSuggestion) return;
    refreshWith(api.decideSuggestion(selectedSuggestion.id, decision), `Suggestion ${decision}`);
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
      <div className="auth-screen">
        <section className="auth-panel">
          <div className="brand-mark"><Icon name="cards" /></div>
          <h1>DeckBridge</h1>
          <p className="auth-subtitle">
            Sign in once. The Anki add-on can create its own connection token from your account.
          </p>
          <form className="auth-form" onSubmit={submitAuth}>
            <input
              aria-label="Email"
              autoComplete="email"
              placeholder="Email"
              type="email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              required
            />
            <input
              aria-label="Password"
              autoComplete={authMode === 'sign-in' ? 'current-password' : 'new-password'}
              placeholder="Password"
              type="password"
              minLength={6}
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              required
            />
            <button className="button primary" type="submit" disabled={authBusy}>
              {authBusy ? 'Working...' : authMode === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <button
            className="auth-switch"
            type="button"
            onClick={() => setAuthMode(authMode === 'sign-in' ? 'sign-up' : 'sign-in')}
          >
            {authMode === 'sign-in' ? 'Create an account' : 'Use an existing account'}
          </button>
          {authNotice ? <p className="auth-notice">{authNotice}</p> : null}
        </section>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="loading">
        <div className="loading-spinner" aria-hidden="true" />
        <strong>Loading DeckBridge...</strong>
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

        <div className="content-grid">
          <section className="deck-panel">
            <div className="breadcrumb">Decks <span>/</span> {activeDeck.name}</div>
            <div className="tabs">
              <button ref={overviewTabRef} className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
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
                        autoFocus
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
                        autoFocus
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
                    className={`table-row ${card.id === selectedCard?.id ? 'selected' : ''} ${selectedCardIds.has(card.id) ? 'checked' : ''}`}
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
          </section>

          <aside className="review-panel">
            <OwnerAttentionPanel
              items={ownerAttentionItems}
              onDismissArtifact={dismissOwnerArtifact}
              syncHealth={syncHealth}
              onAction={handleOwnerAttentionAction}
            />

            <div className="review-heading">
              <strong>Review Queue <span>{ownerReviewQueue.length}</span></strong>
              <button
                type="button"
                onClick={() => {
                  setReviewStatusFilter('pending');
                  setReviewAuthorFilter('All');
                  setSelectedOwnerQueueItemId(null);
                }}
                disabled={reviewStatusFilter === 'pending' && reviewAuthorFilter === 'All'}
              >
                Reset
              </button>
            </div>
            <div className="review-filter-bar" aria-label="Review queue filters">
              <label>
                <span>Status</span>
                <select
                  aria-label="Filter review queue by status"
                  value={reviewStatusFilter}
                  onChange={(event) => setReviewStatusFilter(event.target.value as typeof reviewStatusFilter)}
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
                  value={reviewAuthorFilter}
                  onChange={(event) => setReviewAuthorFilter(event.target.value)}
                >
                  {reviewAuthors.map((author) => <option key={author}>{author}</option>)}
                </select>
              </label>
            </div>

            {selectedCard ? (
              <section className="selected-card">
                <div className="suggestion-author">
                  <span className="avatar">{initials(selectedSuggestion?.authorName || 'Card')}</span>
                  <span>
                    <strong>{selectedSuggestion?.authorName || selectedOwnerQueueItem?.source || 'Selected card'}</strong>
                    <small>{selectedSuggestion ? relativeTime(selectedSuggestion.createdAt) : selectedOwnerQueueItem ? selectedOwnerQueueItem.detail : 'No pending suggestion selected'}</small>
                  </span>
                  <b className="pending-status">{selectedSuggestion?.status || selectedOwnerQueueItem?.status || 'draft'}</b>
                </div>
                <p className="card-context">Card: {fieldValue(selectedCard, 'Front') || Object.values(selectedCard.fields)[0]}</p>
                {activeDeck.aiSettings?.embeddings ? (
                  <div className="ai-brief-card">
                    <div className="ai-brief-header">
                      <strong>Semantic duplicates</strong>
                      {canManageDeck ? (
                        <button className="button secondary" onClick={indexSelectedCardEmbedding} disabled={embeddingBusy}>
                          <Icon name="spark" /> {embeddingBusy ? 'Indexing' : 'Index card'}
                        </button>
                      ) : null}
                    </div>
                    {duplicateBusy ? <small>Checking related cards...</small> : null}
                    {selectedDuplicateLinks.length ? (
                      <ul>
                        {selectedDuplicateLinks.slice(0, 3).map((link) => {
                          const comparedId = link.sourceCardId === selectedCard.id ? link.targetCardId : link.sourceCardId;
                          const comparedCard = activeDeck.cards.find((card) => card.id === comparedId);
                          return (
                            <li key={link.id}>
                              <strong>{link.relationship}</strong> {Math.round(link.score * 100)}%
                              <br />
                              <small>{selectedCard.id} vs {comparedId}: {comparedCard ? fieldValue(comparedCard, 'Front') || Object.values(comparedCard.fields)[0] : comparedId}</small>
                              <br />
                              <small>{link.rationale}</small>
                            </li>
                          );
                        })}
                      </ul>
                    ) : <small>No active duplicate links for this card.</small>}
                  </div>
                ) : null}
                <div className="review-tabs">
                  <button className={reviewTab === 'changes' ? 'active' : ''} onClick={() => setReviewTab('changes')}>Changes</button>
                  <button className={reviewTab === 'discussion' ? 'active' : ''} onClick={() => setReviewTab('discussion')}>Discussion</button>
                </div>

                {reviewTab === 'changes' ? (<>
                <CardPreviewComparison
                  currentCard={selectedCard}
                  proposedCard={selectedSuggestion
                    ? { ...selectedCard, fields: { ...selectedCard.fields, ...selectedSuggestion.proposedFields } }
                    : selectedCard}
                  deckId={activeDeck!.id}
                  hasSuggestion={!!selectedSuggestion}
                />
                <div className="diff-block">
                  <label>Tags</label>
                  <div className="tag-diff">
                    <span>{selectedCard.tags.join(', ') || 'No tags'}</span>
                    <strong>→</strong>
                    <span>{selectedSuggestion?.proposedTags.join(', ') || selectedCard.tags.join(', ')}</span>
                  </div>
                </div>

                <label className="reason-box">
                  <span>Reason for change</span>
                  <textarea id="suggestion-reason" name="suggestion-reason" aria-label="Reason for change" value={selectedSuggestion?.reason || draftReason} onChange={(event) => setDraftReason(event.target.value)} />
                </label>

                {canReview && selectedSuggestion ? (
                  <div className="decision-row">
                    <button className="button secondary" onClick={() => decideSuggestion('rejected')} disabled={busy}><Icon name="x" /> Reject</button>
                    <button className="button secondary" onClick={() => decideSuggestion('revision')} disabled={busy}>Request revision</button>
                    <button className="button primary" onClick={() => decideSuggestion('accepted')} disabled={busy}><Icon name="check" /> Accept</button>
                  </div>
                ) : (
                  <div className="decision-row">
                    <button className="button secondary" onClick={createSuggestion} disabled={busy || !canSuggest}><Icon name="spark" /> Suggest edit</button>
                    <button
                      className="button primary"
                      disabled={busy || state.sync.conflicts.length > 0}
                      title={state.sync.conflicts.length > 0 ? `Push blocked: resolve ${state.sync.conflicts.length} sync conflict${state.sync.conflicts.length === 1 ? '' : 's'} before writing accepted changes back to Anki.` : undefined}
                      onClick={() => activeDeck && refreshWith(api.ankiPush(activeDeck.id), 'Pushed accepted note updates', (value) => value.state)}
                    >
                      <Icon name="sync" /> Push to Anki
                    </button>
                    {state.sync.conflicts.length > 0 ? (
                      <small className="conflict-block-rationale" style={{ gridColumn: '1 / -1' }}>
                        Push blocked because unresolved sync conflicts could overwrite local Anki or DeckBridge edits.
                      </small>
                    ) : null}
                  </div>
                )}
                </>) : (
                  selectedSuggestion ? (
                    <SuggestionDiscussion
                      suggestionId={selectedSuggestion.id}
                      deckId={activeDeck.id}
                      currentUserId={state.user?.id || 'you'}
                      currentUserName={state.user?.name || 'You'}
                      commentsVersion={commentsVersion}
                      brief={selectedSuggestionBrief}
                      aiEnabled={activeDeck.aiSettings?.reviewBriefs === true}
                      canManageAi={canManageDeck}
                      briefBusy={briefBusy}
                      onGenerateBrief={generateSuggestionBrief}
                      onMarkBriefUseful={(artifactId) => updateSuggestionBriefStatus(artifactId, 'useful')}
                      onDismissBrief={(artifactId) => updateSuggestionBriefStatus(artifactId, 'dismiss')}
                    />
                  ) : <EmptyState message="Select a suggestion to view its discussion." />
                )}
              </section>
            ) : <EmptyState message="Select a card to review changes." />}

            {canReview && selectedSuggestionIds.size > 0 ? (
              <div className="suggestion-bulk-toolbar" role="toolbar" aria-label="Bulk suggestion decisions">
                <span>{selectedSuggestionIds.size} selected</span>
                <button className="button secondary" onClick={() => bulkDecideSuggestions('rejected')} disabled={busy}>Reject</button>
                <button className="button secondary" onClick={() => bulkDecideSuggestions('revision')} disabled={busy}>Request revision</button>
                <button className="button primary" onClick={() => bulkDecideSuggestions('accepted')} disabled={busy}>Accept</button>
                <button className="button secondary" onClick={clearSuggestionSelection} disabled={busy}>Clear</button>
              </div>
            ) : null}

            <div className="queue-list">
              {queueItems.length ? queueItems.map((item) => {
                const suggestion = item.suggestionId ? suggestions.find((candidate) => candidate.id === item.suggestionId) : undefined;
                return (
                <div
                  className={`queue-item ${item.id === selectedOwnerQueueItem?.id ? 'active' : ''}`}
                  key={item.id}
                >
                  {canReview && suggestion?.status === 'pending' ? (
                    <input
                      type="checkbox"
                      className="queue-select"
                      checked={selectedSuggestionIds.has(suggestion.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                      onChange={(event) => {
                        event.stopPropagation();
                        toggleSuggestionSelection(suggestion.id);
                      }}
                      aria-label={`${selectedSuggestionIds.has(suggestion.id) ? 'Deselect' : 'Select'} ${suggestion.authorName}'s suggestion`}
                    />
                  ) : <span className="queue-select-spacer" aria-hidden="true" />}
                  <button
                    type="button"
                    className="queue-item-main"
                    onClick={() => selectOwnerQueueItem(item)}
                  >
                    <span className="avatar">{initials(item.source)}</span>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.source} · {relativeTime(item.sortAt)} · {item.affectsNextPull ? 'Affects next pull' : 'No pull impact'}</small>
                    </span>
                    <b className={`queue-status ${item.status}`}>{item.status}</b>
                  </button>
                </div>
                );
              }) : <EmptyState message="No owner review items match the queue filters." />}
            </div>

            <section className="go-to-features">
              <strong>Collaboration edge</strong>
              <div className="feature-grid">
                <span>Review assignments</span>
                <span>Card comments</span>
                <span>Quality flags</span>
                <span>Conflict triage</span>
                <span>Deck health</span>
                <span>Accepted impact</span>
              </div>
            </section>
          </aside>
        </div>
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

  if (!hasSuggestion) {
    return (
      <div className="card-preview-single">
        <span className="card-preview-side-label">Front</span>
        <AnkiCardRenderer card={currentCard} deckId={deckId} side="front" />
        <span className="card-preview-side-label">Back</span>
        <AnkiCardRenderer card={currentCard} deckId={deckId} side="back" frontHtml={currentFrontHtml} />
      </div>
    );
  }

  return (
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
  );
}
