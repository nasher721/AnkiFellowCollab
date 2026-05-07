import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySuggestion,
  createSeedState,
  deckToCreateDeckJson,
  mergeAddonCards,
  normalizeAddonDeckCreateInput,
  normalizeAddonSyncInput,
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

test('normalizes add-on sync media payloads and bounds asset count', () => {
  const dataBase64 = Buffer.from('png-bytes').toString('base64');
  const input = normalizeAddonSyncInput({
    cards: [{ id: 'anki-1', fields: { Front: '<img src="image.png">', Back: '[sound:audio.mp3]' } }],
    media: {
      'image.png': { filename: ' image.png ', mimeType: 'image/png', sha256: 'a'.repeat(64), dataBase64 },
      'skip.txt': { filename: 'skip.txt', mimeType: 'text/plain', sha256: '', dataBase64: 'not base64!' },
      ...Object.fromEntries(Array.from({ length: 310 }, (_, index) => [
        `extra-${index}.png`,
        { filename: `extra-${index}.png`, mimeType: 'image/png', sha256: 'b'.repeat(64), dataBase64 }
      ]))
    }
  });

  assert.equal(input.cards[0].fields.Front, '<img src="image.png">');
  assert.equal(input.media['image.png'].mimeType, 'image/png');
  assert.equal(input.media['image.png'].dataBase64, dataBase64);
  assert.equal(input.media['skip.txt'], undefined);
  assert.equal(Object.keys(input.media).length <= 300, true);
});

test('add-on deck creation persists normalized sync media on the new deck', () => {
  const dataBase64 = Buffer.from('audio-bytes').toString('base64');
  const { deck } = normalizeAddonDeckCreateInput({
    deckName: 'Media Deck',
    cards: [{ id: 'anki-1', fields: { Front: '[sound:clip.mp3]' } }],
    media: {
      'clip.mp3': { mimeType: 'audio/mpeg', sha256: 'c'.repeat(64), dataBase64 }
    }
  }, { name: 'User' });

  assert.equal(deck.media['clip.mp3'].filename, 'clip.mp3');
  assert.equal(deck.media['clip.mp3'].mimeType, 'audio/mpeg');
  assert.equal(deck.media['clip.mp3'].dataBase64, dataBase64);
});

test('add-on sync merges media into deck only when not dry-run', () => {
  const deck = createSeedState().decks[0];
  const dataBase64 = Buffer.from('png-bytes').toString('base64');

  const dryRunInput = normalizeAddonSyncInput({
    dryRun: true,
    cards: [{ id: 'anki-media-1', fields: { Front: '<img src="image.png">' } }],
    media: {
      'image.png': { mimeType: 'image/png', sha256: 'd'.repeat(64), dataBase64 }
    }
  });
  mergeAddonCards(deck, dryRunInput, 'Tester');
  assert.equal(deck.media['image.png'], undefined);

  const syncInput = normalizeAddonSyncInput({
    conflictPolicy: 'overwrite-platform',
    cards: [{ id: 'anki-media-1', fields: { Front: '<img src="image.png">' } }],
    media: {
      'image.png': { mimeType: 'image/png', sha256: 'd'.repeat(64), dataBase64 }
    }
  });
  mergeAddonCards(deck, syncInput, 'Tester');

  assert.equal(deck.media['image.png'].mimeType, 'image/png');
  assert.equal(deck.media['image.png'].dataBase64, dataBase64);
});
