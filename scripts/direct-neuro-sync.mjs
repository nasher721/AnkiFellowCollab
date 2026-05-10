import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const ANKI_CONNECT_URL = process.env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765';
const DEFAULT_DECK_NAME = 'Neuro ICU Boards';
const CLIENT_VERSION = '0.2.6-direct';
const MAX_SYNC_REQUEST_BYTES = 900_000;
const COMPRESS_FIELD_AFTER_BYTES = 64_000;
const MAX_API_ATTEMPTS = 5;
const MEDIA_BUCKET = process.env.SUPABASE_MEDIA_BUCKET || 'deckbridge-media';
const args = new Set(process.argv.slice(2));

const CARD_TEXT_KEYS = ['templateFront', 'templateBack', 'modelCss', 'renderedFront', 'renderedBack'];
const mediaRefPattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>]*?\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?)))|\[sound:([^\]]+)\]/gi;

function loadEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return env;
}

async function loadEnv() {
  const fileEnv = loadEnvFile(await fs.readFile(ENV_PATH, 'utf8'));
  return { ...fileEnv, ...process.env };
}

async function anki(action, params = {}, timeoutMs = 120_000) {
  const response = await fetch(ANKI_CONNECT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (body.error) throw new Error(`${action}: ${body.error}`);
  return body.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function filenameFromRef(raw) {
  const clean = safeDecodeURIComponent(String(raw || '').trim());
  if (!clean || /^(https?|data):/i.test(clean)) return '';
  return clean.split(/[\\/]/).filter(Boolean).pop() || '';
}

function mediaRefsFromFields(fields) {
  const refs = [];
  const seen = new Set();
  for (const value of Object.values(fields || {})) {
    mediaRefPattern.lastIndex = 0;
    for (let match; (match = mediaRefPattern.exec(String(value || '')));) {
      const filename = filenameFromRef(match[1] || match[2] || match[3] || match[4] || '');
      if (filename && !seen.has(filename)) {
        refs.push(filename);
        seen.add(filename);
      }
    }
  }
  return refs;
}

function storageFilename(filename) {
  return String(filename || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'media.bin';
}

function mimeTypeForFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function schedulerState(info) {
  if (Number(info.queue) < 0) return 'Suspended';
  if (Number(info.queue) === 0) return 'New';
  if ([1, 3].includes(Number(info.queue))) return 'Learning';
  return 'Review';
}

function orderedFields(fields) {
  return Object.fromEntries(
    Object.entries(fields || {})
      .sort(([, left], [, right]) => Number(left.order ?? 0) - Number(right.order ?? 0))
      .map(([name, field]) => [name, String(field.value ?? '')])
  );
}

function compressedPayload(value) {
  const raw = Buffer.from(String(value || ''), 'utf8');
  if (raw.byteLength < COMPRESS_FIELD_AFTER_BYTES) return null;
  const compressed = deflateSync(raw, { level: 9 });
  const encoded = compressed.toString('base64');
  if (encoded.length + 240 >= raw.byteLength) return null;
  return {
    encoding: 'zlib+base64',
    data: encoded,
    originalBytes: raw.byteLength,
    sha256: crypto.createHash('sha256').update(raw).digest('hex')
  };
}

function compressCard(card) {
  const nextCard = { ...card };
  const fields = {};
  const compressedFields = {};
  for (const [name, value] of Object.entries(card.fields || {})) {
    const compressed = compressedPayload(value);
    if (compressed) {
      fields[name] = '';
      compressedFields[name] = compressed;
    } else {
      fields[name] = String(value || '');
    }
  }
  nextCard.fields = fields;
  if (Object.keys(compressedFields).length) nextCard.compressedFields = compressedFields;

  const compressedCardText = {};
  for (const key of CARD_TEXT_KEYS) {
    if (!Object.hasOwn(nextCard, key)) continue;
    const compressed = compressedPayload(nextCard[key]);
    if (compressed) {
      nextCard[key] = '';
      compressedCardText[key] = compressed;
    }
  }
  if (Object.keys(compressedCardText).length) nextCard.compressedCardText = compressedCardText;
  return nextCard;
}

function rawCardFromInfo(info) {
  const fields = orderedFields(info.fields);
  const fieldOrder = Object.keys(fields);
  const ord = Number.isFinite(Number(info.ord)) ? Number(info.ord) : 0;
  const noteId = Number(info.note || info.cardId);
  return {
    id: `anki-${noteId}-${ord}`,
    ankiCardId: Number(info.cardId),
    ankiNoteId: noteId,
    type: info.modelName || 'Basic',
    modelName: info.modelName || 'Basic',
    fieldOrder,
    fields,
    tags: Array.isArray(info.tags) ? info.tags : [],
    due: Number.isFinite(Number(info.due)) ? Number(info.due) : null,
    state: schedulerState(info),
    modifiedAt: Number.isFinite(Number(info.mod)) ? new Date(Number(info.mod) * 1000).toISOString() : new Date().toISOString(),
    modifiedBy: 'DeckBridge direct recovery',
    suspended: Number(info.queue) < 0,
    mediaRefs: mediaRefsFromFields(fields),
    sourceDeckName: info.deckName || DEFAULT_DECK_NAME,
    sourceDeckPath: info.deckName || DEFAULT_DECK_NAME,
    modelCss: info.css || '',
    renderedFront: info.question || '',
    renderedBack: info.answer || '',
    clozeOrd: ord
  };
}

function cardFromInfo(info) {
  return compressCard(rawCardFromInfo(info));
}

async function collectCards(deckName, options = {}) {
  const compress = options.compress !== false;
  const ids = await anki('findCards', { query: `deck:"${deckName}"` });
  const cards = [];
  for (const idChunk of chunk(ids, 100)) {
    const infos = await anki('cardsInfo', { cards: idChunk });
    cards.push(...infos.map(rawCardFromInfo));
    if (cards.length % 500 < idChunk.length) console.log(`Collected ${cards.length}/${ids.length} cards from Anki`);
  }
  preserveDuplicateAnkiCardIds(cards);
  return compress ? cards.map(compressCard) : cards;
}

function preserveDuplicateAnkiCardIds(cards) {
  const groups = new Map();
  for (const card of cards) {
    const ord = Number.isFinite(Number(card.clozeOrd)) ? Number(card.clozeOrd) : 0;
    const key = `${card.ankiNoteId}:${ord}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    for (const card of group) {
      card.id = `anki-${card.ankiNoteId}-${card.clozeOrd}-${card.ankiCardId}`;
    }
  }
}

async function buildMediaAssets(cards, deckId, mediaDir) {
  const refs = [...new Set(cards.flatMap((card) => card.mediaRefs || []))];
  const assets = {};
  const missing = [];
  for (const filename of refs) {
    const localPath = path.join(mediaDir, filename);
    let bytes;
    try {
      bytes = await fs.readFile(localPath);
    } catch {
      missing.push(filename);
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assets[filename] = {
      filename,
      bytes,
      mimeType: mimeTypeForFilename(filename),
      sha256,
      sizeBytes: bytes.byteLength,
      storageBucket: MEDIA_BUCKET,
      storagePath: `${deckId}/${sha256}/${storageFilename(filename)}`
    };
  }
  return { assets, missing };
}

function storageObjectUrl(supabaseUrl, bucket, storagePath) {
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
}

async function uploadAsset(supabaseUrl, serviceKey, asset) {
  const url = storageObjectUrl(supabaseUrl, MEDIA_BUCKET, asset.storagePath);
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          'content-type': asset.mimeType,
          'x-upsert': 'true',
          'cache-control': '3600'
        },
        body: asset.bytes,
        duplex: 'half',
        signal: AbortSignal.timeout(60_000)
      });
      if (response.ok || response.status === 409) return;
      const text = await response.text();
      lastError = new Error(`Storage upload failed for ${asset.filename}: HTTP ${response.status}: ${text.slice(0, 500)}`);
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
      console.warn(`Storage upload retry ${attempt}/4 for ${asset.filename} after HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000 * attempt);
  }
  throw lastError;
}

async function uploadMedia(supabaseUrl, serviceKey, assets) {
  const entries = Object.values(assets);
  let uploaded = 0;
  for (const mediaChunk of chunk(entries, 6)) {
    await Promise.all(mediaChunk.map(async (asset) => {
      await uploadAsset(supabaseUrl, serviceKey, asset);
      uploaded += 1;
    }));
    if (uploaded % 60 < mediaChunk.length || uploaded === entries.length) {
      console.log(`Uploaded ${uploaded}/${entries.length} media files to Supabase storage`);
    }
  }
}

async function supabaseRest(env, serviceKey, table, options = {}) {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    url.searchParams.set(key, value);
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.prefer ? { Prefer: options.prefer } : {}),
          ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs || 60_000)
      });
      const text = await response.text();
      if (response.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      lastError = new Error(`Supabase REST ${options.method || 'GET'} ${table} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
      if (![408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(response.status)) break;
    } catch (error) {
      lastError = error;
    }
    console.warn(`Supabase REST retry ${attempt}/5 for ${table} after ${lastError?.name || lastError?.message || 'error'}`);
    await sleep(1500 * attempt);
  }
  throw lastError;
}

function quotedIn(values) {
  return `(${values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(',')})`;
}

function mediaMetadataForCards(cards, assets) {
  const refs = new Set(cards.flatMap((card) => card.mediaRefs || []));
  const metadata = {};
  for (const ref of refs) {
    const asset = assets[ref];
    if (!asset) continue;
    metadata[ref] = {
      filename: asset.filename,
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      storageBucket: asset.storageBucket,
      storagePath: asset.storagePath
    };
  }
  return metadata;
}

function managedFileId(bucket, storagePath) {
  const digest = crypto.createHash('sha256').update(`${bucket}/${storagePath}`).digest('hex').slice(0, 32);
  return `file-${digest}`;
}

function managedMediaRow(deckId, asset, userId, now) {
  return {
    id: managedFileId(asset.storageBucket || MEDIA_BUCKET, asset.storagePath),
    deck_id: deckId,
    file_kind: 'media',
    filename: asset.filename,
    storage_bucket: asset.storageBucket || MEDIA_BUCKET,
    storage_path: asset.storagePath,
    sha256: asset.sha256,
    size_bytes: asset.sizeBytes,
    mime_type: asset.mimeType || 'application/octet-stream',
    status: 'available',
    created_by: userId || null,
    updated_at: now,
    uploaded_at: now,
    metadata: {}
  };
}

function cardRowForDb(deckId, card) {
  return {
    id: card.id,
    deck_id: deckId,
    anki_note_id: card.ankiNoteId,
    note_type: card.type,
    model_name: card.modelName || card.type,
    field_order: card.fieldOrder || Object.keys(card.fields || {}),
    fields: card.fields || {},
    tags: card.tags || [],
    due: card.due,
    state: card.state,
    modified_at: card.modifiedAt,
    modified_by: card.modifiedBy,
    suspended: card.suspended,
    media_refs: card.mediaRefs || [],
    source_deck_name: card.sourceDeckName,
    source_deck_path: card.sourceDeckPath,
    template_front: card.templateFront,
    template_back: card.templateBack,
    model_css: card.modelCss,
    rendered_front: card.renderedFront,
    rendered_back: card.renderedBack,
    cloze_ord: card.clozeOrd
  };
}

async function fetchExistingCardIndex(env, serviceKey, deckId) {
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const data = await supabaseRest(env, serviceKey, 'cards', {
      query: {
        select: 'id,anki_note_id,cloze_ord',
        deck_id: `eq.${deckId}`,
        limit: '1000',
        offset: String(start)
      }
    });
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const byId = new Set(rows.map((row) => row.id));
  const byNoteOrd = new Map();
  const legacyByNote = new Map();
  for (const row of rows) {
    if (!row.anki_note_id) continue;
    const ord = Number.isFinite(Number(row.cloze_ord)) ? Number(row.cloze_ord) : 0;
    const noteOrd = `${row.anki_note_id}:${ord}`;
    if (!byNoteOrd.has(noteOrd)) byNoteOrd.set(noteOrd, row.id);
    if (ord === 0 && row.id === `anki-${row.anki_note_id}` && !legacyByNote.has(String(row.anki_note_id))) {
      legacyByNote.set(String(row.anki_note_id), row.id);
    }
  }
  return { byId, byNoteOrd, legacyByNote };
}

async function directDbSync({ env, deckId, deckName, cards, assets }) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const now = new Date().toISOString();
  const userId = null;

  const replacing = args.has('--replace-db');
  const existing = replacing ? { byId: new Set(), byNoteOrd: new Map(), legacyByNote: new Map() } : await fetchExistingCardIndex(env, serviceKey, deckId);
  let created = 0;
  let updated = 0;
  const rows = cards.map((card) => {
    const preservedId = card.id;
    if (existing.byId.has(preservedId)) updated += 1;
    else created += 1;
    return cardRowForDb(deckId, { ...card, id: preservedId, modifiedAt: now, modifiedBy: 'DeckBridge direct DB recovery' });
  });
  const incomingIds = new Set(rows.map((row) => row.id));

  if (replacing) {
    await supabaseRest(env, serviceKey, 'cards', {
      method: 'DELETE',
      query: { deck_id: `eq.${deckId}` },
      prefer: 'return=minimal',
      timeoutMs: 120_000
    });
    created = rows.length;
    updated = 0;
    console.log(`Direct DB cleared existing cards for ${deckId}`);
  }

  let written = 0;
  for (const rowChunk of chunk(rows, 10)) {
    await supabaseRest(env, serviceKey, 'cards', {
      method: 'POST',
      query: { on_conflict: 'id' },
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: rowChunk
    });
    written += rowChunk.length;
    if (written % 250 < rowChunk.length || written === rows.length) {
      console.log(`Direct DB wrote ${written}/${rows.length} cards`);
    }
  }

  if (!replacing) {
    const staleIds = [...existing.byId].filter((id) => String(id).startsWith('anki-') && !incomingIds.has(id));
    let deleted = 0;
    for (const staleChunk of chunk(staleIds, 500)) {
      await supabaseRest(env, serviceKey, 'cards', {
        method: 'DELETE',
        query: { deck_id: `eq.${deckId}`, id: `in.${quotedIn(staleChunk)}` },
        prefer: 'return=minimal'
      });
      deleted += staleChunk.length;
    }
    if (deleted) console.log(`Direct DB removed ${deleted} stale Anki card row(s)`);
  }

  const mediaRows = Object.values(assets).map((asset) => managedMediaRow(deckId, asset, userId, now));
  let fileRows = 0;
  for (const mediaChunk of chunk(mediaRows, 500)) {
    await supabaseRest(env, serviceKey, 'deck_files', {
      method: 'POST',
      query: { on_conflict: 'storage_bucket,storage_path' },
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: mediaChunk
    });
    fileRows += mediaChunk.length;
  }
  console.log(`Direct DB marked ${fileRows} media files available`);

  const proof = {
    syncedAt: now,
    source: 'DeckBridge direct DB recovery',
    client: { name: 'DeckBridge direct DB recovery', version: CLIENT_VERSION, fingerprint: 'service-role' },
    stats: { total: rows.length, created, updated, skipped: 0, conflicts: 0, dryRun: false },
    batch: { id: `direct-db-${Date.now()}`, index: 0, total: 1, totalCards: rows.length, received: 1, complete: true },
    mediaReceived: mediaRows.length
  };
  await supabaseRest(env, serviceKey, 'decks', {
    method: 'PATCH',
    query: { id: `eq.${deckId}` },
    prefer: 'return=minimal',
    body: { last_synced_at: now, last_sync_result: proof, media: {}, source: { format: 'anki-addon', deckName, deckPath: deckName, source: proof.source, client: proof.client, batch: proof.batch } }
  });

  if (userId) {
    await supabaseRest(env, serviceKey, 'activity', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
      id: `act-${crypto.randomUUID()}`,
      deck_id: deckId,
      user_id: userId,
      kind: 'sync',
      text: `DeckBridge direct DB recovery synced ${rows.length} Anki card(s): ${created} new, ${updated} updated, 0 conflict(s)`,
      created_at: now
      }
    });
  }
  return proof;
}

function requestBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function makePayload({ cards, media, deckName, batchId, batchIndex, batchTotal, totalCards }) {
  return {
    cards,
    media,
    deckName,
    deckPath: deckName,
    dryRun: false,
    allowCreate: true,
    conflictPolicy: 'overwrite-platform',
    returnState: false,
    source: 'DeckBridge direct recovery',
    client: {
      name: 'DeckBridge direct recovery',
      version: CLIENT_VERSION,
      fingerprint: crypto.createHash('sha256').update(`${process.env.USER || 'user'}:${deckName}`).digest('hex').slice(0, 16)
    },
    batch: {
      id: batchId,
      index: batchIndex,
      total: batchTotal,
      totalCards
    }
  };
}

function buildSyncBatches(cards, assets, deckName, maxBytes = MAX_SYNC_REQUEST_BYTES) {
  const batches = [];
  let current = [];
  for (const card of cards) {
    const trial = [...current, card];
    const trialPayload = makePayload({
      cards: trial,
      media: mediaMetadataForCards(trial, assets),
      deckName,
      batchId: 'placeholder',
      batchIndex: 0,
      batchTotal: 1,
      totalCards: cards.length
    });
    if (current.length && requestBytes(trialPayload) > maxBytes) {
      batches.push(current);
      current = [card];
      continue;
    }
    if (!current.length && requestBytes(trialPayload) > maxBytes) {
      throw new Error(`Single card ${card.id} exceeds ${maxBytes} bytes after compression`);
    }
    current = trial;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function postSyncBatch(baseUrl, deckId, token, payload) {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/decks/${deckId}/sync/cards`;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000)
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
      if (response.ok) return body;
      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 800)}`);
      if (![401, 408, 429, 500, 502, 503, 504].includes(response.status) || attempt === MAX_API_ATTEMPTS) break;
      console.warn(`DeckBridge batch retry ${attempt}/${MAX_API_ATTEMPTS} after HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      console.warn(`DeckBridge batch retry ${attempt}/${MAX_API_ATTEMPTS} after ${error.name || 'error'}`);
      if (attempt === MAX_API_ATTEMPTS) break;
    }
    await sleep(1500 * attempt);
  }
  throw lastError;
}

