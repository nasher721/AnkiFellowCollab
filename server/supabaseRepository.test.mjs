import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cardRowForUpsert,
  createSignedMediaUploadTargets,
  managedFileRow,
  managedMediaRows,
  roleMeetsMinimum
} from './repositories/supabaseRepository.mjs';

test('Supabase repository role ladder includes collaboration roles', () => {
  assert.equal(roleMeetsMinimum('owner', 'editor'), true);
  assert.equal(roleMeetsMinimum('editor', 'reviewer'), true);
  assert.equal(roleMeetsMinimum('reviewer', 'contributor'), true);
  assert.equal(roleMeetsMinimum('contributor', 'viewer'), true);
  assert.equal(roleMeetsMinimum('contributor', 'reviewer'), false);
  assert.equal(roleMeetsMinimum('reviewer', 'editor'), false);
});

test('Supabase repository role ladder rejects unknown roles', () => {
  assert.equal(roleMeetsMinimum('admin', 'viewer'), false);
  assert.equal(roleMeetsMinimum('owner', 'admin'), false);
  assert.equal(roleMeetsMinimum(undefined, 'viewer'), false);
});

test('managed file rows capture storage identity and upload lifecycle', () => {
  const row = managedFileRow({
    deckId: 'deck-1',
    kind: 'media',
    filename: 'large.png',
    bucket: 'deckbridge-media',
    storagePath: 'deck-1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/large.png',
    sha256: 'a'.repeat(64),
    sizeBytes: 12_000_000,
    mimeType: 'image/png',
    status: 'pending_upload',
    userId: 'user-1',
    now: '2026-05-09T12:00:00.000Z'
  });

  assert.match(row.id, /^file-[a-f0-9]{32}$/);
  assert.equal(row.deck_id, 'deck-1');
  assert.equal(row.file_kind, 'media');
  assert.equal(row.storage_bucket, 'deckbridge-media');
  assert.equal(row.storage_path, 'deck-1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/large.png');
  assert.equal(row.sha256, 'a'.repeat(64));
  assert.equal(row.size_bytes, 12_000_000);
  assert.equal(row.mime_type, 'image/png');
  assert.equal(row.status, 'pending_upload');
  assert.equal(row.uploaded_at, null);
});

test('managed media rows mark storage-backed assets available without inline blobs', () => {
  const rows = managedMediaRows('deck-1', {
    'small.png': {
      filename: 'small.png',
      mimeType: 'image/png',
      dataBase64: 'c21hbGw='
    },
    'large.png': {
      filename: 'large.png',
      mimeType: 'image/png',
      sha256: 'b'.repeat(64),
      sizeBytes: 25_000_000,
      storageBucket: 'deckbridge-media',
      storagePath: `deck-1/${'b'.repeat(64)}/large.png`
    }
  }, 'user-1');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].filename, 'large.png');
  assert.equal(rows[0].status, 'available');
  assert.equal(rows[0].uploaded_at, rows[0].updated_at);
  assert.equal(rows[0].metadata && Object.keys(rows[0].metadata).length, 0);
});

test('signed media upload targets are created with bounded concurrency', async () => {
  const files = Array.from({ length: 6 }, (_, index) => ({
    filename: `large-${index}.png`,
    mimeType: 'image/png',
    sha256: String(index).repeat(64),
    sizeBytes: 12_000_000 + index
  }));
  let active = 0;
  let maxActive = 0;
  const requestedPaths = [];
  const supabase = {
    storage: {
      from(bucket) {
        assert.equal(bucket, 'deckbridge-media');
        return {
          async createSignedUploadUrl(storagePath) {
            requestedPaths.push(storagePath);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return { data: { signedUrl: `https://storage.example/${storagePath}` }, error: null };
          }
        };
      }
    }
  };

  const { uploads, fileRows } = await createSignedMediaUploadTargets({
    supabase,
    bucket: 'deckbridge-media',
    deckId: 'deck-1',
    files,
    userId: 'user-1',
    now: '2026-05-09T12:00:00.000Z',
    concurrency: 3,
    expiresIn: 7200
  });

  assert.equal(maxActive, 3);
  assert.deepEqual(uploads.map((upload) => upload.filename), files.map((file) => file.filename));
  assert.equal(fileRows.length, files.length);
  assert.equal(fileRows[0].status, 'pending_upload');
  assert.deepEqual(requestedPaths, files.map((file) => `deck-1/${file.sha256}/${file.filename}`));
});

test('card row mapping preserves Anki render and scheduling metadata', () => {
  const row = cardRowForUpsert('deck-1', {
    id: 'card-1',
    ankiNoteId: 42,
    type: 'Cloze',
    modelName: 'Enhanced Cloze 2.1',
    fieldOrder: ['Text', 'Extra'],
    fields: { Text: '{{c1::AVM}} rupture', Extra: 'lobar hemorrhage' },
    tags: ['vascular'],
    due: '2026-05-09',
    state: 'Review',
    modifiedAt: '2026-05-09T12:00:00.000Z',
    modifiedBy: 'Owner',
    suspended: false,
    mediaRefs: ['scan.png'],
    sourceDeckName: 'Neuro ICU',
    sourceDeckPath: 'Neuro ICU::Vascular',
    templateFront: '{{cloze:Text}}',
    templateBack: '{{cloze:Text}}<hr>{{Extra}}',
    modelCss: '.card { font-family: arial; }',
    renderedFront: '<span class="cloze">[...]</span> rupture',
    renderedBack: '<span class="cloze">AVM</span> rupture<hr>lobar hemorrhage',
    clozeOrd: 0
  });

  assert.deepEqual(row, {
    id: 'card-1',
    deck_id: 'deck-1',
    anki_note_id: 42,
    note_type: 'Cloze',
    model_name: 'Enhanced Cloze 2.1',
    field_order: ['Text', 'Extra'],
    fields: { Text: '{{c1::AVM}} rupture', Extra: 'lobar hemorrhage' },
    tags: ['vascular'],
    due: '2026-05-09',
    state: 'Review',
    modified_at: '2026-05-09T12:00:00.000Z',
    modified_by: 'Owner',
    suspended: false,
    media_refs: ['scan.png'],
    source_deck_name: 'Neuro ICU',
    source_deck_path: 'Neuro ICU::Vascular',
    template_front: '{{cloze:Text}}',
    template_back: '{{cloze:Text}}<hr>{{Extra}}',
    model_css: '.card { font-family: arial; }',
    rendered_front: '<span class="cloze">[...]</span> rupture',
    rendered_back: '<span class="cloze">AVM</span> rupture<hr>lobar hemorrhage',
    cloze_ord: 0
  });
});
