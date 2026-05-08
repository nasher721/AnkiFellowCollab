import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AnkiCardRenderer, buildAnkiCardDocument, renderCardHtml } from './AnkiCardRenderer';
import type { DeckCard } from './types';

function card(overrides: Partial<DeckCard> = {}): DeckCard {
  return {
    id: 'card-1',
    ankiNoteId: 101,
    type: 'Card 1',
    modelName: 'Basic',
    fieldOrder: ['Front', 'Back', 'Extra', 'Text'],
    fields: {
      Front: 'What is <b>AVM</b>?',
      Back: 'Arteriovenous malformation',
      Extra: 'High-flow lesion',
      Text: 'A {{c1::ruptured AVM}} can cause {{c2::lobar hemorrhage::bleeding}}.'
    },
    tags: ['neuro', 'vascular'],
    due: null,
    state: 'new',
    modifiedAt: '2026-05-08T00:00:00.000Z',
    modifiedBy: 'tester',
    suspended: false,
    mediaRefs: [],
    sourceDeckName: 'Boards::Neuro ICU',
    sourceDeckPath: 'Boards::Neuro ICU',
    templateFront: '{{Front}}',
    templateBack: '{{FrontSide}}<hr id="answer">{{Back}}',
    modelCss: '.card { color: navy; }',
    clozeOrd: 0,
    ...overrides
  };
}

let mountedRoots: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mountedRoots) unmount();
  mountedRoots = [];
});

describe('renderCardHtml', () => {
  it('renders Basic card fronts and backs with FrontSide', () => {
    const deckCard = card();
    const front = renderCardHtml(deckCard, 'deck-a', 'front', undefined, deckCard.clozeOrd);
    const back = renderCardHtml(deckCard, 'deck-a', 'back', front, deckCard.clozeOrd);

    expect(front).toBe('What is <b>AVM</b>?');
    expect(back).toContain('What is <b>AVM</b>?');
    expect(back).toContain('<hr id="answer">');
    expect(back).toContain('Arteriovenous malformation');
    expect(back).not.toContain('{{FrontSide}}');
  });

  it('handles conditional and inverse sections using resolved field truthiness', () => {
    const withExtra = card({
      templateFront: '{{#Extra}}<aside>{{Extra}}</aside>{{/Extra}}{{^Missing}}<em>No missing field</em>{{/Missing}}'
    });
    const withoutExtra = card({
      fields: { Front: 'Prompt', Back: 'Answer', Extra: '' },
      templateFront: '{{#Extra}}<aside>{{Extra}}</aside>{{/Extra}}{{^Extra}}<em>No extra</em>{{/Extra}}'
    });

    expect(renderCardHtml(withExtra, 'deck-a', 'front')).toContain('<aside>High-flow lesion</aside>');
    expect(renderCardHtml(withExtra, 'deck-a', 'front')).toContain('<em>No missing field</em>');
    expect(renderCardHtml(withoutExtra, 'deck-a', 'front')).toBe('<em>No extra</em>');
  });

  it('applies text, hint, type, and unknown filters without corrupting field content', () => {
    const deckCard = card({
      templateFront: '{{text:Front}}|{{hint:Back}}|{{type:Front}}|{{unknown:Back}}',
      templateBack: '{{type:Back}}'
    });
    const front = renderCardHtml(deckCard, 'deck-a', 'front');
    const back = renderCardHtml(deckCard, 'deck-a', 'back');

    expect(front).toContain('What is AVM?');
    expect(front).toContain('Show Back');
    expect(front).toContain('style="display:none"');
    expect(front).toContain('Arteriovenous malformation');
    expect(front).toContain('class="type-answer"');
    expect(front).toContain('data-answer="What is AVM?"');
    expect(back).toBe('<div class="type-answer type-answer-back">Arteriovenous malformation</div>');
  });

  it('renders special Anki fields from DeckBridge card metadata', () => {
    const deckCard = card({
      templateFront: '{{Tags}}|{{Type}}|{{Deck}}|{{Subdeck}}|{{Card}}'
    });

    expect(renderCardHtml(deckCard, 'deck-a', 'front')).toBe('neuro vascular|Basic|Boards::Neuro ICU|Neuro ICU|Card 1');
  });

  it('rewrites image and sound media references after template rendering', () => {
    const deckCard = card({
      fields: {
        Front: '<img src="media/brain scan.png?cache=1"> [sound:audio/review.mp3]',
        Back: 'Answer'
      },
      templateFront: '{{Front}}'
    });
    const front = renderCardHtml(deckCard, 'deck-a', 'front');

    expect(front).toContain('src="/api/decks/deck-a/media/brain%20scan.png"');
    expect(front).toContain('<audio controls="" preload="none" src="/api/decks/deck-a/media/review.mp3"></audio>');
  });

  it('renders the active cloze ordinal on the front and back while leaving non-active deletions visible', () => {
    const deckCard = card({
      clozeOrd: 1,
      templateFront: '{{cloze:Text}}',
      templateBack: '{{cloze:Text}}'
    });

    const front = renderCardHtml(deckCard, 'deck-a', 'front');
    const back = renderCardHtml(deckCard, 'deck-a', 'back');

    expect(front).toContain('A ruptured AVM can cause <span class="cloze">[bleeding]</span>.');
    expect(back).toContain('A ruptured AVM can cause <span class="cloze">lobar hemorrhage</span>.');
    expect(front).not.toContain('{{c');
    expect(back).not.toContain('{{c');
  });

  it('uses cloze ordinal zero for the first deletion', () => {
    const deckCard = card({
      clozeOrd: 0,
      templateFront: '{{cloze:Text}}',
      templateBack: '{{cloze:Text}}'
    });

    expect(renderCardHtml(deckCard, 'deck-a', 'front', undefined, deckCard.clozeOrd)).toContain('<span class="cloze">[...]</span> can cause lobar hemorrhage.');
    expect(renderCardHtml(deckCard, 'deck-a', 'back', undefined, deckCard.clozeOrd)).toContain('<span class="cloze">ruptured AVM</span> can cause lobar hemorrhage.');
  });
});

