import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  normalizeParsedDeck,
  normalizeSuggestionInput,
  normalizeAddonSyncInput,
  mergeAddonCards,
  tagList,
  cleanText,
  summarizeDeck,
  createSeedState
} from './domain.mjs';

test('tagList splits strings and filters empty', () => {
  assert.deepEqual(tagList('a b  c'), ['a', 'b', 'c']);
  assert.deepEqual(tagList(['x', '', 'y']), ['x', 'y']);
  assert.deepEqual(tagList(null), []);
});

test('cleanText trims and truncates', () => {
  assert.equal(cleanText('  hello  '), 'hello');
  assert.equal(cleanText(null, 'fallback'), 'fallback');
  const long = 'a'.repeat(5000);
  assert.equal(cleanText(long).length, 4000);
});

test('normalizeParsedDeck handles empty cards', () => {
  const deck = normalizeParsedDeck({ cards: [] }, 'test.apkg');
  assert.equal(deck.name, 'test');
  assert.equal(deck.cards.length, 0);
});

test('normalizeParsedDeck generates IDs for cards without them', () => {
  const deck = normalizeParsedDeck({ cards: [{ front: 'Q', back: 'A' }] });
  assert.ok(deck.cards[0].id);
  assert.ok(deck.cards[0].id.startsWith('card-'));
});

test('normalizeAddonSyncInput validates card count', () => {
  assert.throws(() => normalizeAddonSyncInput({ cards: [] }), /must include cards/);
  const big = { cards: new Array(50001).fill({ fields: { F: 'x' } }) };
  assert.throws(() => normalizeAddonSyncInput(big), /50000-card limit/);
});

test('normalizeAddonSyncInput defaults conflictPolicy to detect', () => {
  const result = normalizeAddonSyncInput({ cards: [{ fields: { Front: 'test' } }] });
  assert.equal(result.conflictPolicy, 'detect');
});

test('normalizeAddonSyncInput expands compressed fields without truncating', () => {
  const field = '<section>high-yield neuro ICU explanation</section>'.repeat(500);
  const bytes = Buffer.from(field, 'utf8');
  const result = normalizeAddonSyncInput({
    returnState: false,
    cards: [{
      fields: { Text: '', Extra: 'board pearl' },
      compressedFields: {
        Text: {
          encoding: 'zlib+base64',
          data: deflateSync(bytes).toString('base64'),
          originalBytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }
      }
    }]
  });

  assert.equal(result.returnState, false);
  assert.equal(result.cards[0].fields.Text, field);
  assert.equal(result.cards[0].fields.Extra, 'board pearl');
  assert.equal(result.cards[0].fields.Text.length > 12000, true);
});