async function validateDeckBridgeToken(baseUrl, token) {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/me`;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000)
      });
      const text = await response.text();
      if (response.ok) return;
      lastError = new Error(`/api/me failed with ${response.status}: ${text.slice(0, 500)}`);
      if (![401, 408, 429, 500, 502, 503, 504].includes(response.status) || attempt === MAX_API_ATTEMPTS) break;
      console.warn(`/api/me retry ${attempt}/${MAX_API_ATTEMPTS} after HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      console.warn(`/api/me retry ${attempt}/${MAX_API_ATTEMPTS} after ${error.name || 'error'}`);
      if (attempt === MAX_API_ATTEMPTS) break;
    }
    await sleep(1500 * attempt);
  }
  throw lastError;
}

async function main() {
  const env = await loadEnv();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !serviceKey) throw new Error('SUPABASE_URL and service role key are required');

  const collectionConfig = await anki('getCollectionConfig');
  const deckbridge = collectionConfig.deckbridge || {};
  const mapping = (deckbridge.deckMappings || []).find((item) => item.localDeck === DEFAULT_DECK_NAME) || deckbridge.deckMappings?.[0];
  const deckId = mapping?.deckId || deckbridge.deckId;
  const deckName = mapping?.localDeck || deckbridge.localDeck || DEFAULT_DECK_NAME;
  const token = deckbridge.token;
  const baseUrl = deckbridge.url || 'https://anki-collab.vercel.app';
  if (!deckId || !token) throw new Error('DeckBridge collection config is missing deckId or token');

  if (!args.has('--direct-db')) await validateDeckBridgeToken(baseUrl, token);

  console.log(`Collecting cards from Anki deck "${deckName}"`);
  const cards = await collectCards(deckName, { compress: !args.has('--direct-db') });
  console.log(`Collected ${cards.length} cards`);

  const mediaDir = env.ANKI_MEDIA_DIR || path.join(process.env.HOME || '', 'Library/Application Support/Anki2/User 1/collection.media');
  console.log(`Scanning media references in ${mediaDir}`);
  const { assets, missing } = await buildMediaAssets(cards, deckId, mediaDir);
  if (missing.length) console.warn(`Missing ${missing.length} referenced media files; first few: ${missing.slice(0, 10).join(', ')}`);
  console.log(`Found ${Object.keys(assets).length} local media files referenced by cards`);

  if (args.has('--skip-media-upload')) {
    console.log('Skipping media upload because --skip-media-upload was provided');
  } else {
    await uploadMedia(env.SUPABASE_URL, serviceKey, assets);
  }

  if (args.has('--direct-db')) {
    const proof = await directDbSync({ env, deckId, deckName, cards, assets });
    console.log(JSON.stringify({
      deckId,
      cardCount: cards.length,
      mediaCount: Object.keys(assets).length,
      missingMediaCount: missing.length,
      finalProof: proof
    }, null, 2));
    return;
  }

  const rawBatches = buildSyncBatches(cards, assets, deckName);
  const batchId = `direct-${Date.now()}`;
  console.log(`Posting ${rawBatches.length} sync batches to DeckBridge`);
  let finalResponse = null;
  for (let index = 0; index < rawBatches.length; index += 1) {
    const batchCards = rawBatches[index];
    const payload = makePayload({
      cards: batchCards,
      media: mediaMetadataForCards(batchCards, assets),
      deckName,
      batchId,
      batchIndex: index,
      batchTotal: rawBatches.length,
      totalCards: cards.length
    });
    console.log(`Posting batch ${index + 1}/${rawBatches.length}: ${batchCards.length} cards, ${Object.keys(payload.media).length} media, ${requestBytes(payload)} bytes`);
    finalResponse = await postSyncBatch(baseUrl, deckId, token, payload);
    const proof = finalResponse?.result?.proof;
    if (proof?.stats) {
      console.log(`DeckBridge accepted batch ${index + 1}; cumulative ${proof.stats.total} cards, ${proof.stats.created} created, ${proof.stats.updated} updated, ${proof.stats.skipped} skipped`);
    }
  }
  console.log(JSON.stringify({
    deckId,
    cardCount: cards.length,
    mediaCount: Object.keys(assets).length,
    missingMediaCount: missing.length,
    finalProof: finalResponse?.result?.proof || null
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || (typeof error === 'object' ? JSON.stringify(error, null, 2) : String(error)));
  process.exitCode = 1;
});