describe('AnkiCardRenderer iframe document', () => {
  it('includes Anki base CSS, model CSS, and rendered card HTML in the iframe document', () => {
    const htmlDoc = buildAnkiCardDocument('<strong>Prompt</strong>', '.card { color: rgb(12, 34, 56); }');
    const parsed = new DOMParser().parseFromString(htmlDoc, 'text/html');
    const styleText = parsed.querySelector('style')?.textContent ?? '';

    expect(styleText).toContain('font-family: arial');
    expect(styleText).toContain('color: rgb(12, 34, 56)');
    expect(parsed.body.className).toBe('card');
    expect(parsed.body.innerHTML.trim()).toBe('<strong>Prompt</strong>');
  });

  it('writes model CSS into the iframe so browser CSS application is isolated to the card body', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(() => {
      root.unmount();
      host.remove();
    });

    await act(async () => {
      root.render(createElement(AnkiCardRenderer, {
        card: card({
          templateFront: '<span class="anki-css-proof">{{Front}}</span>',
          modelCss: '.card { color: rgb(10, 20, 30); } .anki-css-proof { font-weight: 700; }'
        }),
        deckId: 'deck-a',
        side: 'front'
      }));
    });

    const iframe = host.querySelector('iframe');
    expect(iframe).toBeTruthy();
    const iframeDocument = iframe?.contentDocument;
    expect(iframeDocument?.body.textContent).toContain('What is AVM?');
    expect(iframeDocument?.querySelector('style')?.textContent).toContain('.anki-css-proof');
    expect(iframeDocument?.defaultView?.getComputedStyle(iframeDocument.body).color).toBe('rgb(10, 20, 30)');
    expect(iframeDocument?.defaultView?.getComputedStyle(iframeDocument.querySelector('.anki-css-proof')!).fontWeight).toBe('700');
  });
});
