import type { DeckCard, Suggestion } from '../types';
import { relativeTime, fieldValue, statusColors } from '../hooks/common';
import { renderCardHtml, AnkiCardRenderer } from '../AnkiCardRenderer';

export function CardRail({
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
