import { useMemo } from 'react';
import type { DeckCard } from '../types';
import { renderCardHtml, AnkiCardRenderer } from '../AnkiCardRenderer';
import { hasRenderFallback } from './reviewHelpers';

export function CardPreviewComparison({ currentCard, proposedCard, deckId, hasSuggestion }: {
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
