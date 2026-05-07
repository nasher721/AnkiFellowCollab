import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { api, setApiAuthToken, type ShareLink } from './api';
import type { AppState, Deck, DeckCard, DeckSummary, Suggestion } from './types';
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
import { ConflictResolution } from './ConflictResolution';

const PAGE_SIZE = 10;
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

function shareLinkUrl(token: string) {
  return `${window.location.origin}/share/${encodeURIComponent(token)}`;
}

function Icon({ name }: { name: 'upload' | 'download' | 'sync' | 'search' | 'filter' | 'cards' | 'users' | 'check' | 'x' | 'spark' }) {
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
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z'
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

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('All');
  const [cardStateFilter, setCardStateFilter] = useState('All');
  const [draftReason, setDraftReason] = useState('Clarified wording and improved tagging.');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [apiHealth, setApiHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [authReady, setAuthReady] = useState(!supabase);
  const [session, setSession] = useState<Session | null>(null);
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [showConnectWizard, setShowConnectWizard] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'study' | 'cards' | 'stats' | 'analytics' | 'activity' | 'settings'>('overview');
  const [showStudy, setShowStudy] = useState(false);
  const [studyApprovedOnly, setStudyApprovedOnly] = useState(true);
  const [reviewTab, setReviewTab] = useState<'changes' | 'discussion'>('changes');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<'pending' | 'accepted' | 'rejected' | 'revision' | 'all'>('pending');
  const [reviewAuthorFilter, setReviewAuthorFilter] = useState('All');
  const [topView, setTopView] = useState<'workspace' | 'discover' | 'templates'>('workspace');
  const [deckVisibility, setDeckVisibility] = useState<Record<string, string>>({});
  const [copiedShare, setCopiedShare] = useState('');
  const activeDeck = state?.decks.find((deck) => deck.id === state.activeDeckId) || state?.decks[0];

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
        setState(next);
        setApiHealth('ok');
        const nextActiveDeck = next.decks.find((deck) => deck.id === next.activeDeckId);
        setSelectedCardId(nextActiveDeck?.cards[0]?.id || null);
        setSelectedSuggestionId(next.suggestions.find((item) => item.status === 'pending')?.id || null);
      }).catch((error) => {
        setApiHealth('down');
        setNotice(error.message);
      });
  }, [authReady, session]);

  useEffect(() => {
    if (supabase && !session) return undefined;
    const timer = window.setInterval(() => {
      api.ankiStatus().then(() => api.state()).then(setState).catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    setPage(1);
  }, [query, tagFilter, cardStateFilter, activeDeck?.id]);

  const handleSuggestionChange = useCallback(() => {
    api.state().then(setState).catch(() => undefined);
  }, []);

  const handleCommentChange = useCallback(() => {
    api.state().then(setState).catch(() => undefined);
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
  const membershipRole = currentMembership?.role || (state?.role === 'owner' ? 'owner' : 'editor');
  const canReview = membershipRole === 'owner';
  const canSuggest = membershipRole === 'owner' || membershipRole === 'editor';
  const isDevDemo = import.meta.env.DEV;
  const suggestions = useMemo(
    () => (state?.suggestions || []).filter((item) => item.deckId === activeDeck?.id),
    [state, activeDeck]
  );
  const pendingSuggestions = suggestions.filter((item) => item.status === 'pending');
  const reviewAuthors = useMemo(() => ['All', ...Array.from(new Set(suggestions.map((item) => item.authorName))).sort()], [suggestions]);
  const queueSuggestions = useMemo(() => suggestions.filter((item) => {
    const statusMatch = reviewStatusFilter === 'all' || item.status === reviewStatusFilter;
    const authorMatch = reviewAuthorFilter === 'All' || item.authorName === reviewAuthorFilter;
    return statusMatch && authorMatch;
  }), [suggestions, reviewStatusFilter, reviewAuthorFilter]);
  const selectedSuggestion = queueSuggestions.find((item) => item.id === selectedSuggestionId) || queueSuggestions[0];
  const selectedCard = activeDeck?.cards.find((card) => card.id === (selectedSuggestion?.cardId || selectedCardId)) || activeDeck?.cards[0];
  const allTags = useMemo(() => ['All', ...Array.from(new Set(activeDeck?.cards.flatMap((card) => card.tags) || [])).sort()], [activeDeck]);
  const cardStates = useMemo(() => ['All', ...Array.from(new Set(activeDeck?.cards.map((card) => card.state) || [])).sort()], [activeDeck]);
  const filteredCards = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (activeDeck?.cards || []).filter((card) => {
      const textMatch = !normalized || [
        card.type,
        card.state,
        card.tags.join(' '),
        ...Object.values(card.fields)
      ].join(' ').toLowerCase().includes(normalized);
      const tagMatch = tagFilter === 'All' || card.tags.includes(tagFilter);
      const stateMatch = cardStateFilter === 'All' || card.state === cardStateFilter;
      return textMatch && tagMatch && stateMatch;
    });
  }, [activeDeck, query, tagFilter, cardStateFilter]);
  const maxPage = Math.max(1, Math.ceil(filteredCards.length / PAGE_SIZE));
  const safePage = Math.min(page, maxPage);
  const pagedCards = filteredCards.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const currentStart = filteredCards.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const currentEnd = Math.min(safePage * PAGE_SIZE, filteredCards.length);
  const cardsWithPendingSuggestions = useMemo(() => new Set(pendingSuggestions.map((item) => item.cardId)), [pendingSuggestions]);
  const approvedStudyCards = useMemo(() => (activeDeck?.cards || []).filter((card) => (
    !card.suspended && !cardsWithPendingSuggestions.has(card.id)
  )), [activeDeck, cardsWithPendingSuggestions]);
  const studyCards = studyApprovedOnly ? approvedStudyCards : (activeDeck?.cards || []);
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

  async function refreshWith<T extends AppState | unknown>(task: Promise<T>, success: string, map?: (value: T) => AppState) {
    setBusy(true);
    setNotice('');
    try {
      const result = await task;
      if (map) setState(map(result));
      else if (result && typeof result === 'object' && 'decks' in result) setState(result as unknown as AppState);
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function uploadDeck(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    refreshWith(api.uploadDeck(file), `Imported ${file.name}`);
    event.target.value = '';
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true);
    setNotice('');
    const credentials = { email: authEmail, password: authPassword };
    const { error } = authMode === 'sign-in'
      ? await supabase.auth.signInWithPassword(credentials)
      : await supabase.auth.signUp({ ...credentials, options: { data: { name: authEmail } } });
    if (error) setNotice(error.message);
    setAuthBusy(false);
  }

  function switchDeck(deckId: string) {
    setSelectedSuggestionId(null);
    setSelectedCardId(null);
    refreshWith(api.session({ activeDeckId: deckId }), 'Deck switched');
  }

  function switchRole(role: 'owner' | 'collaborator') {
    if (!isDevDemo) return;
    refreshWith(api.session({ role }), role === 'owner' ? 'Owner review controls enabled' : 'Collaborator suggestion mode enabled');
  }

  function createSuggestion() {
    if (!activeDeck || !selectedCard || !state || !canSuggest) return;
    const author = state.collaborators.find((item) => item.role === 'collaborator') || state.collaborators[0];
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

  function decideSuggestion(decision: 'accepted' | 'rejected' | 'revision') {
    if (!selectedSuggestion) return;
    refreshWith(api.decideSuggestion(selectedSuggestion.id, decision), `Suggestion ${decision}`);
  }

  async function exportDeck() {
    if (!activeDeck) return;
    setBusy(true);
    setNotice('');
    try {
      const { blob, filename } = await api.exportDeck(activeDeck.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      const next = await api.state();
      setState(next);
      setNotice(`Exported ${filename}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed');
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
              {authMode === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <button
            className="auth-switch"
            type="button"
            onClick={() => setAuthMode(authMode === 'sign-in' ? 'sign-up' : 'sign-in')}
          >
            {authMode === 'sign-in' ? 'Create an account' : 'Use an existing account'}
          </button>
          {notice ? <p className="auth-notice">{notice}</p> : null}
        </section>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="loading">
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
          <p>Upload an `.apkg` to create a collaborative workspace backed by Supabase.</p>
          <label className="button primary">
            Import .apkg
            <input className="file-input-hidden" type="file" accept=".apkg" onChange={uploadDeck} />
          </label>
          {notice ? <span className="notice">{notice}</span> : null}
        </section>
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
      </aside>

      {topView === 'discover' && (
        <section className="workspace">
          <DiscoverView
            onFork={(deckId, name) => {
              setTopView('workspace');
              setNotice(`Forked "${name}" into your workspace`);
              api.state().then(setState).catch(() => undefined);
            }}
          />
        </section>
      )}

      {topView === 'templates' && (
        <section className="workspace">
          <TemplateGallery
            onUse={(deckId, name) => {
              setTopView('workspace');
              setNotice(`Created "${name}" from template`);
              api.state().then(setState).catch(() => undefined);
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

          <div className="sync-strip">
            <span className={`sync-light ${state.sync.connected ? 'on' : ''}`} />
            <strong>AnkiConnect</strong>
            <span className={state.sync.connected ? 'connected-pill' : 'offline-pill'}>
              {state.sync.connected ? 'Connected' : 'Offline'}
            </span>
            <small>{state.sync.ankiConnectUrl?.replace('http://', '') || 'Local bridge'}</small>
            <button className="icon-button" title="Check AnkiConnect" onClick={() => refreshWith(api.ankiStatus().then(() => api.state()), 'AnkiConnect checked')}>
              <Icon name="sync" />
            </button>
          </div>

          <div className="right-actions">
            {isDevDemo ? (
              <div className="role-toggle" aria-label="Role selector">
                <button className={membershipRole === 'owner' ? 'selected' : ''} onClick={() => switchRole('owner')}>Owner</button>
                <button className={membershipRole !== 'owner' ? 'selected' : ''} onClick={() => switchRole('collaborator')}>Collaborator</button>
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
                  } catch (e) { setNotice(e instanceof Error ? e.message : 'Export failed'); }
                  finally { setBusy(false); }
                }} disabled={busy}>.csv (Spreadsheet)</button>
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
                  } catch (e) { setNotice(e instanceof Error ? e.message : 'Export failed'); }
                  finally { setBusy(false); }
                }} disabled={busy}>Activity Log (.csv)</button>
              </div>
            </div>
          </div>
        </header>

        <div className="content-grid">
          <section className="deck-panel">
            <div className="breadcrumb">Decks <span>/</span> {activeDeck.name}</div>
            <div className="tabs">
              <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>
              <button className={activeTab === 'study' ? 'active' : ''} onClick={() => setActiveTab('study')}>Study</button>
              <button className={activeTab === 'cards' ? 'active' : ''} onClick={() => setActiveTab('cards')}>Cards</button>
              <button className={activeTab === 'stats' ? 'active' : ''} onClick={() => setActiveTab('stats')}>Stats</button>
              <button className={activeTab === 'analytics' ? 'active' : ''} onClick={() => setActiveTab('analytics')}>Analytics</button>
              <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}>Activity</button>
              <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>Settings</button>
              <span className="pending-callout">{pendingSuggestions.length} pending suggestions</span>
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
                isOwner={canReview}
                currentVisibility={deckVisibility[activeDeck.id] ?? 'private'}
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

            {activeTab === 'settings' && activeDeck ? (
              <DeckSettingsView
                deck={activeDeck}
                visibility={deckVisibility[activeDeck.id] ?? 'private'}
                canReview={canReview}
                embedCode={deckEmbedCode}
                copiedShare={copiedShare}
                onCopied={setCopiedShare}
                onSetVisibility={(v) => {
                  refreshWith(api.setVisibility(activeDeck.id, v), `Deck visibility set to ${v}`, () => {
                    setDeckVisibility((prev) => ({ ...prev, [activeDeck.id]: v }));
                    return state;
                  });
                }}
              />
            ) : null}

            {state.sync.conflicts.length ? (
              <ConflictResolution
                conflicts={state.sync.conflicts}
                onResolve={(conflictId, resolution) => {
                  setState(prev => prev ? {
                    ...prev,
                    sync: {
                      ...prev.sync,
                      conflicts: prev.sync.conflicts.filter(c => c.id !== conflictId)
                    }
                  } : prev);
                  if (resolution !== 'skip') {
                    setNotice(resolution === 'local' ? 'Kept local version' : 'Applied incoming changes');
                  }
                }}
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
                  <input id="card-search" name="card-search" aria-label="Search cards" placeholder="Search cards..." value={query} onChange={(event) => setQuery(event.target.value)} />
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
                    setQuery('');
                    setTagFilter('All');
                    setCardStateFilter('All');
                  }}
                  disabled={!query && tagFilter === 'All' && cardStateFilter === 'All'}
                >
                  <Icon name="filter" /> Clear filters
                </button>
              </div>

              <div className="card-table" role="table">
                <div className="table-header" role="row">
                  <span />
                  <span>Card</span>
                  <span>Note Type</span>
                  <span>Tags</span>
                  <span>Due</span>
                  <span>State</span>
                  <span>Last Modified</span>
                </div>
                {pagedCards.length ? pagedCards.map((card) => (
                  editingCardId === card.id ? (
                    <div key={card.id} className="table-row editing">
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
                  ) : (
                  <button
                    className={`table-row ${card.id === selectedCard?.id ? 'selected' : ''}`}
                    key={card.id}
                    onClick={() => {
                      setSelectedCardId(card.id);
                      const linked = suggestions.find((item) => item.cardId === card.id && item.status === 'pending');
                      if (linked) setSelectedSuggestionId(linked.id);
                    }}
                    onDoubleClick={() => canSuggest && setEditingCardId(card.id)}
                    title={canSuggest ? 'Double-click to edit' : undefined}
                    role="row"
                  >
                    <span className="checkbox" />
                    <span className="card-front">{fieldValue(card, 'Front') || Object.values(card.fields)[0]}</span>
                    <span>{card.type}</span>
                    <span className="tag-list">{card.tags.slice(0, 2).map((tag) => <em key={tag}>{tag}</em>)}</span>
                    <span>{card.due ?? '-'}</span>
                    <span><b className={`state-chip ${statusColors[card.state] || 'neutral'}`}>{card.state}</b></span>
                    <span><small>{relativeTime(card.modifiedAt)}<br />{card.modifiedBy}</small></span>
                  </button>
                  )
                )) : <EmptyState message="No cards match the current filters." />}
              </div>

              <div className="pagination-row">
                <span>Rows per page <strong>{PAGE_SIZE}</strong></span>
                <span>{currentStart}-{currentEnd} of {filteredCards.length.toLocaleString()}</span>
                <span className="pager">
                  <button aria-label="Previous page" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage === 1}>‹</button>
                  <strong>{safePage}</strong>
                  <button aria-label="Next page" onClick={() => setPage((value) => Math.min(maxPage, value + 1))} disabled={safePage === maxPage}>›</button>
                </span>
              </div>
            </div>
            </>) : null}
          </section>

          <aside className="review-panel">
            <div className="review-heading">
              <strong>Review Queue <span>{pendingSuggestions.length}</span></strong>
              <button
                type="button"
                onClick={() => {
                  setReviewStatusFilter('pending');
                  setReviewAuthorFilter('All');
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
                    <strong>{selectedSuggestion?.authorName || 'Selected card'}</strong>
                    <small>{selectedSuggestion ? relativeTime(selectedSuggestion.createdAt) : 'No pending suggestion selected'}</small>
                  </span>
                  <b className="pending-status">{selectedSuggestion?.status || 'draft'}</b>
                </div>
                <p className="card-context">Card: {fieldValue(selectedCard, 'Front') || Object.values(selectedCard.fields)[0]}</p>
                <div className="review-tabs">
                  <button className={reviewTab === 'changes' ? 'active' : ''} onClick={() => setReviewTab('changes')}>Changes</button>
                  <button className={reviewTab === 'discussion' ? 'active' : ''} onClick={() => setReviewTab('discussion')}>Discussion</button>
                </div>

                {reviewTab === 'changes' ? (<>
                <DiffBlock
                  label="Front"
                  before={fieldValue(selectedCard, 'Front')}
                  after={selectedSuggestion?.proposedFields.Front}
                />
                <DiffBlock
                  label="Back"
                  before={fieldValue(selectedCard, 'Back')}
                  after={selectedSuggestion?.proposedFields.Back}
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
                    <button className="button primary" disabled={busy || state.sync.conflicts.length > 0} onClick={() => activeDeck && refreshWith(api.ankiPush(activeDeck.id), 'Pushed accepted note updates', (value) => value.state)}>
                      <Icon name="sync" /> Push to Anki
                    </button>
                  </div>
                )}
                </>) : (
                  selectedSuggestion ? (
                    <SuggestionDiscussion
                      suggestionId={selectedSuggestion.id}
                      currentUserId={state.user?.id || 'you'}
                      currentUserName={state.user?.name || 'You'}
                    />
                  ) : <EmptyState message="Select a suggestion to view its discussion." />
                )}
              </section>
            ) : <EmptyState message="Select a card to review changes." />}

            <div className="queue-list">
              {queueSuggestions.length ? queueSuggestions.map((suggestion) => (
                <button
                  className={`queue-item ${suggestion.id === selectedSuggestion?.id ? 'active' : ''}`}
                  key={suggestion.id}
                  onClick={() => setSelectedSuggestionId(suggestion.id)}
                >
                  <span className="avatar">{initials(suggestion.authorName)}</span>
                  <span>
                    <strong>{suggestion.authorName}</strong>
                    <small>{relativeTime(suggestion.createdAt)}</small>
                  </span>
                  <b className={`queue-status ${suggestion.status}`}>{suggestion.status}</b>
                </button>
              )) : <EmptyState message="No suggestions match the queue filters." />}
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

      {notice ? <div className="toast">{notice}</div> : null}
      {busy ? <div className="busy-bar" /> : null}
      {showConnectWizard && (
        <ConnectAnkiWizard
          decks={state.summaries}
          platformUrl={window.location.origin}
          onClose={() => setShowConnectWizard(false)}
        />
      )}
      {showStudy && activeDeck && (
        <StudyView
          deckId={activeDeck.id}
          cards={studyCards}
          modeLabel={studyApprovedOnly ? 'Approved cards only' : 'All cards'}
          onClose={() => { setShowStudy(false); setActiveTab('overview'); }}
        />
      )}
    </main>
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

function StudyPrepView({
  totalCards,
  studyCards,
  approvedCards,
  pendingBlocked,
  approvedOnly,
  onApprovedOnlyChange,
  onStart
}: {
  totalCards: number;
  studyCards: number;
  approvedCards: number;
  pendingBlocked: number;
  approvedOnly: boolean;
  onApprovedOnlyChange: (value: boolean) => void;
  onStart: () => void;
}) {
  return (
    <div className="tab-panel study-prep">
      <div>
        <h2>Study session</h2>
        <p>Start a due-card session with local SM-2 progress and server sync when authentication is available.</p>
      </div>
      <div className="stat-grid compact">
        <div><small>Available now</small><strong>{studyCards.toLocaleString()}</strong></div>
        <div><small>Approved cards</small><strong>{approvedCards.toLocaleString()}</strong></div>
        <div><small>All cards</small><strong>{totalCards.toLocaleString()}</strong></div>
        <div><small>Pending review</small><strong>{pendingBlocked.toLocaleString()}</strong></div>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={approvedOnly}
          onChange={(event) => onApprovedOnlyChange(event.target.checked)}
        />
        <span>
          <strong>Study approved cards only</strong>
          <small>Excludes suspended cards and cards with pending owner-review suggestions.</small>
        </span>
      </label>
      <div className="panel-actions">
        <button className="button primary" onClick={onStart} disabled={studyCards === 0}>Start study session</button>
      </div>
    </div>
  );
}

function DeckStatsView({
  deck,
  summary,
  suggestions,
  filteredCount
}: {
  deck: Deck;
  summary?: DeckSummary;
  suggestions: { total: number; accepted: number; rejected: number; pending: number; revision: number; acceptanceRate: number };
  filteredCount: number;
}) {
  const stateCounts = deck.cards.reduce<Record<string, number>>((acc, card) => {
    acc[card.state] = (acc[card.state] || 0) + 1;
    return acc;
  }, {});
  const suspended = deck.cards.filter((card) => card.suspended).length;
  const noteTypes = summary?.noteTypes?.length ? summary.noteTypes : Array.from(new Set(deck.cards.map((card) => card.type)));

  return (
    <div className="tab-panel stats-view">
      <div>
        <h2>Deck stats</h2>
        <p>First-pass operational totals from the loaded deck state.</p>
      </div>
      <div className="stat-grid">
        <div><small>Cards</small><strong>{deck.cards.length.toLocaleString()}</strong></div>
        <div><small>Filtered cards</small><strong>{filteredCount.toLocaleString()}</strong></div>
        <div><small>Tags</small><strong>{summary?.tagCount.toLocaleString() ?? '0'}</strong></div>
        <div><small>Note types</small><strong>{noteTypes.length.toLocaleString()}</strong></div>
        <div><small>Suspended</small><strong>{suspended.toLocaleString()}</strong></div>
        <div><small>Acceptance rate</small><strong>{suggestions.acceptanceRate}%</strong></div>
      </div>
      <div className="stats-columns">
        <section>
          <h3>Card states</h3>
          {Object.entries(stateCounts).map(([state, count]) => (
            <div className="metric-row" key={state}>
              <span>{state}</span>
              <strong>{count.toLocaleString()}</strong>
            </div>
          ))}
        </section>
        <section>
          <h3>Suggestion flow</h3>
          <div className="metric-row"><span>Pending</span><strong>{suggestions.pending}</strong></div>
          <div className="metric-row"><span>Accepted</span><strong>{suggestions.accepted}</strong></div>
          <div className="metric-row"><span>Rejected</span><strong>{suggestions.rejected}</strong></div>
          <div className="metric-row"><span>Needs revision</span><strong>{suggestions.revision}</strong></div>
        </section>
        <section>
          <h3>Note types</h3>
          <div className="tag-list wide">
            {noteTypes.map((type) => <em key={type}>{type}</em>)}
          </div>
        </section>
      </div>
    </div>
  );
}

function DeckSettingsView({
  deck,
  visibility,
  canReview,
  embedCode,
  copiedShare,
  onCopied,
  onSetVisibility
}: {
  deck: Deck;
  visibility: string;
  canReview: boolean;
  embedCode: string;
  copiedShare: string;
  onCopied: (value: string) => void;
  onSetVisibility: (value: 'public' | 'private' | 'unlisted') => void;
}) {
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState('');
  const primaryShareLink = shareLinks.find((link) => !link.disabledAt) || shareLinks[0] || null;
  const primaryShareUrl = primaryShareLink ? shareLinkUrl(primaryShareLink.token) : '';

  useEffect(() => {
    if (!canReview) {
      setShareLinks([]);
      setShareError('');
      return;
    }
    let mounted = true;
    setShareLoading(true);
    setShareError('');
    api.shareLinks.list(deck.id)
      .then(({ shareLinks: links }) => {
        if (mounted) setShareLinks(links);
      })
      .catch((err) => {
        if (mounted) setShareError(err instanceof Error ? err.message : 'Unable to load share links');
      })
      .finally(() => {
        if (mounted) setShareLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [canReview, deck.id]);

  async function createShareLink() {
    setShareLoading(true);
    setShareError('');
    try {
      const { shareLink } = await api.shareLinks.create(deck.id, { label: `${deck.name} share link` });
      setShareLinks((links) => [shareLink, ...links]);
      const url = shareLinkUrl(shareLink.token);
      await copy(url, 'Share link created and copied');
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Unable to create share link');
    } finally {
      setShareLoading(false);
    }
  }

  async function copy(value: string, label: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      onCopied(label);
      window.setTimeout(() => onCopied(''), 1800);
    } catch {
      onCopied('Copy unavailable');
    }
  }

  return (
    <div className="tab-panel settings-view">
      <div>
        <h2>Deck settings</h2>
        <p>Manage collaboration visibility and prepare share surfaces for this deck.</p>
      </div>
      <div className="settings-grid">
        <section>
          <h3>Access</h3>
          <label className="settings-field">
            <span>Visibility</span>
            <select
              value={visibility}
              onChange={(event) => onSetVisibility(event.target.value as 'public' | 'private' | 'unlisted')}
              disabled={!canReview}
              aria-label="Deck visibility"
            >
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          {!canReview ? <p className="settings-note">Owner access is required to change visibility.</p> : null}
        </section>
        <section>
          <h3>Share link</h3>
          <div className="copy-row">
            <input readOnly value={primaryShareUrl} placeholder={shareLoading ? 'Loading share links...' : 'Create a tokenized share link'} aria-label="Deck share link" />
            <button className="button secondary" onClick={() => copy(primaryShareUrl, 'Share link copied')} disabled={!primaryShareUrl}>Copy</button>
          </div>
          <button className="button secondary" onClick={createShareLink} disabled={!canReview || shareLoading}>
            {primaryShareLink ? 'Create another share link' : 'Create share link'}
          </button>
          {shareError ? <p className="settings-note">{shareError}</p> : null}
          {!canReview ? <p className="settings-note">Owner access is required to create share links.</p> : null}
          <small>Share URLs use backend-generated tokens. Public access depends on the share route and backend availability.</small>
        </section>
        <section>
          <h3>Embed</h3>
          <textarea readOnly value={embedCode} aria-label="Deck embed code" rows={3} />
          <button className="button secondary" onClick={() => copy(embedCode, 'Embed code copied')}>Copy embed code</button>
          <small>Placeholder code for a future embeddable public preview route.</small>
        </section>
      </div>
      {copiedShare ? <div className="inline-notice">{copiedShare}</div> : null}
    </div>
  );
}
