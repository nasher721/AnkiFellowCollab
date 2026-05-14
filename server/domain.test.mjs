import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  applySuggestion,
  canonicalCardInputHash,
  canonicalCardText,
  createSeedState,
  deckToCreateDeckJson,
  mergeAddonCards,
  normalizeAddonDeckCreateInput,
  normalizeAddonSyncInput,
  normalizeMediaUploadFiles,
  normalizeSuggestionInput,
  normalizeParsedDeck,
  snapshotCard,
  summarizeDeck
} from './domain.mjs';

function mediaAsset(bytes, mimeType = 'image/png') {
  return {
    mimeType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    dataBase64: bytes.toString('base64')
  };
}

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

test('canonical card text preserves ordered content while bounding embedding input', () => {
  const card = {
    id: 'card-canonical',
    type: 'Basic',
    modelName: 'Basic',
    fieldOrder: ['Front', 'Back'],
    fields: {
      Back: 'Answer with\nline breaks',
      Front: 'Question '.repeat(20),
      Extra: 'E'.repeat(5000)
    },
    tags: ['TagA', 'TagB'],
    state: 'Review'
  };

  const text = canonicalCardText(card, { maxFieldChars: 200, maxTotalChars: 20000 });
  assert.match(text, /Card ID: card-canonical/);
  assert.ok(text.indexOf('Front:') < text.indexOf('Back:'));
  assert.match(text, /Question Question/);
  assert.match(text, /Field truncated/);
  assert.ok(text.length < 1000);
  assert.match(canonicalCardInputHash(card), /^[a-f0-9]{64}$/);
  assert.equal(canonicalCardInputHash(card), canonicalCardInputHash({ ...card }));
});

test('normalizes add-on sync media payloads and bounds asset count', () => {
  const bytes = Buffer.from('png-bytes');
  const asset = mediaAsset(bytes);
  const input = normalizeAddonSyncInput({
    cards: [{ id: 'anki-1', fields: { Front: '<img src="image.png">', Back: '[sound:audio.mp3]' } }],
    media: {
      'image.png': { filename: ' image.png ', ...asset },
      'skip.txt': { filename: 'skip.txt', mimeType: 'text/plain', sha256: '', dataBase64: 'not base64!' },
      ...Object.fromEntries(Array.from({ length: 310 }, (_, index) => [
        `extra-${index}.png`,
        { filename: `extra-${index}.png`, ...asset }
      ]))
    }
  });

  assert.equal(input.cards[0].fields.Front, '<img src="image.png">');
  assert.equal(input.media['image.png'].mimeType, 'image/png');
  assert.equal(input.media['image.png'].dataBase64, bytes.toString('base64'));
  assert.equal(input.media['skip.txt'], undefined);
  assert.equal(Object.keys(input.media).length <= 300, true);
});

test('normalizes add-on sync media uploaded through storage metadata', () => {
  const sha = 'a'.repeat(64);
  const input = normalizeAddonSyncInput({
    cards: [{ id: 'anki-storage-1', fields: { Front: '<img src="large.png">' }, mediaRefs: ['large.png'] }],
    media: {
      'large.png': {
        filename: 'large.png',
        mimeType: 'image/png',
        sha256: sha,
        sizeBytes: 12_000_000,
        storageBucket: 'deckbridge-media',
        storagePath: `deck-demo-zanki/${sha}/large.png`
      }
    }
  });

  assert.equal(input.media['large.png'].sha256, sha);
  assert.equal(input.media['large.png'].sizeBytes, 12_000_000);
  assert.equal(input.media['large.png'].storageBucket, 'deckbridge-media');
  assert.equal(input.media['large.png'].storagePath, `deck-demo-zanki/${sha}/large.png`);
  assert.equal(input.media['large.png'].dataBase64, undefined);
});

test('normalizes large media upload target requests', () => {
  const files = normalizeMediaUploadFiles([
    { filename: 'large image.png', mimeType: 'image/png', sha256: 'b'.repeat(64), sizeBytes: 20_000_000 },
    { filename: '../skip.png', mimeType: 'image/png', sha256: 'c'.repeat(64), sizeBytes: 20_000_000 },
    { filename: 'bad-sha.png', mimeType: 'image/png', sha256: 'bad', sizeBytes: 20_000_000 }
  ]);

  assert.deepEqual(files, [{
    filename: 'large image.png',
    mimeType: 'image/png',
    sha256: 'b'.repeat(64),
    sizeBytes: 20_000_000
  }]);
});

