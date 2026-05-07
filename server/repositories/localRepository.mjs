import { randomUUID } from 'node:crypto';
import { applySuggestion, buildAddonSyncResult, mergeAddonCards, nowIso, summarizeDeck } from '../domain.mjs';
import { fail } from '../errors.mjs';
import { loadState, saveState } from '../store.mjs';

const roleRank = { viewer: 0, editor: 1, owner: 2 };

function ensureCollections(state) {
  state.studySessions ||= [];
  state.shareLinks ||= [];
  state.sync ||= {};
  state.sync.lastAddonSync ??= null;
}

function mergeConflicts(existing = [], incoming = []) {
  const merged = new Map();
  for (const conflict of [...existing, ...incoming]) {
    const key = `${conflict.cardId || conflict.id}:${conflict.source || ''}`;
    merged.set(key, conflict);
  }
  return [...merged.values()];
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

function collaboratorToUser(person) {
  return {
    id: person.id,
    email: person.email,
    name: person.name
  };
}

function membershipFor(deck, person) {
  return {
    deckId: deck.id,
    userId: person.id,
    role: person.role === 'owner' ? 'owner' : 'editor',
    createdAt: deck.importedAt
  };
}

function publicState(state, activeDeckId = state.activeDeckId) {
  const activeDeck = state.decks.find((deck) => deck.id === activeDeckId) || state.decks[0] || null;
  return {
    ...state,
    activeDeckId: activeDeck?.id || null,
    summaries: state.decks.map((deck) => summarizeDeck(deck, state.suggestions))
  };
}

function getMembership(state, userId, deckId) {
  const deck = state.decks.find((item) => item.id === deckId);
  if (!deck) fail(404, 'deck_not_found', 'Deck not found');
  const collaborator = state.collaborators.find((person) => person.id === userId)
    || (userId === 'you' ? state.collaborators.find((person) => person.role === 'owner') : null);
  if (!collaborator) fail(403, 'forbidden', 'You are not a member of this deck');
  return { deck, membership: membershipFor(deck, collaborator), collaborator };
}

function requireRole(state, userId, deckId, minimumRole) {
  const value = getMembership(state, userId, deckId);
  if (roleRank[value.membership.role] < roleRank[minimumRole]) {
    fail(403, 'forbidden', `${minimumRole} access required`);
  }
  return value;
}

export function createLocalRepository() {
  return {
    async getMe(user) {
      const state = await loadState();
      const known = state.collaborators.find((person) => person.id === user.id);
      const profile = known ? collaboratorToUser(known) : user;
      const memberships = state.decks.flatMap((deck) => (
        state.collaborators
          .filter((person) => person.id === profile.id || (profile.id === 'you' && person.role === 'owner'))
          .map((person) => membershipFor(deck, person))
      ));
      return { user: profile, memberships };
    },

    async listDecks(user) {
      const state = await loadState();
      const visible = state.decks.filter((deck) => {
        try {
          getMembership(state, user.id, deck.id);
          return true;
        } catch (_error) {
          return false;
        }
      });
      return visible.map((deck) => summarizeDeck(deck, state.suggestions));
    },

    async getDeckState(user, deckId) {
      const state = await loadState();
      ensureCollections(state);
      const targetId = deckId || state.activeDeckId || state.decks[0]?.id;
      const { deck } = getMembership(state, user.id, targetId);
      const deckSuggestions = state.suggestions.filter((item) => item.deckId === deck.id);
      return {
        ...publicState({ ...state, decks: [deck], suggestions: deckSuggestions }, deck.id),
        user,
        memberships: [getMembership(state, user.id, deck.id).membership]
      };
    },

    async uploadDeck(user, deck) {
      const state = await loadState();
      ensureCollections(state);
      const owner = state.collaborators.find((person) => person.id === user.id);
      if (!owner) {
        state.collaborators.push({ id: user.id, name: user.name, email: user.email, role: 'owner', accepted: 0 });
      }
      state.decks.unshift(deck);
      state.activeDeckId = deck.id;
      const addonSyncResult = addonImportSyncResult(deck);
      if (addonSyncResult) {
        state.sync.lastAddonSync = addonSyncResult;
        state.sync.lastCheckedAt = addonSyncResult.syncedAt;
        state.sync.lastPushAt = addonSyncResult.syncedAt;
      }
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'import',
        text: `${user.name} imported ${deck.name}`,
        at: nowIso()
      });
      await saveState(state);
      return this.getDeckState(user, deck.id);
    },

    async createSuggestion(user, payload) {
      const state = await loadState();
      ensureCollections(state);
      const { deck, collaborator } = requireRole(state, user.id, payload.deckId, 'editor');
      const card = deck.cards.find((item) => item.id === payload.cardId);
      if (!card) fail(404, 'card_not_found', 'Card not found');
      const suggestion = {
        id: `sugg-${randomUUID()}`,
        deckId: deck.id,
        cardId: card.id,
        authorId: collaborator.id,
        authorName: collaborator.name,
        status: 'pending',
        reason: payload.reason,
        createdAt: nowIso(),
        proposedFields: payload.proposedFields,
        proposedTags: payload.proposedTags
      };
      state.suggestions.unshift(suggestion);
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'suggestion',
        text: `${collaborator.name} suggested a change`,
        at: suggestion.createdAt
      });
      await saveState(state);
      return this.getDeckState(user, deck.id);
    },

    async decideSuggestion(user, suggestionId, decision) {
      const state = await loadState();
      ensureCollections(state);
      const suggestion = state.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      if (suggestion.status !== 'pending') fail(409, 'suggestion_reviewed', 'Suggestion has already been reviewed');
      const { deck } = requireRole(state, user.id, suggestion.deckId, 'owner');
      if (decision === 'accepted') {
        applySuggestion(deck, suggestion, user.name);
        const collaborator = state.collaborators.find((item) => item.id === suggestion.authorId);
        if (collaborator) collaborator.accepted += 1;
      }
      suggestion.status = decision;
      suggestion.reviewedAt = nowIso();
      suggestion.reviewedBy = user.name;
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: decision,
        text: `${user.name} ${decision} ${suggestion.authorName}'s suggestion`,
        at: suggestion.reviewedAt
      });
      await saveState(state);
      return this.getDeckState(user, deck.id);
    },

    async getExportDeck(user, deckId) {
      const state = await loadState();
      const { deck } = getMembership(state, user.id, deckId);
      return deck;
    },

    async storeExport(_user, _deckId, _apkgPath, filename) {
      return {
        filename,
        url: `/downloads/${filename}`,
        expiresAt: null
      };
    },

    async recordExport(user, deckId, download) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = getMembership(state, user.id, deckId);
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'export',
        text: `${user.name} exported ${deck.name}`,
        at: nowIso()
      });
      await saveState(state);
      return { download, state: await this.getDeckState(user, deck.id) };
    },

    async resolveConflict(user, deckId, conflictId, resolution) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = requireRole(state, user.id, deckId, 'editor');
      const conflict = state.sync.conflicts.find((c) => c.id === conflictId);
      if (!conflict) fail(404, 'conflict_not_found', 'Conflict not found');
      if (resolution === 'incoming') {
        const card = deck.cards.find((c) => c.id === conflict.cardId);
        if (card) {
          card.fields = { ...card.fields, ...conflict.incomingFields };
          card.modifiedAt = nowIso();
          card.modifiedBy = user.name;
        }
      }
      state.sync.conflicts = state.sync.conflicts.filter((c) => c.id !== conflictId);
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'sync',
        text: `${user.name} resolved a sync conflict (${resolution === 'incoming' ? 'kept incoming' : resolution === 'local' ? 'kept local' : 'skipped'})`,
        at: nowIso()
      });
      await saveState(state);
      return this.getDeckState(user, deck.id);
    },

    async recordSyncConflicts(user, deckId, conflicts) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = requireRole(state, user.id, deckId, 'editor');
      state.sync.conflicts = conflicts.map((conflict) => ({
        id: conflict.id || `conflict-${randomUUID()}`,
        deckId,
        cardId: conflict.cardId,
        source: conflict.source || 'Local bridge',
        detectedAt: conflict.detectedAt || nowIso(),
        incomingFields: conflict.incomingFields || {},
        localFields: conflict.localFields || {}
      }));
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'sync',
        text: `${user.name} recorded ${state.sync.conflicts.length} sync conflict(s)`,
        at: nowIso()
      });
      await saveState(state);
      return this.getDeckState(user, deck.id);
    },

    async syncCardsFromAddon(user, deckId, syncInput) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = requireRole(state, user.id, deckId, 'editor');
      const result = mergeAddonCards(deck, syncInput, user.name);
      const lastAddonSync = buildAddonSyncResult(syncInput, result, state.sync.lastAddonSync);
      const isFirstBatchChunk = !syncInput.batch || syncInput.batch.index === 0;
      const isFinalBatchChunk = !syncInput.batch || syncInput.batch.index + 1 >= syncInput.batch.total;
      state.sync.lastAddonSync = lastAddonSync;
      state.sync.lastCheckedAt = result.syncedAt;
      state.sync.conflicts = isFirstBatchChunk
        ? result.conflicts
        : mergeConflicts(state.sync.conflicts, result.conflicts);
      if (!syncInput.dryRun) {
        state.sync.lastPullAt = syncInput.conflictPolicy === 'overwrite-platform' ? result.syncedAt : state.sync.lastPullAt;
        state.sync.lastPushAt = result.syncedAt;
        if (isFinalBatchChunk) {
          state.activity.unshift({
            id: `act-${randomUUID()}`,
            kind: 'sync',
            text: `${user.name} synced ${lastAddonSync.stats.total} Anki card(s): ${lastAddonSync.stats.created} new, ${lastAddonSync.stats.updated} updated, ${lastAddonSync.stats.conflicts} conflict(s)`,
            at: result.syncedAt
          });
        }
      }
      await saveState(state);
      return {
        result: {
          syncedAt: result.syncedAt,
          source: lastAddonSync.source,
          client: lastAddonSync.client,
          stats: result.stats,
          conflicts: result.conflicts
        },
        state: await this.getDeckState(user, deck.id)
      };
    },

    async setActiveDeck(user, deckId) {
      const state = await loadState();
      ensureCollections(state);
      getMembership(state, user.id, deckId);
      state.activeDeckId = deckId;
      await saveState(state);
      return this.getDeckState(user, deckId);
    },

    async setDemoRole(user, role) {
      const state = await loadState();
      ensureCollections(state);
      const next = await this.getDeckState(user, state.activeDeckId);
      return {
        ...next,
        role: role === 'owner' ? 'owner' : 'collaborator'
      };
    },

    async createStudySession(user, session) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = getMembership(state, user.id, session.deckId);
      const now = nowIso();
      const saved = {
        id: session.id || `study-${randomUUID()}`,
        userId: user.id,
        deckId: deck.id,
        startedAt: session.startedAt || now,
        endedAt: session.endedAt || null,
        durationSeconds: session.durationSeconds || 0,
        cardsStudied: session.cardsStudied || 0,
        cardsCorrect: session.cardsCorrect || 0,
        newCards: session.newCards || 0,
        reviewCards: session.reviewCards || 0,
        metadata: session.metadata || {},
        createdAt: now
      };
      state.studySessions.unshift(saved);
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'study',
        text: `${user.name} studied ${saved.cardsStudied} card(s) in ${deck.name}`,
        at: saved.createdAt
      });
      await saveState(state);
      return saved;
    },

    async listStudySessions(user, deckId, options = {}) {
      const state = await loadState();
      ensureCollections(state);
      if (deckId) getMembership(state, user.id, deckId);
      const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
      return state.studySessions
        .filter((session) => session.userId === user.id && (!deckId || session.deckId === deckId))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, limit);
    },

    async createShareLink(user, deckId, link) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = requireRole(state, user.id, deckId, 'owner');
      const now = nowIso();
      const saved = {
        id: link.id || `share-${randomUUID()}`,
        deckId: deck.id,
        token: link.token,
        label: link.label || 'Share link',
        passwordHash: link.passwordHash || null,
        passwordProtected: Boolean(link.passwordHash),
        expiresAt: link.expiresAt || null,
        disabledAt: null,
        createdBy: user.id,
        createdAt: now
      };
      state.shareLinks.unshift(saved);
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'share',
        text: `${user.name} created a share link for ${deck.name}`,
        at: now
      });
      await saveState(state);
      return { ...saved, passwordHash: undefined };
    },

    async listShareLinks(user, deckId) {
      const state = await loadState();
      ensureCollections(state);
      requireRole(state, user.id, deckId, 'owner');
      return state.shareLinks
        .filter((link) => link.deckId === deckId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((link) => ({
          id: link.id,
          deckId: link.deckId,
          token: link.token,
          label: link.label,
          passwordProtected: Boolean(link.passwordHash || link.passwordProtected),
          expiresAt: link.expiresAt,
          disabledAt: link.disabledAt,
          createdBy: link.createdBy,
          createdAt: link.createdAt
        }));
    },

    async listActivity(user, deckId, filters = {}) {
      const state = await loadState();
      ensureCollections(state);
      getMembership(state, user.id, deckId);
      const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
      const kinds = Array.isArray(filters.kinds) ? filters.kinds.filter(Boolean) : [];
      return state.activity
        .filter((activity) => {
          if (kinds.length && !kinds.includes(activity.kind)) return false;
          if (filters.since && String(activity.at) < filters.since) return false;
          if (filters.until && String(activity.at) > filters.until) return false;
          return true;
        })
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, limit);
    },

    publicState
  };
}
