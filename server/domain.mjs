import { randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export function tagList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

export function cleanText(value, fallback = '', maxLength = 4000) {
  const text = String(value ?? fallback).trim();
  return text.slice(0, maxLength);
}

export function normalizeSuggestionInput(body, card) {
  const proposedFields = body?.proposedFields && typeof body.proposedFields === 'object' && !Array.isArray(body.proposedFields)
    ? Object.fromEntries(
        Object.entries(body.proposedFields)
          .slice(0, 50)
          .map(([key, value]) => [cleanText(key, '', 80), cleanText(value)])
          .filter(([key]) => key)
      )
    : {};

  const proposedTags = Array.from(
    new Set((Array.isArray(body?.proposedTags) ? body.proposedTags : card.tags).map((tag) => cleanText(tag, '', 80)).filter(Boolean))
  ).slice(0, 100);

  if (!Object.keys(proposedFields).length && proposedTags.join(' ') === card.tags.join(' ')) {
    throw new Error('Suggestion must include a field or tag change');
  }

  return {
    reason: cleanText(body?.reason, 'Suggested from web app review.', 600) || 'Suggested from web app review.',
    proposedFields,
    proposedTags
  };
}

export function normalizeParsedDeck(parsed, sourceName = 'Imported Deck') {
  const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
  const deckName = parsed?.deck_name || parsed?.name || sourceName.replace(/\.apkg$/i, '') || 'Imported Deck';
  const normalizedCards = cards.map((card, index) => {
    const fields = card.fields && typeof card.fields === 'object'
      ? Object.fromEntries(Object.entries(card.fields).map(([key, value]) => [key, String(value ?? '')]))
      : {
          Front: String(card.front ?? card.question ?? ''),
          Back: String(card.back ?? card.answer ?? '')
        };

    if (!('Front' in fields) && 'front' in card) fields.Front = String(card.front ?? '');
    if (!('Back' in fields) && 'back' in card) fields.Back = String(card.back ?? '');
    const fieldOrder = Array.isArray(card.fieldOrder)
      ? card.fieldOrder.map(String).filter((field) => field in fields)
      : Object.keys(fields);
    const noteType = String(card.type || card.noteType || card.modelName || 'Basic');

    return {
      id: String(card.id || card.noteId || card.guid || `card-${index + 1}-${randomUUID()}`),
      ankiNoteId: card.noteId || card.ankiNoteId || null,
      type: noteType,
      modelName: String(card.modelName || card.noteType || noteType),
      fieldOrder,
      fields,
      tags: tagList(card.tags),
      due: Number.isFinite(Number(card.due)) ? Number(card.due) : null,
      state: card.state || card.queue || 'New',
      modifiedAt: nowIso(),
      modifiedBy: 'Import',
      suspended: Boolean(card.suspended),
      mediaRefs: Array.isArray(card.mediaRefs) ? card.mediaRefs.map(String) : [],
      sourceDeckName: card.deckName || parsed?.deck_name || deckName,
      sourceDeckPath: card.deckPath || parsed?.deck_path || null
    };
  });

  return {
    id: `deck-${randomUUID()}`,
    name: deckName,
    description: parsed?.description || `${deckName} imported from Anki package`,
    owner: 'You',
    importedAt: nowIso(),
    lastSyncedAt: null,
    cards: normalizedCards,
    media: parsed?.media || {},
    models: parsed?.models || [],
    source: {
      filename: sourceName,
      format: 'apkg',
      deckName,
      deckPath: parsed?.deck_path || deckName
    }
  };
}

function cleanFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  return Object.fromEntries(
    Object.entries(fields)
      .slice(0, 80)
      .map(([key, value]) => [cleanText(key, '', 120), cleanText(value, '', 12000)])
      .filter(([key]) => key)
  );
}