test('mergeAddonCards creates new cards', () => {
  const deck = { cards: [], lastSyncedAt: null };
  const result = mergeAddonCards(deck, {
    cards: [{ id: 'c1', fields: { Front: 'Hello' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], ankiNoteId: null, due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test', sourceDeckName: null, sourceDeckPath: null }],
    dryRun: false,
    allowCreate: true,
    conflictPolicy: 'overwrite-platform',
    source: 'test'
  });
  assert.equal(result.stats.created, 1);
  assert.equal(deck.cards.length, 1);
});

test('mergeAddonCards detects conflicts in detect mode', () => {
  const deck = { cards: [{ id: 'c1', ankiNoteId: 1, fields: { Front: 'Old' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' }], lastSyncedAt: null };
  const result = mergeAddonCards(deck, {
    cards: [{ id: 'c1', ankiNoteId: 1, fields: { Front: 'New' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test', sourceDeckName: null, sourceDeckPath: null }],
    dryRun: false,
    allowCreate: true,
    conflictPolicy: 'detect',
    source: 'test'
  });
  assert.equal(result.stats.conflicts, 1);
  assert.equal(result.conflicts[0].cardId, 'c1');
});

test('mergeAddonCards refreshes Anki rendering metadata in detect mode without content conflicts', () => {
  const deck = { cards: [{ id: 'c1', ankiNoteId: 1, fields: { Front: 'Same' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' }], lastSyncedAt: null };
  const result = mergeAddonCards(deck, {
    cards: [{ id: 'c1', ankiNoteId: 1, fields: { Front: 'Same' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], ankiNoteId: 1, due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test', sourceDeckName: null, sourceDeckPath: null, templateFront: '<section>{{Front}}</section>', templateBack: '<section>{{Back}}</section>', modelCss: '.card { color: white; }', renderedFront: '<section>Same</section>' }],
    dryRun: false,
    allowCreate: true,
    conflictPolicy: 'detect',
    source: 'test'
  });
  assert.equal(result.stats.conflicts, 0);
  assert.equal(result.stats.updated, 1);
  assert.equal(deck.cards[0].modelCss, '.card { color: white; }');
  assert.equal(deck.cards[0].renderedFront, '<section>Same</section>');
});

test('mergeAddonCards overwrites in overwrite-platform mode', () => {
  const deck = { cards: [{ id: 'c1', ankiNoteId: 1, fields: { Front: 'Old' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' }], lastSyncedAt: null };
  const result = mergeAddonCards(deck, {
    cards: [{ id: 'c1', ankiNoteId: 1, fields: { Front: 'New' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test', sourceDeckName: null, sourceDeckPath: null }],
    dryRun: false,
    allowCreate: true,
    conflictPolicy: 'overwrite-platform',
    source: 'test'
  });
  assert.equal(result.stats.updated, 1);
  assert.equal(deck.cards[0].fields.Front, 'New');
});

test('mergeAddonCards matches same note by template ordinal without collapsing sibling cards', () => {
  const deck = {
    cards: [
      { id: 'anki-101-0', ankiNoteId: 101, clozeOrd: 0, fields: { Front: 'Old front' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' },
      { id: 'anki-101-1', ankiNoteId: 101, clozeOrd: 1, fields: { Front: 'Old back' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' }
    ],
    lastSyncedAt: null
  };

  const result = mergeAddonCards(deck, {
    cards: [
      { id: 'anki-101-0', ankiNoteId: 101, clozeOrd: 0, fields: { Front: 'New front' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' },
      { id: 'anki-101-1', ankiNoteId: 101, clozeOrd: 1, fields: { Front: 'New back' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' }
    ],
    dryRun: false,
    allowCreate: true,
    conflictPolicy: 'overwrite-platform',
    source: 'test'
  });

  assert.equal(result.stats.updated, 2);
  assert.equal(result.stats.created, 0);
  assert.equal(deck.cards.length, 2);
  assert.equal(deck.cards.find((card) => card.id === 'anki-101-0').fields.Front, 'New front');
  assert.equal(deck.cards.find((card) => card.id === 'anki-101-1').fields.Front, 'New back');
});

test('mergeAddonCards updates legacy note-only card for ordinal zero and creates later ordinals', () => {
  const deck = {
    cards: [
      { id: 'anki-202', ankiNoteId: 202, fields: { Front: 'Legacy front' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' }
    ],
    lastSyncedAt: null
  };

  const result = mergeAddonCards(deck, {
    cards: [
      { id: 'anki-202-0', ankiNoteId: 202, clozeOrd: 0, fields: { Front: 'Ordinal zero' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' },
      { id: 'anki-202-1', ankiNoteId: 202, clozeOrd: 1, fields: { Front: 'Ordinal one' }, tags: [], type: 'Basic', modelName: 'Basic', fieldOrder: ['Front'], due: null, state: 'New', suspended: false, mediaRefs: [], modifiedAt: new Date().toISOString(), modifiedBy: 'test' }
    ],
    dryRun: false,
    allowCreate: true,
    conflictPolicy: 'overwrite-platform',
    source: 'test'
  });

  assert.equal(result.stats.updated, 1);
  assert.equal(result.stats.created, 1);
  assert.equal(deck.cards.length, 2);
  assert.equal(deck.cards.find((card) => card.id === 'anki-202').fields.Front, 'Ordinal zero');
  assert.equal(deck.cards.find((card) => card.id === 'anki-202-1').fields.Front, 'Ordinal one');
});

test('summarizeDeck counts tags and note types', () => {
  const state = createSeedState();
  const summary = summarizeDeck(state.decks[0]);
  assert.ok(summary.tagCount >= 3);
  assert.ok(summary.noteTypes.length >= 2);
});
