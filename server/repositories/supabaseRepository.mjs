import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { applySuggestion, mergeAddonCards, nowIso, summarizeDeck } from '../domain.mjs';
import { fail } from '../errors.mjs';

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
    models: row.models || []
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
    sourceDeckPath: row.source_deck_path || null
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

function emptyState(user) {
  return {
    decks: [],
    summaries: [],
    activeDeckId: null,
    role: 'collaborator',
    collaborators: [],
    suggestions: [],
    activity: [],
    sync: {
      ankiConnectUrl: null,
      connected: false,
      lastCheckedAt: null,
      lastPullAt: null,
      lastPushAt: null,
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
      .select('deck_id,user_id,role,created_at')
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
    await assertMembership(user.id, deckId);
    const membership = await assertMembership(user.id, deckId);
    const [{ data: deck, error: deckError }, { data: cards, error: cardsError }, { data: suggestions, error: suggestionsError }, { data: activity, error: activityError }, { data: conflicts, error: conflictsError }] = await Promise.all([
      supabase.from('decks').select('*').eq('id', deckId).single(),
      supabase.from('cards').select('*').eq('deck_id', deckId).order('created_at'),
      supabase.from('suggestions').select('*').eq('deck_id', deckId).order('created_at', { ascending: false }),
      supabase.from('activity').select('*').eq('deck_id', deckId).order('created_at', { ascending: false }).limit(100),
      supabase.from('sync_conflicts').select('*').eq('deck_id', deckId).order('detected_at', { ascending: false })
    ]);
    if (deckError) throw deckError;
    if (cardsError) throw cardsError;
    if (suggestionsError) throw suggestionsError;
    if (activityError) throw activityError;
    if (conflictsError) throw conflictsError;
    const fullDeck = toDeck(deck, (cards || []).map(toCard));
    const deckSuggestions = (suggestions || []).map(toSuggestion);
    return {
      decks: [fullDeck],
      summaries: [summarizeDeck(fullDeck, deckSuggestions)],
      activeDeckId: deckId,
      role: membership.role === 'owner' ? 'owner' : 'collaborator',
      collaborators: [],
      suggestions: deckSuggestions,
      activity: (activity || []).map(toActivity),
      sync: {
        ankiConnectUrl: null,
        connected: false,
        lastCheckedAt: null,
        lastPullAt: null,
        lastPushAt: null,
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
        .select('deck_id,user_id,role,created_at')
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
      return (decks || []).map((deck) => summarizeDeck(toDeck(deck), []));
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

    async uploadDeck(user, deck) {
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
        media: deck.media || {},
        source: deck.source || {},
        models: deck.models || []
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
        const { error: cardError } = await supabase.from('cards').insert(deck.cards.map((card) => ({
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
        if (cardError) throw cardError;
      }
      await supabase.from('activity').insert({
        id: `act-${randomUUID()}`,
        deck_id: deck.id,
        user_id: user.id,
        kind: 'import',
        text: `${user.name} imported ${deck.name}`,
        created_at: importedAt
      });
      return getDeckRows(user, deck.id);
    },

    async createSuggestion(user, payload) {
      await assertMembership(user.id, payload.deckId, 'editor');
      const { data: card, error: cardError } = await supabase.from('cards').select('*').eq('id', payload.cardId).eq('deck_id', payload.deckId).single();
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

    async decideSuggestion(user, suggestionId, decision) {
      const { data: suggestion, error } = await supabase.from('suggestions').select('*').eq('id', suggestionId).single();
      if (error || !suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      if (suggestion.status !== 'pending') fail(409, 'suggestion_reviewed', 'Suggestion has already been reviewed');
      await assertMembership(user.id, suggestion.deck_id, 'owner');
      if (decision === 'accepted') {
        const { data: card, error: cardError } = await supabase.from('cards').select('*').eq('id', suggestion.card_id).single();
        if (cardError || !card) fail(404, 'card_not_found', 'Card not found');
        const nextCard = applySuggestion(toDeck({ id: suggestion.deck_id, name: '', imported_at: nowIso() }, [toCard(card)]), toSuggestion(suggestion), user.name);
        const { error: updateCardError } = await supabase.from('cards').update({
          fields: nextCard.fields,
          tags: nextCard.tags,
          modified_at: nextCard.modifiedAt,
          modified_by: nextCard.modifiedBy
        }).eq('id', suggestion.card_id);
        if (updateCardError) throw updateCardError;
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

    async getExportDeck(user, deckId) {
      const state = await getDeckRows(user, deckId);
      return state.decks[0];
    },

    async storeExport(user, deckId, apkgPath, filename) {
      await assertMembership(user.id, deckId);
      const bucket = process.env.SUPABASE_EXPORTS_BUCKET || 'deckbridge-exports';
      const storagePath = `${deckId}/${filename}`;
      const bytes = await fs.readFile(apkgPath);
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(storagePath, bytes, {
          contentType: 'application/octet-stream',
          upsert: true
        });
      if (uploadError) throw uploadError;
      const expiresIn = Number(process.env.EXPORT_SIGNED_URL_SECONDS || 3600);
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
      if (error) throw error;
      return {
        filename,
        url: data.signedUrl,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
      };
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
      const state = await getDeckRows(user, deckId);
      const deck = state.decks[0];
      const result = mergeAddonCards(deck, syncInput, user.name);

      if (!syncInput.dryRun) {
        if (result.createdCards.length) {
          const { error } = await supabase.from('cards').insert(result.createdCards.map((card) => ({
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
          if (error) throw error;
        }
        for (const card of result.updatedCards) {
          const { error } = await supabase.from('cards').update({
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
          }).eq('id', card.id).eq('deck_id', deck.id);
          if (error) throw error;
        }
        await supabase.from('sync_conflicts').delete().eq('deck_id', deck.id);
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
        const { error: deckError } = await supabase.from('decks').update({ last_synced_at: result.syncedAt }).eq('id', deck.id);
        if (deckError) throw deckError;
        await supabase.from('activity').insert({
          id: `act-${randomUUID()}`,
          deck_id: deck.id,
          user_id: user.id,
          kind: 'sync',
          text: `${user.name} synced ${result.stats.total} Anki card(s): ${result.stats.created} new, ${result.stats.updated} updated, ${result.stats.conflicts} conflict(s)`,
          created_at: result.syncedAt
        });
      }

      return {
        result: {
          syncedAt: result.syncedAt,
          stats: result.stats,
          conflicts: result.conflicts
        },
        state: syncInput.dryRun ? state : await getDeckRows(user, deck.id)
      };
    }
  };
}