function normalizeAddonCard(card, index) {
  const fields = cleanFields(card.fields);
  if (!Object.keys(fields).length) {
    throw new Error(`Sync card ${index + 1} must include fields`);
  }
  const fieldOrder = Array.isArray(card.fieldOrder)
    ? card.fieldOrder.map((field) => cleanText(field, '', 120)).filter((field) => field && field in fields)
    : Object.keys(fields);
  const ankiNoteId = Number.isFinite(Number(card.ankiNoteId)) ? Number(card.ankiNoteId) : null;
  const noteType = cleanText(card.type || card.noteType || card.modelName, 'Basic', 120);

  return {
    id: cleanText(card.id, ankiNoteId ? `anki-${ankiNoteId}` : `anki-${randomUUID()}`, 160),
    ankiNoteId,
    type: noteType,
    modelName: cleanText(card.modelName || card.noteType || noteType, noteType, 120),
    fieldOrder,
    fields,
    tags: Array.from(new Set(tagList(card.tags).map((tag) => cleanText(tag, '', 120)).filter(Boolean))).slice(0, 200),
    due: Number.isFinite(Number(card.due)) ? Number(card.due) : null,
    state: cleanText(card.state, 'Anki', 80),
    modifiedAt: cleanText(card.modifiedAt, nowIso(), 80),
    modifiedBy: cleanText(card.modifiedBy, 'DeckBridge Anki add-on', 120),
    suspended: Boolean(card.suspended),
    mediaRefs: Array.isArray(card.mediaRefs) ? card.mediaRefs.map((ref) => cleanText(ref, '', 500)).filter(Boolean) : [],
    sourceDeckName: cleanText(card.sourceDeckName || card.deckName, '', 240) || null,
    sourceDeckPath: cleanText(card.sourceDeckPath || card.deckPath, '', 500) || null
  };
}

export function normalizeAddonSyncInput(body = {}) {
  const cards = Array.isArray(body.cards) ? body.cards : [];
  if (!cards.length) throw new Error('Sync payload must include cards');
  if (cards.length > 50000) throw new Error('Sync payload exceeds the 50000-card limit');
  const conflictPolicy = ['detect', 'overwrite-platform'].includes(body.conflictPolicy)
    ? body.conflictPolicy
    : 'detect';

  return {
    cards: cards.map(normalizeAddonCard),
    dryRun: Boolean(body.dryRun),
    allowCreate: body.allowCreate !== false,
    conflictPolicy,
    source: cleanText(body.source, 'DeckBridge Anki add-on', 120),
    client: body.client && typeof body.client === 'object' ? {
      name: cleanText(body.client.name, 'DeckBridge Anki add-on', 120),
      version: cleanText(body.client.version, 'unknown', 80),
      fingerprint: cleanText(body.client.fingerprint, '', 200)
    } : null
  };
}

