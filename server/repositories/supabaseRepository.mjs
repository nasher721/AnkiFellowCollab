import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { applySuggestion, buildAddonSyncResult, cosineSimilarity, mergeAddonCards, nowIso, snapshotCard, summarizeDeck } from '../domain.mjs';
import { fail } from '../errors.mjs';
import { encodeCursor, decodeCursor } from '../pagination.mjs';

export const roleRank = {
  viewer: 0,
  contributor: 1,
  reviewer: 2,
  editor: 3,
  owner: 4
};

export function roleMeetsMinimum(role, minimumRole = 'viewer') {
  if (!Object.hasOwn(roleRank, role) || !Object.hasOwn(roleRank, minimumRole)) return false;
  return roleRank[role] >= roleRank[minimumRole];
}

const DEFAULT_AI_SETTINGS = Object.freeze({
  reviewBriefs: false,
  embeddings: false,
  conflictSummaries: false,
  diagnostics: false,
  qualityPulse: false
});

const AI_ARTIFACT_STATUSES = new Set(['active', 'dismissed', 'accepted', 'rejected', 'stale']);

function countReceivedMedia(syncInput = {}) {
  return Object.keys(syncInput.media || {}).length;
}

function addMediaReceivedToSyncProof(syncInput, lastAddonSync, previousResult = null) {
  const continuingBatch = syncInput.batch
    && previousResult?.batch?.id === syncInput.batch.id
    && syncInput.batch.index > 0;
  const mediaReceived = (continuingBatch ? Number(previousResult.stats?.mediaReceived || 0) : 0)
    + countReceivedMedia(syncInput);
  return {
    ...lastAddonSync,
    stats: {
      ...lastAddonSync.stats,
      mediaReceived
    },
    mediaReceived
  };
}

function normalizeAiSettings(settings = {}) {
  return {
    reviewBriefs: Boolean(settings.reviewBriefs),
    embeddings: Boolean(settings.embeddings),
    conflictSummaries: Boolean(settings.conflictSummaries),
    diagnostics: Boolean(settings.diagnostics),
    qualityPulse: Boolean(settings.qualityPulse),
    updatedAt: settings.updatedAt || null,
    updatedBy: settings.updatedBy || null
  };
}

function addonImportSyncResult(deck) {
  if (deck.source?.format !== 'anki-addon') return null;
  const syncedAt = deck.lastSyncedAt || deck.importedAt || nowIso();
  const batch = deck.source.batch ? {
    ...deck.source.batch,
    received: deck.source.batch.index + 1,
    complete: deck.source.batch.index + 1 >= deck.source.batch.total
  } : null;
  return {
    syncedAt,
    source: deck.source.source || 'DeckBridge Anki add-on',
    client: deck.source.client || null,
    stats: {
      total: deck.cards.length,
      created: deck.cards.length,
      updated: 0,
      skipped: 0,
      conflicts: 0,
      dryRun: false
    },
    ...(batch ? { batch } : {})
  };
}

function requireEnv(name, value) {
  if (!value) fail(500, 'missing_config', `${name} is required for Supabase repository`);
  return value;
}

function toDeck(row, cards = []) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    owner: row.owner_name || 'Owner',
    importedAt: row.imported_at,
    lastSyncedAt: row.last_synced_at,
    cards,
    media: row.media || {},
    source: row.source || { filename: 'unknown.apkg', format: 'apkg' },
    models: row.models || [],
    aiSettings: normalizeAiSettings(row.ai_settings)
  };
}

async function countRows(supabase, table, deckId, apply = (query) => query) {
  const query = supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('deck_id', deckId);
  const { count, error } = await apply(query);
  if (error) throw error;
  return count || 0;
}

async function summarizeDeckRow(supabase, deck) {
  const [cardCount, pendingSuggestions] = await Promise.all([
    countRows(supabase, 'cards', deck.id),
    countRows(supabase, 'suggestions', deck.id, (query) => query.eq('status', 'pending'))
  ]);
  return {
    ...summarizeDeck(toDeck(deck), []),
    cardCount,
    noteCount: cardCount,
    pendingSuggestions
  };
}

function toCard(row) {
  return {
    id: row.id,
    ankiNoteId: row.anki_note_id,
    type: row.note_type || 'Basic',
    modelName: row.model_name || row.note_type || 'Basic',
    fieldOrder: row.field_order || Object.keys(row.fields || {}),
    fields: row.fields || {},
    tags: row.tags || [],
    due: row.due,
    state: row.state || 'New',
    modifiedAt: row.modified_at,
    modifiedBy: row.modified_by || 'Import',
    suspended: Boolean(row.suspended),
    mediaRefs: row.media_refs || [],
    sourceDeckName: row.source_deck_name || null,
    sourceDeckPath: row.source_deck_path || null,
    templateFront: row.template_front || undefined,
    templateBack: row.template_back || undefined,
    modelCss: row.model_css || undefined,
    renderedFront: row.rendered_front || undefined,
    renderedBack: row.rendered_back || undefined,
    clozeOrd: row.cloze_ord ?? undefined,
    createdAt: row.created_at
  };
}

function toSuggestion(row) {
  return {
    id: row.id,
    deckId: row.deck_id,
    cardId: row.card_id,
    authorId: row.author_id,
    authorName: row.author_name,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    proposedFields: row.proposed_fields || {},
    proposedTags: row.proposed_tags || []
  };
}

function toActivity(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    at: row.created_at
  };
}

function toComment(row) {
  return {
    id: row.id,
    suggestionId: row.suggestion_id,
    deckId: row.deck_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    parentId: row.parent_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    resolvedAt: row.resolved_at || null,
    resolvedBy: row.resolved_by || null
  };
}

function toStudySession(row) {
  return {
    id: row.id,
    userId: row.user_id,
    deckId: row.deck_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    cardsStudied: row.cards_studied,
    cardsCorrect: row.cards_correct,
    newCards: row.new_cards,
    reviewCards: row.review_cards,
    metadata: row.metadata || {},
    createdAt: row.created_at
  };
}

