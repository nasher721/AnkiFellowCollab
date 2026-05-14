import type { DeckCard, Deck, Suggestion, AiArtifact, AppState } from '../types';
import { fieldValue } from '../hooks/common';
import type { QualityReviewItem } from '../reviewModel';
import { reviewCardPrompt, hasRenderFallback } from './reviewHelpers';
import { AnkiCardRenderer, renderCardHtml } from '../AnkiCardRenderer';
import { ReviewRiskBadge } from './ReviewRiskBadge';
import { ReviewDecisionBar } from './ReviewDecisionBar';
import { CardPreviewComparison } from './CardPreviewComparison';
import { ChangedFieldRows } from './ChangedFieldRows';
import { EmptyState } from './EmptyState';
import { SuggestionDiscussion } from '../SuggestionDiscussion';

export function ReviewInspectionPanel({
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
