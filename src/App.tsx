import { useMemo, useState, useEffect, useCallback } from 'react';
import { api } from './api';
import type { AiArtifact, AppState, Deck, DeckCard, Suggestion } from './types';
import {
  type Toast, type SyncHealth, type OwnerAttentionItem, type WorkbenchRailKind,
  initials, relativeTime, fieldValue, statusColors, supabase,
} from './hooks/common';
import { useDeckOperations } from './hooks/useDeckOperations';
import { useReviewQueue } from './hooks/useReviewQueue';
import { useSyncState } from './hooks/useSyncState';
import { useRealtime } from './useRealtime';
import { ConnectAnkiWizard } from './ConnectAnkiWizard';
import { CardVirtualList } from './CardVirtualList';
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
export { authMessage, deriveOwnerAttentionItems, deriveSyncHealth, deriveWorkbenchRail, mergeHydratedDeckState, stateFromMeResponse, withAuthTimeout } from './hooks/common';
export type { OwnerAttentionItem, OwnerReviewQueueItem, SyncHealth, WorkbenchRailKind, WorkbenchTab } from './hooks/common';
import { Icon } from './components/Icon';
import { AuthScreen } from './components/AuthScreen';
import { EmptyState } from './components/EmptyState';
import { SyncHealthStrip } from './components/SyncHealthStrip';
import { OwnerAttentionPanel } from './components/OwnerAttentionPanel';
import { WorkbenchLayout } from './components/WorkbenchLayout';
import { OverviewRail } from './components/OverviewRail';
import { CardRail } from './components/CardRail';
import { ReviewRiskBadge } from './components/ReviewRiskBadge';
import { ReviewQualitySummary } from './components/ReviewQualitySummary';
import { ReviewQueueList } from './components/ReviewQueueList';
import { ReviewDecisionBar } from './components/ReviewDecisionBar';
import { ReviewInspectionPanel } from './components/ReviewInspectionPanel';
import { ReviewWorkspace } from './components/ReviewWorkspace';
import { ModelTemplateEditor } from './components/ModelTemplateEditor';
import { ToastStack } from './components/ToastStack';
import { DiffBlock } from './components/DiffBlock';
import { CardPreviewComparison } from './components/CardPreviewComparison';
import { ChangedFieldRows } from './components/ChangedFieldRows';

export default function App() {
  const deckOps = useDeckOperations();
  const {
    state, setState, activeDeck, activeSummary, isDevDemo, membershipRole, canReview, canManageDeck, canSuggest,
    session, authReady, authMode, authEmail, authPassword, authBusy, authNotice,
    activeSyncConflicts, pendingConflictIds,
    suggestions, pendingSuggestions, reviewAuthors,
    allTags, cardStates, filteredCards, maxPage, safePage, pagedCards,
    currentStart, currentEnd, cardsWithPendingSuggestions,
    approvedStudyCards, studyCards, closeStudyView, suggestionStats,
    duplicateCountsByCard,
    activeDeckVisibility, deckEmbedCode,
    addonPackage, apiHealth, busy, setBusy, deckLoading,
    page, pageSize, queryInput, tagFilter, cardStateFilter, draftReason,
    qualityPulse, qualityPulseBusy, duplicateLinks, embeddingBusy,
    conflictReviewSnapshot, deckVisibility, copiedShare,
    selectedCardId, selectedSuggestionId, selectedOwnerQueueItemId,
    selectedSuggestionIds, selectedCardIds,
    toasts, commentsVersion,
    reviewTab, reviewRiskFilter, reviewStatusFilter, reviewAuthorFilter,
    sourceCheckByReviewItem, suggestionBriefs, briefBusy,
    showConnectWizard, editingCardId, bulkAction, bulkTagInput,
    activeTab, showStudy, studyApprovedOnly, topView, darkMode,
    overviewTabRef, suggestionImportRef,
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
    handleSyncAction, handleOwnerAttentionAction,
    setAuthMode, setAuthEmail, setAuthPassword,
    setSelectedCardId, setSelectedSuggestionId, setSelectedOwnerQueueItemId,
    setSelectedSuggestionIds, setQueryInput, setTagFilter, setCardStateFilter,
    setDraftReason, setPage, setPageSize, setShowConnectWizard,
    setReviewTab, setReviewRiskFilter, setReviewStatusFilter, setReviewAuthorFilter,
    setSourceCheckByReviewItem, setActiveTab, setShowStudy, setStudyApprovedOnly,
    setTopView, setDarkMode, setEditingCardId, setSelectedCardIds,
    setBulkAction, setBulkTagInput, setConflictReviewSnapshot, setCopiedShare,
    setDeckVisibility, retainConflictReviewSnapshot,
  } = deckOps;

  const reviewQueue = useReviewQueue(state, activeDeck, suggestions, activeSyncConflicts, qualityPulse, selectedOwnerQueueItemId, selectedSuggestionId, selectedCardId, duplicateLinks, conflictReviewSnapshot, reviewRiskFilter, reviewStatusFilter, reviewAuthorFilter, suggestionBriefs);
  const {
    ownerReviewQueue, reviewBucketCounts, queueItems,
    selectedOwnerQueueItem, selectedSuggestion, selectedConflict,
    selectedCard, selectedSuggestionBrief, selectedDuplicateLinks,
  } = reviewQueue;

  const syncState = useSyncState(state, activeDeck, addonPackage, apiHealth, canReview, pendingSuggestions.length, qualityPulse, studyCards.length, activeDeckVisibility, activeTab);
  const {
    syncHealth, changedCards, activeRail, ownerAttentionItems,
  } = syncState;

  useRealtime({
    supabase,
    deckId: activeDeck?.id,
    onSuggestionChange: handleSuggestionChange,
    onCommentChange: handleCommentChange,
    onCardChange: (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') {
        refreshActiveDeckState();
      }
    },
    enabled: !!session,
  });
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
              refreshState();
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
              refreshState();
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
                activeBucket={reviewRiskFilter as ReviewBucket}
                onBucketChange={(bucket: ReviewBucket) => {
                  setReviewRiskFilter(bucket);
                  setSelectedOwnerQueueItemId(null);
                }}
                statusFilter={reviewStatusFilter as 'pending' | 'accepted' | 'rejected' | 'revision' | 'all'}
                onStatusFilterChange={(status: 'pending' | 'accepted' | 'rejected' | 'revision' | 'all') => {
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

              <CardVirtualList deckId={activeDeck.id} onCardSelect={setSelectedCardId} selectedCardId={selectedCardId ?? undefined} />
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


