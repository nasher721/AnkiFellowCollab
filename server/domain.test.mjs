import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySuggestion,
  createSeedState,
  deckToCreateDeckJson,
  normalizeSuggestionInput,
  normalizeParsedDeck,
  summarizeDeck
} from './domain.mjs';

test('normalizes parse-deck JSON into canonical cards', () => {
  const deck = normalizeParsedDeck({
    deck_name: 'Test Deck',
    deck_path: 'Parent::Test Deck',
    media: { 'image.png': 'image.png' },
    models: [{ name: 'Basic', fields: [{ name: 'Front', ordinal: 0 }, { name: 'Back', ordinal: 1 }] }],
    cards: [{ front: 'Question', back: 'Answer', type: 'Basic', tags: ['tag-a'], mediaRefs: ['image.png'] }]
  }, 'test.apkg');

  assert.equal(deck.name, 'Test Deck');
  assert.equal(deck.cards.length, 1);
  assert.equal(deck.cards[0].fields.Front, 'Question');
  assert.deepEqual(deck.cards[0].tags, ['tag-a']);
  assert.deepEqual(deck.cards[0].fieldOrder, ['Front', 'Back']);
  assert.deepEqual(deck.cards[0].mediaRefs, ['image.png']);
  assert.equal(deck.cards[0].sourceDeckPath, 'Parent::Test Deck');
  assert.equal(deck.models.length, 1);
});

test('accepted suggestion changes canonical card and preserves pending queue separately', () => {
  const state = createSeedState();
  const deck = state.decks[0];
  const suggestion = state.suggestions[0];
  applySuggestion(deck, suggestion, 'You');

  const card = deck.cards.find((item) => item.id === suggestion.cardId);
  assert.match(card.fields.Front, /ANCA autoantibody/);
  assert.deepEqual(card.tags, ['Rheumatology', 'Vasculitis', 'Step2']);
});

test('summarizes deck health for dashboard metrics', () => {
  const state = createSeedState();
  const summary = summarizeDeck(state.decks[0], state.suggestions);
  assert.equal(summary.pendingSuggestions, 1);
  assert.equal(summary.cardCount, 4);
  assert.ok(summary.tagCount >= 3);
});

test('exports create-deck compatible JSON', () => {
  const state = createSeedState();
  const payload = deckToCreateDeckJson(state.decks[0]);
  assert.equal(payload.deck_name, 'Zanki Step 2 CK');
  assert.equal(payload.cards[0].front, 'Microscopic polyangiitis is most strongly associated with which autoantibody?');
  assert.equal(payload.cards[0].model_name, 'Basic');
  assert.deepEqual(payload.cards[0].field_order, ['Front', 'Back']);
});

test('normalizes suggestion input and rejects empty no-op suggestions', () => {
  const state = createSeedState();
  const card = state.decks[0].cards[0];

  const normalized = normalizeSuggestionInput({
    reason: '  tighter wording  ',
    proposedFields: { Front: 'Updated front', Extra: null },
    proposedTags: ['Step2', 'Step2', ' Vasculitis ']
  }, card);

  assert.equal(normalized.reason, 'tighter wording');
  assert.deepEqual(normalized.proposedTags, ['Step2', 'Vasculitis']);
  assert.equal(normalized.proposedFields.Extra, '');

  assert.throws(() => normalizeSuggestionInput({ proposedFields: {}, proposedTags: card.tags }, card), /Suggestion must/);
});
