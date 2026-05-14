import { useMemo, useState, useEffect } from 'react';
import type { Deck, DeckCard } from '../types';
import { fieldValue } from '../hooks/common';
import { renderCardHtml, AnkiCardRenderer } from '../AnkiCardRenderer';
import { EmptyState } from './EmptyState';

export function ModelTemplateEditor({ deck, busy, onSave }: {
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