test('normalizes add-on sync media by dropping unsafe filenames and mismatched hashes', () => {
  const bytes = Buffer.from('png-bytes');
  const input = normalizeAddonSyncInput({
    cards: [{ id: 'anki-1', fields: { Front: '<img src="image.png">' } }],
    media: {
      '../evil.png': { filename: '../evil.png', ...mediaAsset(bytes) },
      'nested/evil.png': { filename: 'nested/evil.png', ...mediaAsset(bytes) },
      'bad-sha.png': { filename: 'bad-sha.png', ...mediaAsset(bytes), sha256: '0'.repeat(64) },
      'unsafe.html': { filename: 'unsafe.html', ...mediaAsset(bytes, 'text/html') },
      'safe.png': { filename: 'safe.png', ...mediaAsset(bytes) }
    }
  });

  assert.equal(input.media['../evil.png'], undefined);
  assert.equal(input.media['nested/evil.png'], undefined);
  assert.equal(input.media['bad-sha.png'], undefined);
  assert.equal(input.media['unsafe.html'].mimeType, 'application/octet-stream');
  assert.equal(input.media['safe.png'].sha256, mediaAsset(bytes).sha256);
});

test('add-on deck creation persists normalized sync media on the new deck', () => {
  const bytes = Buffer.from('audio-bytes');
  const { deck } = normalizeAddonDeckCreateInput({
    deckName: 'Media Deck',
    cards: [{ id: 'anki-1', fields: { Front: '[sound:clip.mp3]' } }],
    media: {
      'clip.mp3': mediaAsset(bytes, 'audio/mpeg')
    }
  }, { name: 'User' });

  assert.equal(deck.media['clip.mp3'].filename, 'clip.mp3');
  assert.equal(deck.media['clip.mp3'].mimeType, 'audio/mpeg');
  assert.equal(deck.media['clip.mp3'].dataBase64, bytes.toString('base64'));
});

test('add-on sync merges media into deck only when not dry-run', () => {
  const deck = createSeedState().decks[0];
  const bytes = Buffer.from('png-bytes');

  const dryRunInput = normalizeAddonSyncInput({
    dryRun: true,
    cards: [{ id: 'anki-media-1', fields: { Front: '<img src="image.png">' }, mediaRefs: ['image.png'] }],
    media: {
      'image.png': mediaAsset(bytes)
    }
  });
  mergeAddonCards(deck, dryRunInput, 'Tester');
  assert.equal(deck.media['image.png'], undefined);

  const syncInput = normalizeAddonSyncInput({
    conflictPolicy: 'overwrite-platform',
    cards: [{ id: 'anki-media-1', fields: { Front: '<img src="image.png">' }, mediaRefs: ['image.png'] }],
    media: {
      'image.png': mediaAsset(bytes)
    }
  });
  mergeAddonCards(deck, syncInput, 'Tester');

  assert.equal(deck.media['image.png'].mimeType, 'image/png');
  assert.equal(deck.media['image.png'].dataBase64, bytes.toString('base64'));
});

test('add-on conflict detection preserves existing same-name media', () => {
  const deck = createSeedState().decks[0];
  const originalBytes = Buffer.from('old-png');
  const incomingBytes = Buffer.from('new-png');
  deck.media['image.png'] = { filename: 'image.png', ...mediaAsset(originalBytes) };

  const syncInput = normalizeAddonSyncInput({
    conflictPolicy: 'detect',
    cards: [{
      id: 'card-anca',
      fields: { Front: 'Changed local text', Back: 'p-ANCA (myeloperoxidase)' },
      mediaRefs: ['image.png']
    }],
    media: {
      'image.png': mediaAsset(incomingBytes)
    }
  });
  const result = mergeAddonCards(deck, syncInput, 'Tester');

  assert.equal(result.stats.conflicts, 1);
  assert.equal(deck.media['image.png'].sha256, mediaAsset(originalBytes).sha256);
  assert.equal(result.conflicts[0].incomingMedia['image.png'].sha256, mediaAsset(incomingBytes).sha256);
});

test('snapshotCard returns fields, tags, modelName, modifiedAt and omits rendered artifacts', () => {
  const card = {
    id: 'card-test',
    fields: { Front: 'Question', Back: 'Answer' },
    tags: ['tag1', 'tag2'],
    modelName: 'Basic',
    type: 'Basic',
    modifiedAt: '2026-05-13T00:00:00.000Z',
    renderedFront: '<div>rendered</div>',
    renderedBack: '<div>rendered</div>',
    mediaRefs: ['image.png']
  };
  const snap = snapshotCard(card);
  assert.deepEqual(snap.fields, { Front: 'Question', Back: 'Answer' });
  assert.deepEqual(snap.tags, ['tag1', 'tag2']);
  assert.equal(snap.modelName, 'Basic');
  assert.equal(snap.modifiedAt, '2026-05-13T00:00:00.000Z');
  assert.equal(snap.renderedFront, undefined);
  assert.equal(snap.renderedBack, undefined);
  assert.equal(snap.mediaRefs, undefined);
});
