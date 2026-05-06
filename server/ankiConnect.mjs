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

export async function pullDeck(deckName, endpoint = DEFAULT_URL) {
  const noteIds = await ankiRequest('findNotes', { query: `deck:"${deckName}"` }, 6, endpoint);
  const notes = noteIds.length
    ? await ankiRequest('notesInfo', { notes: noteIds }, 6, endpoint)
    : [];

  return notes.map((note) => ({
    id: `anki-${note.noteId}`,
    ankiNoteId: note.noteId,
    type: note.modelName || 'Basic',
    fields: Object.fromEntries(
      Object.entries(note.fields || {}).map(([field, data]) => [field, String(data?.value ?? '')])
    ),
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