function toShareLink(row) {
  return {
    id: row.id,
    deckId: row.deck_id,
    token: row.token,
    label: row.label,
    passwordProtected: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    disabledAt: row.disabled_at,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function toAiArtifact(row) {
  return {
    id: row.id,
    deckId: row.deck_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    confidence: row.confidence,
    model: row.model,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    payload: row.payload || {},
    createdAt: row.created_at,
    decidedAt: row.decided_at || null,
    decidedBy: row.decided_by || null
  };
}

function toCardEmbedding(row) {
  return {
    cardId: row.card_id,
    deckId: row.deck_id,
    model: row.model,
    dimensions: row.dimensions,
    inputHash: row.input_hash,
    embedding: Array.isArray(row.embedding) ? row.embedding : [],
    status: row.status || 'active',
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toAiDuplicateLink(row) {
  return {
    id: row.id,
    deckId: row.deck_id,
    sourceCardId: row.source_card_id,
    targetCardId: row.target_card_id,
    artifactId: row.artifact_id || null,
    score: row.score,
    relationship: row.relationship,
    rationale: row.rationale || '',
    comparedFields: row.compared_fields || [],
    status: row.status || 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mediaBucket() {
  return process.env.SUPABASE_MEDIA_BUCKET || 'deckbridge-media';
}

function storageFilename(filename) {
  return String(filename || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'media.bin';
}

function storagePathForMedia(deckId, file) {
  return `${deckId}/${file.sha256}/${storageFilename(file.filename)}`;
}

function managedFileId(bucket, storagePath) {
  const digest = createHash('sha256').update(`${bucket}/${storagePath}`).digest('hex').slice(0, 32);
  return `file-${digest}`;
}

export function managedFileRow({
  deckId,
  kind,
  filename,
  bucket,
  storagePath,
  sha256 = null,
  sizeBytes = 0,
  mimeType = 'application/octet-stream',
  status = 'pending_upload',
  userId = null,
  metadata = {},
  now = nowIso()
}) {
  return {
    id: managedFileId(bucket, storagePath),
    deck_id: deckId,
    file_kind: kind,
    filename,
    storage_bucket: bucket,
    storage_path: storagePath,
    sha256,
    size_bytes: sizeBytes,
    mime_type: mimeType || 'application/octet-stream',
    status,
    created_by: userId,
    updated_at: now,
    uploaded_at: status === 'available' ? now : null,
    metadata
  };
}

export function managedMediaRows(deckId, media = {}, userId = null, status = 'available') {
  const now = nowIso();
  return Object.values(media || {})
    .filter((asset) => asset?.storagePath)
    .map((asset) => managedFileRow({
      deckId,
      kind: 'media',
      filename: asset.filename || storageFilename(asset.storagePath.split('/').pop()),
      bucket: asset.storageBucket || mediaBucket(),
      storagePath: asset.storagePath,
      sha256: asset.sha256 || null,
      sizeBytes: Number(asset.sizeBytes || 0),
      mimeType: asset.mimeType || 'application/octet-stream',
      status,
      userId,
      now
    }));
}

function inlineDeckMedia(media = {}) {
  return Object.fromEntries(
    Object.entries(media || {}).filter(([, asset]) => asset?.dataBase64 && !asset?.storagePath)
  );
}

function storageDeckMedia(media = {}) {
  return Object.fromEntries(
    Object.entries(media || {}).filter(([, asset]) => asset?.storagePath)
  );
}

function mediaAssetFromFileRow(row) {
  if (!row) return null;
  return {
    filename: row.filename,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    sha256: row.sha256 || undefined,
    sizeBytes: Number(row.size_bytes || 0),
    mimeType: row.mime_type || 'application/octet-stream'
  };
}

async function hashFile(filePath) {
  const stat = await fs.stat(filePath);
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sizeBytes: stat.size, sha256: hash.digest('hex') };
}

function assertDeckStoragePath(deckId, asset) {
  const storagePath = String(asset?.storagePath || '');
  if (!storagePath || storagePath.includes('..') || storagePath.includes('\\') || !storagePath.startsWith(`${deckId}/`)) {
    fail(404, 'media_not_found', 'Media asset not found');
  }
  return storagePath;
}

const SYNC_CARD_LOOKUP_CHUNK_SIZE = 500;
const SYNC_CARD_WRITE_CHUNK_SIZE = 500;
const MEDIA_UPLOAD_TARGET_CONCURRENCY = 12;
const MEMBERSHIP_COLUMNS = 'deck_id,user_id,role,created_at';
const DECK_SYNC_COLUMNS = [
  'id',
  'name',
  'description',
  'owner_name',
  'imported_at',
  'last_synced_at',
  'last_sync_result',
  'source',
  'models',
  'ai_settings'
].join(',');
const CARD_COLUMNS = [
  'id',
  'anki_note_id',
  'note_type',
  'model_name',
  'field_order',
  'fields',
  'tags',
  'due',
  'state',
  'modified_at',
  'modified_by',
  'suspended',
  'media_refs',
  'source_deck_name',
  'source_deck_path',
  'template_front',
  'template_back',
  'model_css',
  'rendered_front',
  'rendered_back',
  'cloze_ord',
  'created_at'
].join(',');
const ACTIVITY_COLUMNS = 'id,kind,text,created_at';
const CONFLICT_COLUMNS = 'id,deck_id,card_id,source,detected_at,incoming_fields,local_fields';

function chunked(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== '').map(String))];
}

function uniqueNoteIds(cards) {
  return [...new Set(
    cards
      .map((card) => Number(card.ankiNoteId))
      .filter((id) => Number.isFinite(id))
  )];
}

export function cardRowForUpsert(deckId, card) {
  return {
    id: card.id,
    deck_id: deckId,
    anki_note_id: card.ankiNoteId,
    note_type: card.type,
    model_name: card.modelName || card.type,
    field_order: card.fieldOrder || Object.keys(card.fields || {}),
    fields: card.fields,
    tags: card.tags,
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

async function fetchCardRowsByColumn(supabase, deckId, column, values) {
  const rows = [];
  for (const chunk of chunked(values, SYNC_CARD_LOOKUP_CHUNK_SIZE)) {
    const { data, error } = await supabase.from('cards').select(CARD_COLUMNS).eq('deck_id', deckId).in(column, chunk);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function fetchSyncCandidateCards(supabase, deckId, incomingCards) {
  const idRows = await fetchCardRowsByColumn(supabase, deckId, 'id', uniqueValues(incomingCards.map((card) => card.id)));
  const noteIds = uniqueNoteIds(incomingCards);
  const noteRows = noteIds.length
    ? await fetchCardRowsByColumn(supabase, deckId, 'anki_note_id', noteIds)
    : [];
  return [...new Map([...idRows, ...noteRows].map((row) => [row.id, row])).values()].map(toCard);
}

async function upsertSyncCards(supabase, deckId, cards) {
  for (const chunk of chunked(cards, SYNC_CARD_WRITE_CHUNK_SIZE)) {
    const { error } = await supabase.from('cards')
      .upsert(chunk.map((card) => cardRowForUpsert(deckId, card)), { onConflict: 'id' });
    if (error) throw error;
  }
}

async function upsertManagedFileRows(supabase, rows) {
  if (!rows.length) return;
  const { error } = await supabase
    .from('deck_files')
    .upsert(rows, { onConflict: 'storage_bucket,storage_path' });
  if (error) throw error;
}

function boundedPositiveInteger(value, fallback, minimum = 1, maximum = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export async function createSignedMediaUploadTargets({
  supabase,
  bucket,
  deckId,
  files,
  userId,
  now = nowIso(),
  concurrency = MEDIA_UPLOAD_TARGET_CONCURRENCY,
  expiresIn = 7200
}) {
  const storage = supabase.storage.from(bucket);
  const signedTargets = await mapWithConcurrency(files, concurrency, async (file) => {
    const storagePath = storagePathForMedia(deckId, file);
    const { data, error } = await storage.createSignedUploadUrl(storagePath, { upsert: true });
    if (error) throw error;
    return { file, storagePath, uploadUrl: data.signedUrl };
  });
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    uploads: signedTargets.map(({ file, storagePath, uploadUrl }) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      storageBucket: bucket,
      storagePath,
      uploadUrl,
      expiresAt
    })),
    fileRows: signedTargets.map(({ file, storagePath }) => managedFileRow({
      deckId,
      kind: 'media',
      filename: file.filename,
      bucket,
      storagePath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      status: 'pending_upload',
      userId,
      metadata: { source: 'signed-upload-target' },
      now
    }))
  };
}

function isOptionalAiSchemaError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === 'PGRST204'
    || code === '42P01'
    || /card_embeddings|ai_duplicate_links|ai_artifacts|schema cache/i.test(message);
}

function emptyState(user) {
  return {
    decks: [],
    summaries: [],
    activeDeckId: null,
    role: 'contributor',
    collaborators: [],
    suggestions: [],
    activity: [],
    sync: {
      ankiConnectUrl: null,
      connected: false,
      lastCheckedAt: null,
      lastPullAt: null,
      lastPushAt: null,
      lastAddonSync: null,
      conflicts: []
    },
    user,
    memberships: []
  };
}

export function createSupabaseRepository(options = {}) {
  const url = requireEnv('SUPABASE_URL', options.supabaseUrl || process.env.SUPABASE_URL);
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY', options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  async function assertMembership(userId, deckId, minimumRole = 'viewer') {
    const { data, error } = await supabase
      .from('deck_members')
      .select(MEMBERSHIP_COLUMNS)
      .eq('deck_id', deckId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) fail(403, 'forbidden', 'You are not a member of this deck');
    if (!roleMeetsMinimum(data.role, minimumRole)) fail(403, 'forbidden', `${minimumRole} access required`);
    return {
      deckId: data.deck_id,
      userId: data.user_id,
      role: data.role,
      createdAt: data.created_at
    };
  }

  async function getDeckRows(user, deckId) {
    const membership = await assertMembership(user.id, deckId);
    const [{ data: deck, error: deckError }, { data: cards, error: cardsError }, { data: suggestions, error: suggestionsError }, { data: activity, error: activityError }, { data: conflicts, error: conflictsError }] = await Promise.all([
      supabase.from('decks').select('*').eq('id', deckId).single(),
      supabase.from('cards').select(CARD_COLUMNS).eq('deck_id', deckId).order('created_at'),
      supabase.from('suggestions').select('*').eq('deck_id', deckId).order('created_at', { ascending: false }),
      supabase.from('activity').select(ACTIVITY_COLUMNS).eq('deck_id', deckId).order('created_at', { ascending: false }).limit(100),
      supabase.from('sync_conflicts').select(CONFLICT_COLUMNS).eq('deck_id', deckId).order('detected_at', { ascending: false })
    ]);
    if (deckError) throw deckError;
    if (cardsError) throw cardsError;
    if (suggestionsError) throw suggestionsError;
    if (activityError) throw activityError;
    if (conflictsError) throw conflictsError;
    const fullDeck = toDeck(deck, (cards || []).map(toCard));
    const deckSuggestions = (suggestions || []).map(toSuggestion);
    const lastAddonSync = deck.last_sync_result || null;
    return {
      decks: [fullDeck],
      summaries: [summarizeDeck(fullDeck, deckSuggestions)],
      activeDeckId: deckId,
      role: membership.role,
      collaborators: [],
      suggestions: deckSuggestions,
      activity: (activity || []).map(toActivity),
      sync: {
        ankiConnectUrl: null,
        connected: false,
        lastCheckedAt: lastAddonSync?.syncedAt || null,
        lastPullAt: null,
        lastPushAt: lastAddonSync && !lastAddonSync.stats?.dryRun ? lastAddonSync.syncedAt : fullDeck.lastSyncedAt || null,
        lastAddonSync,
        conflicts: (conflicts || []).map((row) => ({
          id: row.id,
          deckId: row.deck_id,
          cardId: row.card_id,
          source: row.source,
          detectedAt: row.detected_at,
          incomingFields: row.incoming_fields || {},
          localFields: row.local_fields || {}
        }))
      },
      user,
      memberships: [membership]
    };
  }

  return {
    async getMe(user) {
      await supabase.from('profiles').upsert({ id: user.id, email: user.email, name: user.name });
      const { data, error } = await supabase
        .from('deck_members')
        .select(MEMBERSHIP_COLUMNS)
        .eq('user_id', user.id);
      if (error) throw error;
      return {
        user,
        memberships: (data || []).map((row) => ({
          deckId: row.deck_id,
          userId: row.user_id,
          role: row.role,
          createdAt: row.created_at
        }))
      };
    },

    async listDecks(user) {
      const { data: memberships, error } = await supabase.from('deck_members').select('deck_id').eq('user_id', user.id);
      if (error) throw error;
      const ids = (memberships || []).map((row) => row.deck_id);
      if (!ids.length) return [];
      const { data: decks, error: deckError } = await supabase.from('decks').select('*').in('id', ids);
      if (deckError) throw deckError;
      return Promise.all((decks || []).map((deck) => summarizeDeckRow(supabase, deck)));
    },

    async deleteDeck(user, deckId) {
      await assertMembership(user.id, deckId, 'owner');
      const { data: deck, error: deckError } = await supabase.from('decks').select('id,name').eq('id', deckId).single();
      if (deckError || !deck) fail(404, 'deck_not_found', 'Deck not found');
      const { error } = await supabase.from('decks').delete().eq('id', deckId);
      if (error) throw error;
      return {
        deleted: { id: deck.id, name: deck.name },
        state: await this.getDeckState(user)
      };
    },

    async getDeckState(user, deckId) {
      if (!deckId) {
        await supabase.from('profiles').upsert({ id: user.id, email: user.email, name: user.name });
        const { data: memberships, error } = await supabase
          .from('deck_members')
          .select('deck_id')
          .eq('user_id', user.id)
          .order('created_at')
          .limit(1);
        if (error) throw error;
        const firstDeckId = memberships?.[0]?.deck_id;
        if (!firstDeckId) return emptyState(user);
        return getDeckRows(user, firstDeckId);
      }
      return getDeckRows(user, deckId);
    },

    async uploadDeck(user, deck, options = {}) {
      const importedAt = nowIso();
      await supabase.from('profiles').upsert({ id: user.id, email: user.email, name: user.name });
      const { error: deckError } = await supabase.from('decks').insert({
        id: deck.id,
        name: deck.name,
        description: deck.description,
        owner_id: user.id,
        owner_name: user.name,
        imported_at: deck.importedAt || importedAt,
        last_synced_at: deck.lastSyncedAt,
        last_sync_result: addonImportSyncResult(deck),
        media: deck.media || {},
        source: deck.source || {},
        models: deck.models || [],
        ai_settings: normalizeAiSettings()
      });
      if (deckError) throw deckError;
      const { error: memberError } = await supabase.from('deck_members').insert({
        deck_id: deck.id,
        user_id: user.id,
        role: 'owner',
        created_at: importedAt
      });
      if (memberError) throw memberError;
      if (deck.cards.length) {
        const chunkSize = 2000;
        for (let i = 0; i < deck.cards.length; i += chunkSize) {
          const chunk = deck.cards.slice(i, i + chunkSize);
          const { error: cardError } = await supabase.from('cards').insert(chunk.map((card) => cardRowForUpsert(deck.id, card)));
          if (cardError) throw cardError;
        }
      }
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: deck.id,
        user_id: user.id,
        kind: 'import',
        text: `${user.name} imported ${deck.name}`,
        created_at: importedAt
      });
      if (options.returnState === false) return null;
      return getDeckRows(user, deck.id);
    },

    async getDeckAiSettings(user, deckId) {
      await assertMembership(user.id, deckId);
      const { data, error } = await supabase.from('decks').select('ai_settings').eq('id', deckId).single();
      if (error || !data) fail(404, 'deck_not_found', 'Deck not found');
      return normalizeAiSettings(data.ai_settings);
    },

    async updateDeckAiSettings(user, deckId, patch) {
      await assertMembership(user.id, deckId, 'owner');
      const { data: existing, error: existingError } = await supabase.from('decks').select('ai_settings').eq('id', deckId).single();
      if (existingError || !existing) fail(404, 'deck_not_found', 'Deck not found');
      const settings = normalizeAiSettings({
        ...normalizeAiSettings(existing.ai_settings),
        ...Object.fromEntries(
          Object.entries(patch).filter(([, value]) => typeof value === 'boolean')
        ),
        updatedAt: nowIso(),
        updatedBy: user.id
      });
      const { data, error } = await supabase
        .from('decks')
        .update({ ai_settings: settings })
        .eq('id', deckId)
        .select('ai_settings')
        .single();
      if (error) throw error;
      return normalizeAiSettings(data?.ai_settings || settings);
    },

    async listAiArtifacts(user, deckId, filters = {}) {
      await assertMembership(user.id, deckId);
      let query = supabase.from('ai_artifacts')
        .select('*')
        .eq('deck_id', deckId)
        .order('created_at', { ascending: false });
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.kind) query = query.eq('kind', filters.kind);
      if (filters.subjectType) query = query.eq('subject_type', filters.subjectType);
      if (filters.subjectId) query = query.eq('subject_id', filters.subjectId);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(toAiArtifact);
    },

    async createAiArtifact(user, deckId, artifact) {
      await assertMembership(user.id, deckId, 'owner');
      const row = {
        id: artifact.id || `ai-${randomUUID()}`,
        deck_id: deckId,
        subject_type: artifact.subjectType,
        subject_id: artifact.subjectId,
        kind: artifact.kind,
        severity: artifact.severity || 'info',
        status: artifact.status || 'active',
        confidence: artifact.confidence ?? 0,
        model: artifact.model,
        prompt_version: artifact.promptVersion,
        input_hash: artifact.inputHash,
        payload: artifact.payload || {},
        created_at: artifact.createdAt || nowIso(),
        decided_at: artifact.decidedAt || null,
        decided_by: artifact.decidedBy || null
      };
      const { data, error } = await supabase.from('ai_artifacts').insert(row).select('*').single();
      if (error) throw error;
      return toAiArtifact(data || row);
    },

    async updateAiArtifact(user, deckId, artifactId, patch) {
      await assertMembership(user.id, deckId, 'owner');
      const updates = { updated_at: nowIso() };
      if (patch.status) {
        if (!AI_ARTIFACT_STATUSES.has(patch.status)) fail(400, 'invalid_ai_artifact_status', 'Invalid AI artifact status');
        updates.status = patch.status;
        updates.decided_at = nowIso();
        updates.decided_by = user.id;
      }
      if (patch.payload && typeof patch.payload === 'object') updates.payload = patch.payload;
      const { data, error } = await supabase
        .from('ai_artifacts')
        .update(updates)
        .eq('id', artifactId)
        .eq('deck_id', deckId)
        .select('*')
        .single();
      if (error || !data) fail(404, 'ai_artifact_not_found', 'AI artifact not found');
      return toAiArtifact(data);
    },

    async dismissAiArtifact(user, deckId, artifactId) {
      return this.updateAiArtifact(user, deckId, artifactId, { status: 'dismissed' });
    },

    async markAiArtifactsStale(user, deckId, filters = {}) {
      await assertMembership(user.id, deckId, 'owner');
      const updates = {
        status: 'stale',
        updated_at: nowIso(),
        decided_at: nowIso(),
        decided_by: user.id
      };
      let query = supabase.from('ai_artifacts')
        .update(updates)
        .eq('deck_id', deckId)
        .eq('status', 'active');
      if (filters.subjectType) query = query.eq('subject_type', filters.subjectType);
      if (filters.subjectId) query = query.eq('subject_id', filters.subjectId);
      if (filters.kind) query = query.eq('kind', filters.kind);
      const { data, error } = await query.select('id');
      if (error) throw error;
      return { stale: data?.length || 0 };
    },

    async upsertCardEmbedding(user, deckId, embedding) {
      await assertMembership(user.id, deckId, 'owner');
      const row = {
        card_id: embedding.cardId,
        deck_id: deckId,
        model: embedding.model,
        dimensions: embedding.dimensions,
        input_hash: embedding.inputHash,
        embedding: Array.isArray(embedding.embedding) ? embedding.embedding : [],
        status: embedding.status || 'active',
        metadata: embedding.metadata || {},
        updated_at: nowIso()
      };
      const { data, error } = await supabase
        .from('card_embeddings')
        .upsert(row, { onConflict: 'card_id' })
        .select('*')
        .single();
      if (error) throw error;
      return toCardEmbedding(data || row);
    },

    async listCardEmbeddings(user, deckId, filters = {}) {
      await assertMembership(user.id, deckId);
      let query = supabase.from('card_embeddings').select('*').eq('deck_id', deckId);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.cardId) query = query.eq('card_id', filters.cardId);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(toCardEmbedding);
    },

    async findSimilarCards(user, deckId, sourceCardId, embedding, { topK = 5, threshold = 0.7 } = {}) {
      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) return { similar: [] };

      const vectorStr = `[${embedding.join(',')}]`;

      const { data, error } = await this.supabase.rpc('find_similar_cards', {
        p_deck_id: deckId,
        p_source_card_id: sourceCardId,
        p_embedding: vectorStr,
        p_top_k: topK,
        p_threshold: threshold
      });

      if (error) {
        const { data: cards } = await this.supabase
          .from('cards')
          .select('*')
          .eq('deck_id', deckId)
          .not('embedding', 'is', null);

        const similar = (cards || [])
          .filter((c) => c.id !== sourceCardId)
          .map((c) => ({
            card: toCard(c),
            score: cosineSimilarity(embedding, c.embedding || [])
          }))
          .filter((item) => item.score >= threshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);

        return { similar };
      }

      return { similar: (data || []).map((row) => ({ card: toCard(row), score: row.similarity })) };
    },

    async markCardEmbeddingsStale(user, deckId, cardIds = [], minimumRole = 'owner') {
      await assertMembership(user.id, deckId, minimumRole);
      const ids = (Array.isArray(cardIds) ? cardIds : [cardIds]).filter(Boolean).map(String);
      const now = nowIso();
      let embeddingQuery = supabase.from('card_embeddings')
        .update({ status: 'stale', updated_at: now })
        .eq('deck_id', deckId)
        .eq('status', 'active');
      if (ids.length) embeddingQuery = embeddingQuery.in('card_id', ids);
      const { data, error } = await embeddingQuery.select('card_id');
      if (error) throw error;

      if (ids.length) {
        const { error: sourceLinkError } = await supabase.from('ai_duplicate_links')
          .update({ status: 'stale', updated_at: now })
          .eq('deck_id', deckId)
          .eq('status', 'active')
          .in('source_card_id', ids);
        if (sourceLinkError) throw sourceLinkError;
        const { error: targetLinkError } = await supabase.from('ai_duplicate_links')
          .update({ status: 'stale', updated_at: now })
          .eq('deck_id', deckId)
          .eq('status', 'active')
          .in('target_card_id', ids);
        if (targetLinkError) throw targetLinkError;
      } else {
        const { error: linkError } = await supabase.from('ai_duplicate_links')
          .update({ status: 'stale', updated_at: now })
          .eq('deck_id', deckId)
          .eq('status', 'active');
        if (linkError) throw linkError;
      }
      return { stale: data?.length || 0 };
    },

    async upsertAiDuplicateLink(user, deckId, link) {
      await assertMembership(user.id, deckId, 'owner');
      const id = link.id || `dup-${randomUUID()}`;
      const row = {
        id,
        deck_id: deckId,
        source_card_id: link.sourceCardId,
        target_card_id: link.targetCardId,
        artifact_id: link.artifactId || null,
        score: link.score,
        relationship: link.relationship,
        rationale: link.rationale || '',
        compared_fields: Array.isArray(link.comparedFields) ? link.comparedFields : [],
        status: link.status || 'active',
        updated_at: nowIso()
      };
      const { data: existing, error: existingError } = await supabase
        .from('ai_duplicate_links')
        .select('id')
        .eq('deck_id', deckId)
        .eq('source_card_id', link.sourceCardId)
        .eq('target_card_id', link.targetCardId)
        .maybeSingle();
      if (existingError) throw existingError;
      const query = existing?.id
        ? supabase.from('ai_duplicate_links').update({ ...row, id: existing.id }).eq('id', existing.id)
        : supabase.from('ai_duplicate_links').insert(row);
      const { data, error } = await query.select('*').single();
      if (error) throw error;
      return toAiDuplicateLink(data || row);
    },

    async listAiDuplicateLinks(user, deckId, filters = {}) {
      await assertMembership(user.id, deckId);
      const limit = Math.min(Math.max(Number(filters.limit) || 25, 1), 100);
      let query = supabase.from('ai_duplicate_links')
        .select('*')
        .eq('deck_id', deckId)
        .order('score', { ascending: false })
        .limit(limit);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.cardId) {
        query = query.or(`source_card_id.eq.${filters.cardId},target_card_id.eq.${filters.cardId}`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(toAiDuplicateLink);
    },

    async createSuggestion(user, payload) {
      await assertMembership(user.id, payload.deckId, 'contributor');
      const { data: card, error: cardError } = await supabase.from('cards').select('id').eq('id', payload.cardId).eq('deck_id', payload.deckId).single();
      if (cardError || !card) fail(404, 'card_not_found', 'Card not found');
      const createdAt = nowIso();
      const suggestion = {
        id: `sugg-${randomUUID()}`,
        deck_id: payload.deckId,
        card_id: payload.cardId,
        author_id: user.id,
        author_name: user.name,
        status: 'pending',
        reason: payload.reason,
        created_at: createdAt,
        proposed_fields: payload.proposedFields,
        proposed_tags: payload.proposedTags
      };
      const { error } = await supabase.from('suggestions').insert(suggestion);
      if (error) throw error;
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: payload.deckId,
        user_id: user.id,
        kind: 'suggestion',
        text: `${user.name} suggested a change`,
        created_at: createdAt
      });
      return getDeckRows(user, payload.deckId);
    },

    async updateModelTemplate(user, deckId, modelName, patch) {
      await assertMembership(user.id, deckId, 'owner');
      const now = nowIso();
      const { data: rows, error: selectError } = await supabase
        .from('cards')
        .select('id')
        .eq('deck_id', deckId)
        .eq('model_name', modelName);
      if (selectError) throw selectError;
      if (!rows?.length) fail(404, 'model_not_found', 'Model not found in this deck');
      const { error } = await supabase.from('cards').update({
        template_front: patch.templateFront,
        template_back: patch.templateBack,
        model_css: patch.modelCss,
        rendered_front: null,
        rendered_back: null,
        modified_at: now,
        modified_by: user.name
      }).eq('deck_id', deckId).eq('model_name', modelName);
      if (error) throw error;
      await this.markCardEmbeddingsStale(user, deckId, (rows || []).map((row) => row.id));
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: deckId,
        user_id: user.id,
        kind: 'template',
        text: `${user.name} updated the ${modelName} model template`,
        created_at: now
      });
      return getDeckRows(user, deckId);
    },

    async decideSuggestion(user, suggestionId, decision) {
      const { data: suggestion, error } = await supabase.from('suggestions').select('*').eq('id', suggestionId).single();
      if (error || !suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      if (suggestion.status !== 'pending') fail(409, 'suggestion_reviewed', 'Suggestion has already been reviewed');
      await assertMembership(user.id, suggestion.deck_id, 'reviewer');
      if (decision === 'accepted') {
        await this.createCardVersion(user, suggestion.deck_id, suggestion.card_id);
        const { data: card, error: cardError } = await supabase.from('cards').select(CARD_COLUMNS).eq('id', suggestion.card_id).single();
        if (cardError || !card) fail(404, 'card_not_found', 'Card not found');
        const nextCard = applySuggestion(toDeck({ id: suggestion.deck_id, name: '', imported_at: nowIso() }, [toCard(card)]), toSuggestion(suggestion), user.name);
        const { error: updateCardError } = await supabase.from('cards').update({
          fields: nextCard.fields,
          tags: nextCard.tags,
          modified_at: nextCard.modifiedAt,
          modified_by: nextCard.modifiedBy
        }).eq('id', suggestion.card_id);
        if (updateCardError) throw updateCardError;
        await this.markCardEmbeddingsStale(user, suggestion.deck_id, [suggestion.card_id]);
      }
      const reviewedAt = nowIso();
      const { error: updateError } = await supabase.from('suggestions').update({
        status: decision,
        reviewed_at: reviewedAt,
        reviewed_by: user.name
      }).eq('id', suggestionId);
      if (updateError) throw updateError;
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: suggestion.deck_id,
        user_id: user.id,
        kind: decision,
        text: `${user.name} ${decision} ${suggestion.author_name}'s suggestion`,
        created_at: reviewedAt
      });
      return getDeckRows(user, suggestion.deck_id);
    },

    async bulkDecideSuggestions(user, deckId, suggestionIds, decision) {
      if (new Set(suggestionIds).size !== suggestionIds.length) fail(400, 'duplicate_suggestion_ids', 'suggestionIds must be unique');
      const reviewedAt = nowIso();
      let acceptedCardIds = [];
      if (decision === 'accepted') {
        const { data: acceptedRows, error: acceptedRowsError } = await supabase
          .from('suggestions')
          .select('card_id')
          .eq('deck_id', deckId)
          .in('id', suggestionIds);
        if (acceptedRowsError) throw acceptedRowsError;
        acceptedCardIds = (acceptedRows || []).map((row) => row.card_id).filter(Boolean);
        const uniqueCardIds = [...new Set(acceptedCardIds)];
        for (const cid of uniqueCardIds) {
          await this.createCardVersion(user, deckId, cid);
        }
      }
      const { error } = await supabase.rpc('bulk_decide_suggestions', {
        p_deck_id: deckId,
        p_suggestion_ids: suggestionIds,
        p_decision: decision,
        p_reviewer_id: user.id,
        p_reviewer_name: user.name,
        p_activity_id: `act-${randomUUID()}`,
        p_reviewed_at: reviewedAt
      });
      if (error) throw error;
      if (acceptedCardIds.length) await this.markCardEmbeddingsStale(user, deckId, acceptedCardIds);
      return getDeckRows(user, deckId);
    },

    async listSuggestionComments(user, suggestionId) {
      const { data: suggestion, error: suggestionError } = await supabase
        .from('suggestions')
        .select('deck_id')
        .eq('id', suggestionId)
        .single();
      if (suggestionError || !suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      await assertMembership(user.id, suggestion.deck_id, 'contributor');
      const { data, error } = await supabase
        .from('comments')
        .select('id, suggestion_id, deck_id, author_id, author_name, body, parent_id, created_at, updated_at, resolved_at, resolved_by')
        .eq('suggestion_id', suggestionId)
        .eq('deck_id', suggestion.deck_id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(toComment);
    },

    async createSuggestionComment(user, suggestionId, payload) {
      const { data: suggestion, error: suggestionError } = await supabase
        .from('suggestions')
        .select('deck_id,author_id')
        .eq('id', suggestionId)
        .single();
      if (suggestionError || !suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      await assertMembership(user.id, suggestion.deck_id, 'contributor');
      if (payload.parentId) {
        const { data: parent, error: parentError } = await supabase
          .from('comments')
          .select('id')
          .eq('id', payload.parentId)
          .eq('suggestion_id', suggestionId)
          .eq('deck_id', suggestion.deck_id)
          .single();
        if (parentError || !parent) fail(404, 'comment_not_found', 'Parent comment not found');
      }
      const createdAt = nowIso();
      const id = `comment-${randomUUID()}`;
      const { data, error } = await supabase.from('comments').insert({
        id,
        suggestion_id: suggestionId,
        deck_id: suggestion.deck_id,
        author_id: user.id,
        author_name: user.name,
        body: payload.body,
        parent_id: payload.parentId || null,
        created_at: createdAt,
        resolved_at: null,
        resolved_by: null
      }).select('id, suggestion_id, deck_id, author_id, author_name, body, parent_id, created_at, updated_at, resolved_at, resolved_by').single();
      if (error) throw error;
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: suggestion.deck_id,
        user_id: user.id,
        kind: 'comment',
        text: `${user.name} commented on a suggestion`,
        created_at: createdAt
      });
      return toComment(data);
    },

    async setSuggestionCommentResolved(user, suggestionId, commentId, resolved) {
      const { data: suggestion, error: suggestionError } = await supabase
        .from('suggestions')
        .select('deck_id')
        .eq('id', suggestionId)
        .single();
      if (suggestionError || !suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      const { data: comment, error: commentError } = await supabase
        .from('comments')
        .select('id, suggestion_id, deck_id, resolved_at')
        .eq('id', commentId)
        .eq('suggestion_id', suggestionId)
        .eq('deck_id', suggestion.deck_id)
        .is('parent_id', null)
        .single();
      if (commentError || !comment) fail(404, 'comment_not_found', 'Comment not found');
      await assertMembership(user.id, comment.deck_id, 'reviewer');
      const nextResolved = typeof resolved === 'boolean' ? resolved : !comment.resolved_at;
      const { data, error } = await supabase
        .from('comments')
        .update({
          resolved_at: nextResolved ? nowIso() : null,
          resolved_by: nextResolved ? user.id : null,
          updated_at: nowIso()
        })
        .eq('id', commentId)
        .eq('suggestion_id', suggestionId)
        .eq('deck_id', suggestion.deck_id)
        .is('parent_id', null)
        .select('id, suggestion_id, deck_id, author_id, author_name, body, parent_id, created_at, updated_at, resolved_at, resolved_by')
        .single();
      if (error) throw error;
      return toComment(data);
    },

    async getExportDeck(user, deckId) {
      const state = await getDeckRows(user, deckId);
      return state.decks[0];
    },

    async storeExport(user, deckId, apkgPath, filename) {
      await assertMembership(user.id, deckId);
      const bucket = process.env.SUPABASE_EXPORTS_BUCKET || 'deckbridge-exports';
      const storagePath = `${deckId}/${filename}`;
      const { sizeBytes, sha256 } = await hashFile(apkgPath);
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(storagePath, createReadStream(apkgPath), {
          contentType: 'application/octet-stream',
          upsert: true,
          metadata: {
            deckId,
            filename,
            sha256,
            sizeBytes
          }
        });
      if (uploadError) throw uploadError;
      await upsertManagedFileRows(supabase, [managedFileRow({
        deckId,
        kind: 'export',
        filename,
        bucket,
        storagePath,
        sha256,
        sizeBytes,
        status: 'available',
        userId: user.id,
        metadata: { source: 'deck-export' }
      })]);
      const expiresIn = Number(process.env.EXPORT_SIGNED_URL_SECONDS || 3600);
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
      if (error) throw error;
      return {
        filename,
        url: data.signedUrl,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
      };
    },

    async createMediaUploadTargets(user, deckId, files) {
      await assertMembership(user.id, deckId, 'editor');
      const bucket = mediaBucket();
      const { uploads, fileRows } = await createSignedMediaUploadTargets({
        supabase,
        bucket,
        deckId,
        files,
        userId: user.id,
        concurrency: boundedPositiveInteger(process.env.MEDIA_UPLOAD_TARGET_CONCURRENCY, MEDIA_UPLOAD_TARGET_CONCURRENCY)
      });
      await upsertManagedFileRows(supabase, fileRows);
      return uploads;
    },

    async createMediaDownload(user, deckId, asset) {
      await assertMembership(user.id, deckId, 'viewer');
      const bucket = asset.storageBucket || mediaBucket();
      const storagePath = assertDeckStoragePath(deckId, asset);
      const expiresIn = Number(process.env.MEDIA_SIGNED_URL_SECONDS || 3600);
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
      if (error) throw error;
      await supabase.from('deck_files')
        .update({ last_accessed_at: nowIso(), updated_at: nowIso() })
        .eq('storage_bucket', bucket)
        .eq('storage_path', storagePath);
      return {
        url: data.signedUrl,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
      };
    },

    async getManagedMediaAsset(user, deckId, filename) {
      await assertMembership(user.id, deckId, 'viewer');
      const { data, error } = await supabase.from('deck_files')
        .select('filename,storage_bucket,storage_path,sha256,size_bytes,mime_type,status')
        .eq('deck_id', deckId)
        .eq('file_kind', 'media')
        .eq('filename', filename)
        .eq('status', 'available')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return mediaAssetFromFileRow(data);
    },

    async recordExport(user, deckId, download) {
      await assertMembership(user.id, deckId);
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: deckId,
        user_id: user.id,
        kind: 'export',
        text: `${user.name} exported a deck`,
        created_at: nowIso()
      });
      return { download, state: await getDeckRows(user, deckId) };
    },

    async createStudySession(user, session) {
      await assertMembership(user.id, session.deckId);
      const now = nowIso();
      const row = {
        id: session.id || `study-${randomUUID()}`,
        user_id: user.id,
        deck_id: session.deckId,
        started_at: session.startedAt || now,
        ended_at: session.endedAt || null,
        duration_seconds: session.durationSeconds || 0,
        cards_studied: session.cardsStudied || 0,
        cards_correct: session.cardsCorrect || 0,
        new_cards: session.newCards || 0,
        review_cards: session.reviewCards || 0,
        metadata: session.metadata || {},
        created_at: now
      };
      const { data, error } = await supabase.from('study_sessions').insert(row).select('*').single();
      if (error) throw error;
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: session.deckId,
        user_id: user.id,
        kind: 'study',
        text: `${user.name} studied ${row.cards_studied} card(s)`,
        created_at: now
      });
      return toStudySession(data || row);
    },

    async listStudySessions(user, deckId, options = {}) {
      if (deckId) await assertMembership(user.id, deckId);
      const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
      let query = supabase.from('study_sessions')
        .select('*')
        .eq('user_id', user.id)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (deckId) query = query.eq('deck_id', deckId);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(toStudySession);
    },

    async createShareLink(user, deckId, link) {
      await assertMembership(user.id, deckId, 'owner');
      const row = {
        id: link.id || `share-${randomUUID()}`,
        deck_id: deckId,
        created_by: user.id,
        token: link.token,
        label: link.label || 'Share link',
        password_hash: link.passwordHash || null,
        expires_at: link.expiresAt || null,
        disabled_at: null,
        created_at: nowIso()
      };
      const { data, error } = await supabase.from('deck_share_links').insert(row).select('*').single();
      if (error) throw error;
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: deckId,
        user_id: user.id,
        kind: 'share',
        text: `${user.name} created a share link`,
        created_at: row.created_at
      });
      return toShareLink(data || row);
    },

    async listShareLinks(user, deckId) {
      await assertMembership(user.id, deckId, 'owner');
      const { data, error } = await supabase.from('deck_share_links')
        .select('id, deck_id, created_by, token, label, password_hash, expires_at, disabled_at, created_at')
        .eq('deck_id', deckId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(toShareLink);
    },

    async listCardsCursor(deckId, { cursor, limit }) {
      const { supabase } = this;
      let query = supabase
        .from('cards')
        .select(CARD_COLUMNS)
        .eq('deck_id', deckId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit);

      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded) {
          query = query.or(`created_at.gt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.gt.${decoded.id})`);
        }
      }

      const { data, error } = await query;
      if (error) throw new Error(`listCardsCursor failed: ${error.message}`);

      const cards = (data || []).map(toCard);
      const nextCursor = cards.length === limit ? encodeCursor(cards[cards.length - 1]) : null;
      return { cards, nextCursor };
    },

    async listActivity(user, deckId, filters = {}) {
      await assertMembership(user.id, deckId);
      const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
      let query = supabase.from('activity')
        .select('*')
        .eq('deck_id', deckId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (Array.isArray(filters.kinds) && filters.kinds.length === 1) query = query.eq('kind', filters.kinds[0]);
      if (filters.since) query = query.gte('created_at', filters.since);
      if (filters.until) query = query.lte('created_at', filters.until);
      const { data, error } = await query;
      if (error) throw error;
      const kinds = Array.isArray(filters.kinds) ? filters.kinds : [];
      return (data || [])
        .map(toActivity)
        .filter((activity) => !kinds.length || kinds.includes(activity.kind));
    },

    async createCardVersion(user, deckId, cardId) {
      const { data: cards, error: cardError } = await supabase.from('cards').select('*').eq('id', cardId).eq('deck_id', deckId).single();
      if (cardError || !cards) fail(404, 'card_not_found', 'Card not found');
      const snapshot = snapshotCard(cards);
      const { data, error } = await supabase.from('deck_card_versions').insert({
        card_id: cardId,
        deck_id: deckId,
        snapshot,
        created_by: user?.name || 'system'
      }).select().single();
      if (error) throw new Error(`createCardVersion failed: ${error.message}`);
      return data;
    },

    async listCardVersions(user, deckId, cardId) {
      const { data, error } = await supabase
        .from('deck_card_versions')
        .select('id, created_at, created_by')
        .eq('card_id', cardId)
        .eq('deck_id', deckId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`listCardVersions failed: ${error.message}`);
      return {
        versions: (data || []).map((v) => ({
          id: v.id,
          createdAt: v.created_at,
          createdBy: v.created_by
        }))
      };
    },

    async getCardVersion(user, deckId, cardId, versionId) {
      const { data, error } = await supabase
        .from('deck_card_versions')
        .select('*')
        .eq('id', versionId)
        .eq('card_id', cardId)
        .eq('deck_id', deckId)
        .single();
      if (error && error.code === 'PGRST116') fail(404, 'version_not_found', 'Version not found');
      if (error) throw new Error(`getCardVersion failed: ${error.message}`);
      return { version: { id: data.id, snapshot: data.snapshot } };
    },

    async rollbackCardToVersion(user, deckId, cardId, versionId) {
      const member = await supabase.from('deck_members').select('role').eq('deck_id', deckId).eq('user_id', user.id).single();
      if (!member || roleRank[member.data?.role] < roleRank.editor) {
        fail(403, 'forbidden', 'Only editors can rollback cards');
      }
      const { data: version, error: versionError } = await supabase
        .from('deck_card_versions')
        .select('*')
        .eq('id', versionId)
        .eq('card_id', cardId)
        .eq('deck_id', deckId)
        .single();
      if (versionError || !version) fail(404, 'version_not_found', 'Version not found');

      const { data: card } = await supabase.from('cards').select('*').eq('id', cardId).single();
      if (card && card.modified_at > version.created_at) {
        fail(409, 'card_modified_after_version', 'Card was modified after this version was created');
      }

      const preSnapshot = snapshotCard(card);
      await supabase.from('deck_card_versions').insert({
        card_id: cardId,
        deck_id: deckId,
        snapshot: preSnapshot,
        created_by: user?.name || 'system'
      });

      const snap = version.snapshot;
      const { error: updateError } = await supabase
        .from('cards')
        .update({
          fields: snap.fields,
          tags: snap.tags,
          modified_at: new Date().toISOString(),
          modified_by: user.name || 'rollback'
        })
        .eq('id', cardId);
      if (updateError) throw new Error(`rollback failed: ${updateError.message}`);

      const { data: updatedCard } = await supabase.from('cards').select('*').eq('id', cardId).single();
      return { card: updatedCard, priorVersion: { id: version.id } };
    },

    async recordSyncConflicts(user, deckId, conflicts) {
      await assertMembership(user.id, deckId, 'editor');
      await supabase.from('sync_conflicts').delete().eq('deck_id', deckId);
      if (conflicts.length) {
        const { error } = await supabase.from('sync_conflicts').insert(conflicts.map((conflict) => ({
          id: conflict.id || `conflict-${randomUUID()}`,
          deck_id: deckId,
          card_id: conflict.cardId,
          source: conflict.source || 'Local bridge',
          detected_at: conflict.detectedAt || nowIso(),
          incoming_fields: conflict.incomingFields || {},
          local_fields: conflict.localFields || {}
        })));
        if (error) throw error;
      }
      return getDeckRows(user, deckId);
    },

    async syncCardsFromAddon(user, deckId, syncInput) {
      await assertMembership(user.id, deckId, 'editor');
      const [{ data: deckRow, error: deckError }, candidateCards] = await Promise.all([
        supabase.from('decks').select(DECK_SYNC_COLUMNS).eq('id', deckId).single(),
        fetchSyncCandidateCards(supabase, deckId, syncInput.cards)
      ]);
      if (deckError || !deckRow) fail(404, 'deck_not_found', 'Deck not found');
      const deck = toDeck(deckRow, candidateCards);
      const result = mergeAddonCards(deck, syncInput, user.name);
      const lastAddonSync = addMediaReceivedToSyncProof(
        syncInput,
        buildAddonSyncResult(syncInput, result, deckRow.last_sync_result || null),
        deckRow.last_sync_result || null
      );
      const isFirstBatchChunk = !syncInput.batch || syncInput.batch.index === 0;
      const isFinalBatchChunk = !syncInput.batch || syncInput.batch.index + 1 >= syncInput.batch.total;

      if (!syncInput.dryRun) {
        const changedCards = [...result.createdCards, ...result.updatedCards];
        if (changedCards.length) {
          await upsertSyncCards(supabase, deck.id, changedCards);
          try {
            await this.markCardEmbeddingsStale(user, deck.id, changedCards.map((card) => card.id), 'editor');
          } catch (error) {
            if (!isOptionalAiSchemaError(error)) throw error;
          }
        }
        if (isFirstBatchChunk) {
          await supabase.from('sync_conflicts').delete().eq('deck_id', deck.id);
        }
        if (result.conflicts.length) {
          const { error } = await supabase.from('sync_conflicts').insert(result.conflicts.map((conflict) => ({
            id: conflict.id,
            deck_id: deck.id,
            card_id: conflict.cardId,
            source: conflict.source,
            detected_at: conflict.detectedAt,
            incoming_fields: conflict.incomingFields,
            local_fields: conflict.localFields
          })));
          if (error) throw error;
        }
        const deckUpdate = {
          last_synced_at: result.syncedAt,
          last_sync_result: lastAddonSync
        };
        const inlineMedia = inlineDeckMedia(syncInput.media || {});
        const appliedStorageMedia = storageDeckMedia(syncInput.media || {});
        if (Object.keys(inlineMedia).length || Object.keys(appliedStorageMedia).length) {
          deckUpdate.media = inlineMedia;
        }
        const { error: deckError } = await supabase.from('decks').update(deckUpdate).eq('id', deck.id);
        if (deckError) throw deckError;
        await upsertManagedFileRows(supabase, managedMediaRows(deck.id, appliedStorageMedia, user.id, 'available'));
        if (isFinalBatchChunk) {
          await supabase.from('activity').insert({
            id: `act-${randomUUID()}`,
            deck_id: deck.id,
            user_id: user.id,
            kind: 'sync',
            text: `${user.name} synced ${lastAddonSync.stats.total} Anki card(s): ${lastAddonSync.stats.created} new, ${lastAddonSync.stats.updated} updated, ${lastAddonSync.stats.conflicts} conflict(s)`,
            created_at: result.syncedAt
          });
        }
      } else {
        const { error: deckError } = await supabase.from('decks').update({
          last_sync_result: lastAddonSync
        }).eq('id', deck.id);
        if (deckError) throw deckError;
      }

      const response = {
        result: {
          syncedAt: result.syncedAt,
          source: lastAddonSync.source,
          client: lastAddonSync.client,
          stats: lastAddonSync.stats,
          proof: lastAddonSync,
          conflicts: result.conflicts
        }
      };
      if (syncInput.returnState !== false) response.state = await getDeckRows(user, deck.id);
      return response;
    }
  };
}
