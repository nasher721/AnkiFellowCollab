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
