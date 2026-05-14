import { useMemo } from 'react';
import type { AiQualityPulse, AppState, Deck } from '../types';
import type { AddonPackageState, WorkbenchTab } from './common';
import {
  deriveSyncHealth,
  deriveOwnerAttentionItems,
  deriveWorkbenchRail,
  changedInLastSync,
  type SyncHealth,
  type OwnerAttentionItem,
  type WorkbenchRailKind,
} from './common';

export function useSyncState(
  state: AppState | null,
  activeDeck: Deck | undefined,
  addonPackage: AddonPackageState,
  apiHealth: 'checking' | 'ok' | 'down',
  canReview: boolean,
  pendingSuggestionsCount: number,
  qualityPulse: AiQualityPulse | null,
  studyCardsCount: number,
  activeDeckVisibility: string,
  activeTab: WorkbenchTab,
) {
  const syncSnapshot = state?.sync || {
    ankiConnectUrl: '', connected: false, lastCheckedAt: null,
    lastPullAt: null, lastPushAt: null, lastAddonSync: null, conflicts: []
  };

  const syncHealth = useMemo(() => deriveSyncHealth({ activeDeck, addonPackage, apiHealth, sync: syncSnapshot }), [activeDeck, addonPackage, apiHealth, syncSnapshot]);
  const changedCards = useMemo(() => changedInLastSync(activeDeck, syncSnapshot.lastAddonSync), [activeDeck, syncSnapshot.lastAddonSync]);
  const activeRail = deriveWorkbenchRail({ activeTab, hasDeck: Boolean(activeDeck) });

  const ownerAttentionItems = useMemo(() => deriveOwnerAttentionItems({
    canReview, changedCards, deckVisibility: activeDeckVisibility,
    pendingSuggestions: pendingSuggestionsCount, pulse: qualityPulse,
    studyCards: studyCardsCount, syncHealth,
  }), [activeDeckVisibility, canReview, changedCards, pendingSuggestionsCount, qualityPulse, studyCardsCount, syncHealth]);

  return { syncHealth, changedCards, activeRail, ownerAttentionItems };
}
