const DEFAULT_URL = 'http://localhost:8765';

export async function ankiRequest(action, params = {}, version = 6, endpoint = DEFAULT_URL) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version, params })
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload.result;
}

export async function checkAnki(endpoint = DEFAULT_URL) {
  try {
    const version = await ankiRequest('version', {}, 6, endpoint);
    return { connected: true, version, error: null };
  } catch (error) {
    return { connected: false, version: null, error: error.message };
  }
}

function fieldValues(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields || {}).map(([field, data]) => [field, String(data?.value ?? '')])
  );
}

function fieldOrder(fields = {}) {
  return Object.entries(fields || {})
    .sort(([, a], [, b]) => Number(a?.order ?? 0) - Number(b?.order ?? 0))
    .map(([field]) => field);
}

function cardState(cardInfo = {}) {
  if (cardInfo.queue < 0) return 'Suspended';
  if (cardInfo.type === 0 || cardInfo.queue === 0) return 'New';
  if (cardInfo.type === 1 || cardInfo.queue === 1 || cardInfo.queue === 3) return 'Learning';
  return 'Review';
}

async function modelDetails(modelNames, endpoint) {
  const details = new Map();
  await Promise.all([...modelNames].map(async (modelName) => {
    try {
      const [templates, styling] = await Promise.all([
        ankiRequest('modelTemplates', { modelName }, 6, endpoint),
        ankiRequest('modelStyling', { modelName }, 6, endpoint)
      ]);
      details.set(modelName, {
        templates: Object.values(templates || {}),
        css: String(styling?.css || '')
      });
    } catch {
      details.set(modelName, { templates: [], css: '' });
    }
  }));
  return details;
}

export async function pullDeck(deckName, endpoint = DEFAULT_URL) {
  const noteIds = await ankiRequest('findNotes', { query: `deck:"${deckName}"` }, 6, endpoint);
  const notes = noteIds.length
    ? await ankiRequest('notesInfo', { notes: noteIds }, 6, endpoint)
    : [];
  const cardIds = notes.flatMap((note) => Array.isArray(note.cards) ? note.cards : []);
  const cardInfos = cardIds.length
    ? await ankiRequest('cardsInfo', { cards: cardIds }, 6, endpoint)
    : [];
  const models = await modelDetails(new Set([
    ...notes.map((note) => note.modelName || 'Basic'),
    ...cardInfos.map((card) => card.modelName || 'Basic')
  ]), endpoint);
  const noteById = new Map(notes.map((note) => [Number(note.noteId), note]));

  if (cardInfos.length) {
    return cardInfos.map((cardInfo) => {
      const note = noteById.get(Number(cardInfo.note));
      const modelName = cardInfo.modelName || note?.modelName || 'Basic';
      const details = models.get(modelName) || { templates: [], css: '' };
      const ord = Number.isFinite(Number(cardInfo.ord)) ? Number(cardInfo.ord) : 0;
      const template = details.templates[ord] || details.templates[0] || {};
      const fields = fieldValues(cardInfo.fields || note?.fields || {});
      return {
        id: `anki-${cardInfo.note}-${ord}`,
        ankiNoteId: cardInfo.note,
        type: modelName,
        modelName,
        fieldOrder: fieldOrder(cardInfo.fields || note?.fields || {}),
        fields,
        tags: note?.tags || [],
        due: Number.isFinite(Number(cardInfo.due)) ? Number(cardInfo.due) : null,
        state: cardState(cardInfo),
        modifiedAt: new Date().toISOString(),
        modifiedBy: 'AnkiConnect',
        suspended: cardInfo.queue < 0,
        sourceDeckName: cardInfo.deckName || deckName,
        sourceDeckPath: cardInfo.deckName || deckName,
        templateFront: String(template.Front || ''),
        templateBack: String(template.Back || ''),
        modelCss: String(cardInfo.css || details.css || ''),
        renderedFront: String(cardInfo.question || ''),
        renderedBack: String(cardInfo.answer || ''),
        clozeOrd: ord
      };
    });
  }

  return notes.map((note) => ({
    id: `anki-${note.noteId}`,
    ankiNoteId: note.noteId,
    type: note.modelName || 'Basic',
    modelName: note.modelName || 'Basic',
    fieldOrder: fieldOrder(note.fields || {}),
    fields: fieldValues(note.fields || {}),
    tags: note.tags || [],
    due: null,
    state: 'Anki',
    modifiedAt: new Date().toISOString(),
    modifiedBy: 'AnkiConnect',
    suspended: false
  }));
}

export async function pushDeck(deck, endpoint = DEFAULT_URL) {
  const updates = [];
  for (const card of deck.cards) {
    if (!card.ankiNoteId) continue;
    await ankiRequest('updateNoteFields', {
      note: {
        id: card.ankiNoteId,
        fields: card.fields
      }
    }, 6, endpoint);
    if (card.tags?.length) {
      await ankiRequest('addTags', {
        notes: [card.ankiNoteId],
        tags: card.tags.join(' ')
      }, 6, endpoint);
    }
    updates.push(card.ankiNoteId);
  }
  return { updatedNotes: updates.length, noteIds: updates };
}
