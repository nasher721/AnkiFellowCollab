import { createClient } from '@supabase/supabase-js';
import { loadState } from '../server/store.mjs';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const state = await loadState();

for (const person of state.collaborators) {
  await supabase.from('profiles').upsert({
    id: person.id,
    email: person.email,
    name: person.name
  });
}

for (const deck of state.decks) {
  const owner = state.collaborators.find((person) => person.role === 'owner') || state.collaborators[0];
  await supabase.from('decks').upsert({
    id: deck.id,
    owner_id: owner.id,
    owner_name: owner.name,
    name: deck.name,
    description: deck.description,
    imported_at: deck.importedAt,
    last_synced_at: deck.lastSyncedAt,
    media: deck.media || {},
    models: deck.models || [],
    source: deck.source || {}
  });

  for (const person of state.collaborators) {
    await supabase.from('deck_members').upsert({
      deck_id: deck.id,
      user_id: person.id,
      role: person.role === 'owner' ? 'owner' : 'editor',
      created_at: deck.importedAt
    });
  }

  if (deck.cards.length) {
    await supabase.from('cards').upsert(deck.cards.map((card) => ({
      id: card.id,
      deck_id: deck.id,
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
      source_deck_path: card.sourceDeckPath
    })));
  }
}

if (state.suggestions.length) {
  await supabase.from('suggestions').upsert(state.suggestions.map((suggestion) => ({
    id: suggestion.id,
    deck_id: suggestion.deckId,
    card_id: suggestion.cardId,
    author_id: suggestion.authorId,
    author_name: suggestion.authorName,
    status: suggestion.status,
    reason: suggestion.reason,
    created_at: suggestion.createdAt,
    reviewed_at: suggestion.reviewedAt,
    reviewed_by: suggestion.reviewedBy,
    proposed_fields: suggestion.proposedFields,
    proposed_tags: suggestion.proposedTags
  })));
}

for (const item of state.activity) {
  await supabase.from('activity').upsert({
    id: item.id,
    deck_id: state.activeDeckId || state.decks[0]?.id,
    user_id: null,
    kind: item.kind,
    text: item.text,
    created_at: item.at
  });
}

console.log(`Migrated ${state.decks.length} deck(s), ${state.suggestions.length} suggestion(s), and ${state.activity.length} activity item(s).`);
