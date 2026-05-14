import { useState, useEffect, useCallback, useMemo, useRef, type ChangeEvent } from 'react';
import { type Session } from '@supabase/supabase-js';
import { api, setApiAuthToken } from '../api';
import type { AiArtifact, AiDuplicateLink, AiQualityPulse, AppState, Deck, DeckCard, DeckMember, DeckSummary, Suggestion } from '../types';
import { readSavedConflictDecisions, saveConflictDecision } from '../ConflictResolution';
import {
  type Toast,
  type AddonPackageState,
  type WorkbenchTab,
  type OwnerAttentionItem,
  supabase,
  AUTH_REQUEST_TIMEOUT_MS,
  searchableCardText,
  deriveOwnerAttentionItems,
  changedInLastSync,
  withAuthTimeout,
  authMessage,
  deriveSyncHealth,
  deriveWorkbenchRail,
  stateFromMeResponse,
  mergeHydratedDeckState,
  DEFAULT_AI_SETTINGS,
  emptySyncState,
  fieldValue,
  useDebounce,
} from './common';

export function useDeckOperations() {
  function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

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
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'tag-add' | 'tag-remove' | 'delete' | null>(null);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('overview');
  const [showStudy, setShowStudy] = useState(false);
  const [studyApprovedOnly, setStudyApprovedOnly] = useState(true);
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

  const [showConnectWizard, setShowConnectWizard] = useState(false);
  const [reviewTab, setReviewTab] = useState<'changes' | 'discussion'>('changes');
  const [reviewRiskFilter, setReviewRiskFilter] = useState<string>('all');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<string>('pending');
  const [reviewAuthorFilter, setReviewAuthorFilter] = useState('All');
  const [sourceCheckByReviewItem, setSourceCheckByReviewItem] = useState<Record<string, 'needs' | 'checked'>>({});
  const [suggestionBriefs, setSuggestionBriefs] = useState<Record<string, AiArtifact | null>>({});
  const [qualityPulse, setQualityPulse] = useState<AiQualityPulse | null>(null);
  const [qualityPulseBusy, setQualityPulseBusy] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [duplicateLinks, setDuplicateLinks] = useState<AiDuplicateLink[]>([]);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [conflictReviewSnapshot, setConflictReviewSnapshot] = useState<any[]>([]);

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
    const controller = new AbortController();

    async function loadDemoState() {
      try {
        const [next] = await Promise.all([api.state(), api.health()]);
        if (controller.signal.aborted) return;
        applyAuthoritativeState(next);
        setApiHealth('ok');
        const nextActiveDeck = next.decks.find((deck) => deck.id === next.activeDeckId);
        setSelectedCardId(nextActiveDeck?.cards[0]?.id || null);
        setSelectedSuggestionId(next.suggestions.find((item) => item.status === 'pending')?.id || null);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        setApiHealth('down');
        pushToast('Unable to load DeckBridge workspace', 'error');
      }
    }

    async function loadAuthenticatedState() {
      try {
        const [me, healthOk] = await Promise.all([
          api.me(),
          api.health().then(() => true).catch(() => false)
        ]);
        if (controller.signal.aborted) return;
        const shell = stateFromMeResponse(me, state?.activeDeckId);
        applyAuthoritativeState(shell);
        setApiHealth(healthOk ? 'ok' : 'down');
        if (!shell.activeDeckId) return;
        setDeckLoading(true);
        const next = await api.deck(shell.activeDeckId);
        if (controller.signal.aborted) return;
        applyHydratedDeckState(next);
        const nextActiveDeck = next.decks.find((deck) => deck.id === next.activeDeckId);
        setSelectedCardId(nextActiveDeck?.cards[0]?.id || null);
        setSelectedSuggestionId(next.suggestions.find((item) => item.status === 'pending')?.id || null);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        setApiHealth('down');
        pushToast('Unable to load DeckBridge workspace', 'error');
      } finally {
        if (!controller.signal.aborted) setDeckLoading(false);
      }
    }

    if (supabase) void loadAuthenticatedState();
    else void loadDemoState();
    return () => controller.abort();
  }, [authReady, session?.access_token]);

  useEffect(() => {
    if (supabase && !session) return;
    if (!state?.activeDeckId) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      api.ankiStatus()
        .then(() => api.deck(state.activeDeckId!))
        .then(applyHydratedDeckState)
        .catch((error) => {
          if (isAbortError(error)) return;
        });
    }, 15000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [session?.access_token, state?.activeDeckId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('deckbridge-dark', String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    setAddonPackage((current) => ({ ...current, loading: true }));
    api.addonVersion()
      .then(async (version) => {
        const availability = await api.addonDownloadAvailability(version.downloadUrl || '/api/addon/download');
        if (!mounted) return;
        setAddonPackage({ loading: false, version, availability, error: '' });
      })
      .catch(async (error) => {
        if (isAbortError(error)) return;
        const availability = await api.addonDownloadAvailability('/api/addon/download');
        if (!mounted) return;
        setAddonPackage({
          loading: false,
          version: null,
          availability,
          error: error instanceof Error ? error.message : 'Unable to load add-on package details'
        });
      });
    return () => { mounted = false; controller.abort(); };
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

  const activeSummary = state?.summaries.find((summary) => summary.id === activeDeck?.id);
  const currentMembership = state?.memberships?.find((item) => item.deckId === activeDeck?.id);
  const isDevDemo = import.meta.env.DEV;
  const membershipRole = isDevDemo
    ? (state?.role || 'contributor')
    : currentMembership?.role || (state?.role === 'owner' ? 'owner' : 'contributor');
  const canReview = ['owner', 'editor', 'reviewer'].includes(membershipRole);
  const canManageDeck = membershipRole === 'owner';
  const canSuggest = ['owner', 'editor', 'reviewer', 'contributor'].includes(membershipRole);

  const syncSnapshot = state?.sync || emptySyncState();
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
      total, accepted, rejected, pending, revision,
      acceptanceRate: total ? Math.round((accepted / total) * 100) : 0
    };
  }, [suggestions]);

  const activeDeckVisibility = activeDeck ? (deckVisibility[activeDeck.id] ?? 'private') : 'private';
  const deckEmbedCode = activeDeck ? `<iframe src="${window.location.origin}/embed/decks/${activeDeck.id}" title="${activeDeck.name}" loading="lazy"></iframe>` : '';

  const duplicateCountsByCard = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of duplicateLinks) {
      counts.set(link.sourceCardId, (counts.get(link.sourceCardId) || 0) + 1);
      counts.set(link.targetCardId, (counts.get(link.targetCardId) || 0) + 1);
    }
    return counts;
  }, [duplicateLinks]);

  const syncHealth = useMemo(() => deriveSyncHealth({ activeDeck, addonPackage, apiHealth, sync: syncSnapshot }), [activeDeck, addonPackage, apiHealth, syncSnapshot]);
  const changedCards = useMemo(() => changedInLastSync(activeDeck, syncSnapshot.lastAddonSync), [activeDeck, syncSnapshot.lastAddonSync]);
  const ownerAttentionItems = useMemo(() => deriveOwnerAttentionItems({
    canReview, changedCards, deckVisibility: activeDeckVisibility,
    pendingSuggestions: pendingSuggestions.length, pulse: qualityPulse,
    studyCards: studyCards.length, syncHealth
  }), [activeDeckVisibility, canReview, changedCards, pendingSuggestions.length, qualityPulse, studyCards.length, syncHealth]);
  const activeRail = deriveWorkbenchRail({ activeTab, hasDeck: Boolean(activeDeck) });

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

  const deckHealth = syncHealth;

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
    } catch {
      setQualityPulse(null);
      return null;
    } finally {
      setQualityPulseBusy(false);
    }
  }, [activeDeck?.id, activeDeck?.aiSettings?.qualityPulse]);

  useEffect(() => {
    const controller = new AbortController();
    if (!activeDeck?.id || !activeDeck.aiSettings?.qualityPulse) {
      setQualityPulse(null);
      return;
    }
    setQualityPulseBusy(true);
    api.aiArtifacts.pulse(activeDeck.id)
      .then((pulse) => { if (!controller.signal.aborted) setQualityPulse(pulse); })
      .catch((error) => { if (!isAbortError(error) && !controller.signal.aborted) setQualityPulse(null); })
      .finally(() => { if (!controller.signal.aborted) setQualityPulseBusy(false); });
    return () => controller.abort();
  }, [activeDeck?.id, activeDeck?.aiSettings?.qualityPulse]);

  useEffect(() => {
    if (!activeDeck?.id || !selectedSuggestionId || !activeDeck.aiSettings?.reviewBriefs) return;
    const controller = new AbortController();
    api.aiArtifacts.list(activeDeck.id, {
      kind: 'review-brief', subjectType: 'suggestion', subjectId: selectedSuggestionId
    }).then(({ artifacts }) => {
      if (controller.signal.aborted) return;
      setSuggestionBriefs((prev) => ({
        ...prev, [selectedSuggestionId]: artifacts.find((item) => item.status === 'active') || artifacts[0] || null
      }));
    }).catch((error) => {
      if (isAbortError(error) || controller.signal.aborted) return;
      setSuggestionBriefs((prev) => ({ ...prev, [selectedSuggestionId]: null }));
    });
    return () => controller.abort();
  }, [activeDeck?.id, activeDeck?.aiSettings?.reviewBriefs, selectedSuggestionId]);

  useEffect(() => {
    if (!activeDeck?.id || !selectedCardId || !activeDeck.aiSettings?.embeddings) {
      setDuplicateLinks([]);
      return;
    }
    const controller = new AbortController();
    setDuplicateBusy(true);
    api.aiCardEmbeddings.related(activeDeck.id, selectedCardId, { limit: 8, minScore: 0.78 })
      .then((result) => { if (!controller.signal.aborted) setDuplicateLinks(result.links || []); })
      .catch((error) => { if (!isAbortError(error) && !controller.signal.aborted) setDuplicateLinks([]); })
      .finally(() => { if (!controller.signal.aborted) setDuplicateBusy(false); });
    return () => controller.abort();
  }, [activeDeck?.id, activeDeck?.aiSettings?.embeddings, selectedCardId]);

  async function refreshWith<T>(task: Promise<T>, success: string, map?: (value: T) => AppState) {
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

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
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
        deckId: activeDeck.id, cardId: c.id, authorId: state.user?.id || 'you',
        reason: `Bulk: add tag "${trimmed}"`,
        proposedFields: c.fields, proposedTags: [...c.tags, trimmed],
      })] : []
    );
    if (tasks.length === 0) { setBulkAction(null); setBulkTagInput(''); return; }
    refreshWith(Promise.all(tasks).then(() => api.deck(activeDeck.id)), `Tag "${trimmed}" suggested for ${tasks.length} card(s)`);
    setBulkAction(null); setBulkTagInput(''); setSelectedCardIds(new Set());
  }

  function handleBulkTagRemove(tag: string) {
    if (!tag.trim() || !activeDeck || !state) return;
    const trimmed = tag.trim();
    const cards = activeDeck.cards.filter((c) => selectedCardIds.has(c.id));
    const tasks = cards.flatMap((c) =>
      c.tags.includes(trimmed) ? [api.createSuggestion({
        deckId: activeDeck.id, cardId: c.id, authorId: state.user?.id || 'you',
        reason: `Bulk: remove tag "${trimmed}"`,
        proposedFields: c.fields, proposedTags: c.tags.filter((t) => t !== trimmed),
      })] : []
    );
    if (tasks.length === 0) { setBulkAction(null); setBulkTagInput(''); return; }
    refreshWith(Promise.all(tasks).then(() => api.deck(activeDeck.id)), `Tag removal suggested for ${tasks.length} card(s)`);
    setBulkAction(null); setBulkTagInput(''); setSelectedCardIds(new Set());
  }

  function handleBulkDelete() {
    if (!activeDeck || selectedCardIds.size === 0) return;
    const ids = [...selectedCardIds];
    refreshWith(api.bulkDeleteCards(activeDeck.id, ids).then(() => api.deck(activeDeck.id)), `${ids.length} card(s) deleted`);
    setBulkAction(null); setSelectedCardIds(new Set());
  }

  function createSuggestion() {
    if (!activeDeck || !selectedCard || !state || !canSuggest) return;
    const author = state.collaborators.find((item) => item.role !== 'owner') || state.collaborators[0];
    const front = fieldValue(selectedCard, 'Front');
    const back = fieldValue(selectedCard, 'Back');
    refreshWith(api.createSuggestion({
      deckId: activeDeck.id, cardId: selectedCard.id, authorId: author.id,
      reason: draftReason,
      proposedFields: {
        ...selectedCard.fields,
        Front: front.includes('[suggested]') ? front : `${front} [suggested]`,
        Back: back.includes('Reviewed:') ? back : `Reviewed: ${back}`
      },
      proposedTags: Array.from(new Set([...selectedCard.tags, 'Needs-owner-review']))
    }), 'Suggestion added to owner review queue');
  }

  async function exportDeck() {
    if (!activeDeck) return;
    setBusy(true);
    try {
      const { blob, filename } = await api.exportDeck(activeDeck.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = filename; anchor.click();
      URL.revokeObjectURL(url);
      const next = await api.state();
      applyAuthoritativeState(next);
      pushToast(`Exported ${filename}`, 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Export failed', 'error');
    } finally { setBusy(false); }
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
    refreshWith(api.bulkDecideSuggestions(activeDeck.id, ids, decision), `${ids.length} suggestion(s) ${decision}`);
    clearSuggestionSelection();
  }

  const selectedCard = useMemo(() => {
    const byId = activeDeck?.cards.find((c) => c.id === selectedCardId);
    return byId || activeDeck?.cards[0];
  }, [activeDeck, selectedCardId]);

  function selectOwnerQueueItem(item: { id: string; suggestionId?: string; cardId?: string; kind?: string; conflictId?: string }) {
    setSelectedOwnerQueueItemId(item.id);
    if (item.suggestionId) setSelectedSuggestionId(item.suggestionId);
    else setSelectedSuggestionId(null);
    if (item.cardId) {
      setSelectedCardId(item.cardId);
      setQueryInput(''); setTagFilter('All'); setCardStateFilter('All');
      const targetIndex = activeDeck?.cards.findIndex((card) => card.id === item.cardId) ?? -1;
      if (targetIndex >= 0) setPage(Math.floor(targetIndex / pageSize) + 1);
    }
    if (item.kind === 'conflict' || (item.kind === 'ai' && item.conflictId)) {
      setReviewRiskFilter('conflict');
    }
    setActiveTab('review');
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
      ? conflictReviewSnapshot : activeSyncConflicts;
    saveConflictDecision(decisionConflicts, selectedConflict, resolution);
    setState(prev => prev ? {
      ...prev,
      sync: { ...prev.sync, conflicts: prev.sync.conflicts.filter(c => c.id !== selectedConflict.id) }
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
    } finally { setBriefBusy(false); }
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
    } finally { setBriefBusy(false); }
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
    } finally { setEmbeddingBusy(false); }
  }

  async function indexVisibleCardEmbeddings() {
    if (!activeDeck) return;
    setEmbeddingBusy(true);
    try {
      const result = await api.aiCardEmbeddings.embedBatch(activeDeck.id, {
        cardIds: filteredCards.slice(0, 25).map((card) => card.id), limit: 25, minScore: 0.78
      });
      pushToast(result.status === 'disabled' ? 'AI duplicate indexing is disabled' : `Indexed ${result.indexed || 0} card(s)`, result.status === 'disabled' ? 'info' : 'success');
      if (selectedCard) {
        const related = await api.aiCardEmbeddings.related(activeDeck.id, selectedCard.id, { limit: 8, minScore: 0.78 });
        setDuplicateLinks(related.links || []);
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Unable to index visible cards', 'error');
    } finally { setEmbeddingBusy(false); }
  }

  function handleSyncAction(action: 'setup' | 'check' | 'conflicts') {
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
    if (action === 'setup') { setShowConnectWizard(true); return; }
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
        setQueryInput(''); setTagFilter('All'); setCardStateFilter('All');
        setPage(targetPage);
        setSelectedSuggestionId(null);
        setSelectedOwnerQueueItemId(null);
        setSelectedCardId(item.subjectId);
        window.setTimeout(() => setPage(targetPage), 260);
      }
      setActiveTab('cards');
      return;
    }
    if (action === 'settings') { setActiveTab('settings'); return; }
    setActiveTab('study');
  }

  const selectedOwnerQueueItem: import('../types').Suggestion | null = null;
  const selectedSuggestion: import('../types').Suggestion | undefined = selectedSuggestionId
    ? suggestions.find((s) => s.id === selectedSuggestionId)
    : undefined;

  const selectedConflict: AppState['sync']['conflicts'][number] | undefined = undefined;

  return {
    state, setState, activeDeck, activeSummary, currentMembership,
    isDevDemo, membershipRole, canReview, canManageDeck, canSuggest,
    session, authReady, authMode, authEmail, authPassword, authBusy, authNotice,
    supabase: supabase!,
    syncSnapshot, activeSyncConflicts, pendingConflictIds,
    suggestions, pendingSuggestions, reviewAuthors,
    allTags, cardStates, filteredCards, maxPage, safePage, pagedCards,
    currentStart, currentEnd, cardsWithPendingSuggestions,
    approvedStudyCards, studyCards, closeStudyView, suggestionStats,
    duplicateCountsByCard,
    activeDeckVisibility, deckEmbedCode,
    changedCards, syncHealth, ownerAttentionItems, activeRail,
    addonPackage, apiHealth, busy, setBusy, deckLoading,
    page, pageSize, query, queryInput, tagFilter, cardStateFilter, draftReason,
    qualityPulse, qualityPulseBusy, duplicateLinks, duplicateBusy, embeddingBusy,
    conflictReviewSnapshot, deckVisibility, copiedShare,
    selectedCardId, selectedSuggestionId, selectedOwnerQueueItemId,
    selectedSuggestionIds, selectedCardIds,
    selectedCard, selectedOwnerQueueItem, selectedSuggestion, selectedConflict,
    toasts, commentsVersion,
    reviewTab, reviewRiskFilter, reviewStatusFilter, reviewAuthorFilter,
    sourceCheckByReviewItem, suggestionBriefs, briefBusy,
    showConnectWizard, editingCardId, bulkAction, bulkTagInput,
    activeTab, showStudy, studyApprovedOnly, topView, darkMode,
    overviewTabRef, suggestionImportRef,
    retainConflictReviewSnapshot,
    loadDecks: () => {},
    uploadDeck, importSuggestionSpreadsheet, exportDeck,
    removeActiveDeckFromDeckBridge, switchDeck, switchRole, submitAuth,
    pushToast, dismissToast,
    refreshActiveDeckState, refreshState, refreshWith,
    handleSuggestionChange, handleCommentChange,
    toggleCardSelection, handleBulkTagAdd, handleBulkTagRemove, handleBulkDelete,
    createSuggestion, bulkDecideSuggestions, clearSuggestionSelection,
    toggleSuggestionSelection,
    selectOwnerQueueItem, decideSuggestion, resolveSelectedConflict,
    generateSuggestionBrief, updateSuggestionBriefStatus,
    dismissOwnerArtifact, indexSelectedCardEmbedding, indexVisibleCardEmbeddings,
    handleSyncAction, handleOwnerAttentionAction, refreshQualityPulse,
    setAuthMode, setAuthEmail, setAuthPassword,
    setSelectedCardId, setSelectedSuggestionId, setSelectedOwnerQueueItemId,
    setSelectedSuggestionIds, setQueryInput, setTagFilter, setCardStateFilter,
    setDraftReason, setPage, setPageSize, setShowConnectWizard,
    setReviewTab, setReviewRiskFilter, setReviewStatusFilter, setReviewAuthorFilter,
    setSourceCheckByReviewItem, setActiveTab, setShowStudy, setStudyApprovedOnly,
    setTopView, setDarkMode, setEditingCardId, setSelectedCardIds,
    setBulkAction, setBulkTagInput, setConflictReviewSnapshot, setCopiedShare,
    setCommentsVersion, setDeckVisibility, setDeckLoading,
  };
}
