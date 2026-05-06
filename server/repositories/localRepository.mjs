import { randomUUID } from 'node:crypto';
import { applySuggestion, nowIso, summarizeDeck } from '../domain.mjs';
import { fail } from '../errors.mjs';
import { loadState, saveState } from '../store.mjs';

const roleRank = { viewer: 0, editor: 1, owner: 2 };

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
      const owner = state.collaborators.find((person) => person.id === user.id);
      if (!owner) {
        state.collaborators.push({ id: user.id, name: user.name, email: user.email, role: 'owner', accepted: 0 });
      }
      state.decks.unshift(deck);
      state.activeDeckId = deck.id;
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

    async recordSyncConflicts(user, deckId, conflicts) {
      const state = await loadState();
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

    async setActiveDeck(user, deckId) {
      const state = await loadState();
      getMembership(state, user.id, deckId);
      state.activeDeckId = deckId;
      await saveState(state);
      return this.getDeckState(user, deckId);
    },

    publicState
  };
}
