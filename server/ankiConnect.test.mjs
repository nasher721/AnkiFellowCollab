import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const { pullDeck } = await import('./ankiConnect.mjs');

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('pullDeck includes Anki templates, styling, and rendered card HTML', async () => {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request.action);
    const payloads = {
      findNotes: [101],
      notesInfo: [{
        noteId: 101,
        modelName: 'Basic-AnKing',
        tags: ['neuro'],
        cards: [201],
        fields: {
          Front: { value: 'Prompt', order: 0 },
          Back: { value: 'Answer', order: 1 }
        }
      }],
      cardsInfo: [{
        cardId: 201,
        note: 101,
        ord: 0,
        modelName: 'Basic-AnKing',
        deckName: 'Neuro ICU Boards::Vignette',
        fields: {
          Front: { value: 'Prompt', order: 0 },
          Back: { value: 'Answer', order: 1 }
        },
        question: '<section id="front-section">Prompt</section>',
        answer: '<section id="back"><b>Answer</b></section>',
        css: '.card { color: white; }',
        due: 10,
        queue: 2,
        type: 2
      }],
      modelTemplates: {
        'Card 1': {
          Front: '<section id="front-section">{{edit:Front}}</section>',
          Back: '<section id="back">{{edit:Back}}</section>'
        }
      },
      modelStyling: { css: '.card { color: yellow; }' }
    };
    return Response.json({ result: payloads[request.action], error: null });
  };

  const cards = await pullDeck('Neuro ICU Boards');

  assert.deepEqual(calls, ['findNotes', 'notesInfo', 'cardsInfo', 'modelTemplates', 'modelStyling']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'anki-101-0');
  assert.equal(cards[0].templateFront, '<section id="front-section">{{edit:Front}}</section>');
  assert.equal(cards[0].templateBack, '<section id="back">{{edit:Back}}</section>');
  assert.equal(cards[0].modelCss, '.card { color: white; }');
  assert.equal(cards[0].renderedFront, '<section id="front-section">Prompt</section>');
  assert.equal(cards[0].renderedBack, '<section id="back"><b>Answer</b></section>');
  assert.deepEqual(cards[0].fieldOrder, ['Front', 'Back']);
  assert.equal(cards[0].state, 'Review');
});