export function normalizeAddonDeckCreateInput(body = {}, user = {}) {
  const syncInput = normalizeAddonSyncInput({
    ...body,
    dryRun: false,
    allowCreate: true
  });
  const createdAt = nowIso();
  const firstCard = syncInput.cards[0] || {};
  const deckName = cleanText(
    body.deckName || body.name || firstCard.sourceDeckName,
    'Synced Anki Deck',
    180
  ) || 'Synced Anki Deck';
  const deckPath = cleanText(body.deckPath || firstCard.sourceDeckPath || deckName, deckName, 500);
  const cards = syncInput.cards.map((card) => ({
    ...card,
    modifiedAt: card.modifiedAt || createdAt,
    modifiedBy: card.modifiedBy || user.name || 'Anki'
  }));

  return {
    deck: {
      id: `deck-${randomUUID()}`,
      name: deckName,
      description: cleanText(
        body.description,
        `${deckName} synced from Anki.`,
        600
      ) || `${deckName} synced from Anki.`,
      owner: user.name || 'DeckBridge User',
      importedAt: createdAt,
      lastSyncedAt: createdAt,
      cards,
      media: {},
      models: [],
      source: {
        filename: null,
        format: 'anki-addon',
        deckName,
        deckPath,
        client: syncInput.client
      }
    },
    result: {
      syncedAt: createdAt,
      stats: {
        total: cards.length,
        created: cards.length,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        dryRun: false
      },
      conflicts: []
    }
  };
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function copySyncedCard(card, actorName, timestamp) {
  return {
    ...card,
    modifiedAt: timestamp,
    modifiedBy: actorName || card.modifiedBy || 'DeckBridge Anki add-on'
  };
}

export function mergeAddonCards(deck, syncInput, actorName = 'DeckBridge Anki add-on') {
  const syncedAt = nowIso();
  const byId = new Map(deck.cards.map((card) => [card.id, card]));
  const byNoteId = new Map(deck.cards.filter((card) => card.ankiNoteId).map((card) => [String(card.ankiNoteId), card]));
  const result = {
    syncedAt,
    stats: {
      total: syncInput.cards.length,
      created: 0,
      updated: 0,
      skipped: 0,
      conflicts: 0,
      dryRun: syncInput.dryRun
    },
    createdCards: [],
    updatedCards: [],
    conflicts: []
  };

  for (const incoming of syncInput.cards) {
    const existing = byId.get(incoming.id) || (incoming.ankiNoteId ? byNoteId.get(String(incoming.ankiNoteId)) : null);
    if (!existing) {
      if (!syncInput.allowCreate) {
        result.stats.skipped += 1;
        continue;
      }
      const created = copySyncedCard(incoming, actorName, syncedAt);
      result.createdCards.push(created);
      result.stats.created += 1;
      if (!syncInput.dryRun) {
        deck.cards.push(created);
        byId.set(created.id, created);
        if (created.ankiNoteId) byNoteId.set(String(created.ankiNoteId), created);
      }
      continue;
    }

    const changed = !sameJson(existing.fields, incoming.fields)
      || !sameJson(existing.tags, incoming.tags)
      || existing.state !== incoming.state
      || existing.suspended !== incoming.suspended
      || existing.type !== incoming.type;
    if (!changed) {
      result.stats.skipped += 1;
      continue;
    }

    if (syncInput.conflictPolicy === 'detect') {
      result.conflicts.push({
        id: `conflict-${randomUUID()}`,
        deckId: deck.id,
        cardId: existing.id,
        source: syncInput.source,
        detectedAt: syncedAt,
        incomingFields: incoming.fields,
        localFields: existing.fields
      });
      result.stats.conflicts += 1;
      continue;
    }

    const updated = copySyncedCard({
      ...existing,
      ankiNoteId: incoming.ankiNoteId || existing.ankiNoteId,
      type: incoming.type,
      modelName: incoming.modelName,
      fieldOrder: incoming.fieldOrder,
      fields: incoming.fields,
      tags: incoming.tags,
      due: incoming.due,
      state: incoming.state,
      suspended: incoming.suspended,
      mediaRefs: incoming.mediaRefs,
      sourceDeckName: incoming.sourceDeckName || existing.sourceDeckName,
      sourceDeckPath: incoming.sourceDeckPath || existing.sourceDeckPath
    }, actorName, syncedAt);
    result.updatedCards.push(updated);
    result.stats.updated += 1;
    if (!syncInput.dryRun) Object.assign(existing, updated);
  }

  if (!syncInput.dryRun && (result.stats.created || result.stats.updated || result.stats.conflicts)) {
    deck.lastSyncedAt = syncedAt;
  }
  return result;
}

export function buildAddonSyncResult(syncInput, result) {
  return {
    syncedAt: result.syncedAt,
    source: syncInput.source,
    client: syncInput.client,
    stats: {
      total: result.stats.total,
      created: result.stats.created,
      updated: result.stats.updated,
      skipped: result.stats.skipped,
      conflicts: result.stats.conflicts,
      dryRun: result.stats.dryRun
    }
  };
}

export function createSeedState() {
  const importedAt = nowIso();
  const deck = {
    id: 'deck-demo-zanki',
    name: 'Zanki Step 2 CK',
    description: 'Comprehensive Step 2 CK deck by Zanki.',
    owner: 'You',
    importedAt,
    lastSyncedAt: importedAt,
    media: {},
    source: { filename: 'sample.apkg', format: 'demo' },
    cards: [
      {
        id: 'card-anca',
        ankiNoteId: null,
        type: 'Basic',
        modelName: 'Basic',
        fieldOrder: ['Front', 'Back'],
        fields: {
          Front: 'Microscopic polyangiitis is most strongly associated with which autoantibody?',
          Back: 'p-ANCA (myeloperoxidase)'
        },
        tags: ['Rheumatology', 'Step2'],
        due: 47,
        state: 'Learning',
        modifiedAt: importedAt,
        modifiedBy: 'Alex Chen',
        suspended: false,
        mediaRefs: [],
        sourceDeckName: 'Zanki Step 2 CK',
        sourceDeckPath: 'Zanki Step 2 CK'
      },
      {
        id: 'card-hpylori',
        ankiNoteId: null,
        type: 'Basic (and reverse)',
        modelName: 'Basic (and reverse)',
        fieldOrder: ['Front', 'Back'],
        fields: {
          Front: 'First-line treatment for H. pylori infection?',
          Back: 'Bismuth quadruple therapy or clarithromycin triple therapy depending on resistance patterns.'
        },
        tags: ['GI', 'Step2'],
        due: 8,
        state: 'Learning',
        modifiedAt: importedAt,
        modifiedBy: 'Alex Chen',
        suspended: false,
        mediaRefs: [],
        sourceDeckName: 'Zanki Step 2 CK',
        sourceDeckPath: 'Zanki Step 2 CK'
      },
      {
        id: 'card-b12',
        ankiNoteId: null,
        type: 'Cloze',
        modelName: 'Cloze',
        fieldOrder: ['Front', 'Back'],
        fields: {
          Front: '{{c1::Vitamin B12}} deficiency can cause subacute combined degeneration of the spinal cord.',
          Back: 'Dorsal columns and lateral corticospinal tracts are affected.'
        },
        tags: ['Neurology', 'Step2'],
        due: 26,
        state: 'Review',
        modifiedAt: importedAt,
        modifiedBy: 'Maya Patel',
        suspended: false,
        mediaRefs: [],
        sourceDeckName: 'Zanki Step 2 CK',
        sourceDeckPath: 'Zanki Step 2 CK'
      },
      {
        id: 'card-endo',
        ankiNoteId: null,
        type: 'Basic',
        modelName: 'Basic',
        fieldOrder: ['Front', 'Back'],
        fields: {
          Front: 'What lab abnormality is most consistent with syndrome of inappropriate ADH?',
          Back: 'Hyponatremia with low serum osmolality and inappropriately concentrated urine.'
        },
        tags: ['Endocrinology', 'Step2'],
        due: 17,
        state: 'Suspended',
        modifiedAt: importedAt,
        modifiedBy: 'Jordan Lee',
        suspended: true,
        mediaRefs: [],
        sourceDeckName: 'Zanki Step 2 CK',
        sourceDeckPath: 'Zanki Step 2 CK'
      }
    ]
  };

  return {
    decks: [deck],
    activeDeckId: deck.id,
    users: [
      { id: 'you', name: 'You', email: 'dylan.smith@example.com' },
      { id: 'maya', name: 'Maya Patel', email: 'maya.patel@example.com' },
      { id: 'alex', name: 'Alex Chen', email: 'alex.chen@example.com' },
      { id: 'jordan', name: 'Jordan Lee', email: 'jordan.lee@example.com' },
      { id: 'sam', name: 'Sam Rivera', email: 'sam.rivera@example.com' }
    ],
    role: 'owner',
    collaborators: [
      { id: 'you', name: 'You', email: 'dylan.smith@example.com', role: 'owner', accepted: 42 },
      { id: 'maya', name: 'Maya Patel', email: 'maya.patel@example.com', role: 'collaborator', accepted: 18 },
      { id: 'alex', name: 'Alex Chen', email: 'alex.chen@example.com', role: 'collaborator', accepted: 11 },
      { id: 'jordan', name: 'Jordan Lee', email: 'jordan.lee@example.com', role: 'collaborator', accepted: 7 },
      { id: 'sam', name: 'Sam Rivera', email: 'sam.rivera@example.com', role: 'collaborator', accepted: 4 }
    ],
    suggestions: [
      {
        id: 'sugg-anca',
        deckId: deck.id,
        cardId: 'card-anca',
        authorId: 'maya',
        authorName: 'Maya Patel',
        status: 'pending',
        reason: 'Clarified abbreviation and added relevant vasculitis tag.',
        createdAt: importedAt,
        proposedFields: {
          Front: 'Microscopic polyangiitis is most strongly associated with which ANCA autoantibody?',
          Back: 'p-ANCA (MPO / myeloperoxidase)'
        },
        proposedTags: ['Rheumatology', 'Vasculitis', 'Step2']
      }
    ],
    activity: [
      { id: 'act-1', kind: 'suggestion', text: 'Maya Patel suggested a change', at: importedAt },
      { id: 'act-2', kind: 'export', text: 'You exported a deck', at: importedAt }
    ],
    sync: {
      ankiConnectUrl: 'http://localhost:8765',
      connected: false,
      lastCheckedAt: null,
      lastPullAt: null,
      lastPushAt: null,
      lastAddonSync: null,
      conflicts: []
    }
  };
}

export function summarizeDeck(deck, suggestions = []) {
  const tags = new Set();
  const noteTypes = new Set();
  for (const card of deck.cards) {
    card.tags.forEach((tag) => tags.add(tag));
    noteTypes.add(card.type);
  }

  return {
    id: deck.id,
    name: deck.name,
    description: deck.description,
    cardCount: deck.cards.length,
    noteCount: deck.cards.length,
    tagCount: tags.size,
    noteTypes: [...noteTypes],
    pendingSuggestions: suggestions.filter((item) => item.deckId === deck.id && item.status === 'pending').length,
    lastSyncedAt: deck.lastSyncedAt,
    importedAt: deck.importedAt
  };
}

export function applySuggestion(deck, suggestion, actorName = 'You') {
  const card = deck.cards.find((item) => item.id === suggestion.cardId);
  if (!card) throw new Error('Card not found for suggestion');
  card.fields = { ...card.fields, ...suggestion.proposedFields };
  if (Array.isArray(suggestion.proposedTags)) card.tags = [...suggestion.proposedTags];
  card.modifiedAt = nowIso();
  card.modifiedBy = actorName;
  return card;
}

export function deckToCreateDeckJson(deck) {
  return {
    deck_name: deck.name,
    models: deck.models || [],
    media: deck.media || {},
    cards: deck.cards.map((card) => ({
      type: card.type?.toLowerCase().includes('cloze') ? 'cloze' : card.type?.toLowerCase().includes('reverse') ? 'reversed' : 'basic',
      model_name: card.modelName || card.type || 'Basic',
      field_order: card.fieldOrder || Object.keys(card.fields || {}),
      fields: card.fields,
      front: card.fields.Front || card.fields.front || Object.values(card.fields)[0] || '',
      back: card.fields.Back || card.fields.back || Object.values(card.fields)[1] || '',
      tags: card.tags,
      note_id: card.ankiNoteId,
      media_refs: card.mediaRefs || [],
      source_deck_name: card.sourceDeckName || deck.source?.deckName || deck.name,
      source_deck_path: card.sourceDeckPath || deck.source?.deckPath || deck.name
    }))
  };
}
