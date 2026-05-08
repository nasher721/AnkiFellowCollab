import { randomUUID } from 'node:crypto';
import { applySuggestion, buildAddonSyncResult, mergeAddonCards, nowIso, summarizeDeck } from '../domain.mjs';
import { fail } from '../errors.mjs';
import { loadState, saveState } from '../store.mjs';

const roleRank = { viewer: 0, contributor: 1, reviewer: 2, editor: 3, owner: 4 };

function ensureCollections(state) {
  state.studySessions ||= [];
  state.shareLinks ||= [];
  state.invites ||= [];
  state.comments ||= [];
  state.sync ||= {};
  state.sync.lastAddonSync ??= null;
  // Migrate legacy 'collaborator' role to 'contributor'
  for (const c of (state.collaborators || [])) {
    if (c.role === 'collaborator') c.role = 'contributor';
  }
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
  // Migrate legacy 'collaborator' role string to 'contributor'
  const role = person.role === 'collaborator' ? 'contributor' : (person.role || 'viewer');
  return {
    deckId: deck.id,
    userId: person.id,
    role,
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

function toComment(comment) {
  return {
    id: comment.id,
    suggestionId: comment.suggestionId,
    deckId: comment.deckId,
    authorId: comment.authorId,
    authorName: comment.authorName,
    body: comment.body,
    parentId: comment.parentId || null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt || null,
    resolvedAt: comment.resolvedAt || null,
    resolvedBy: comment.resolvedBy || null
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
      const { deck, collaborator } = requireRole(state, user.id, payload.deckId, 'contributor');
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

    async updateModelTemplate(user, deckId, modelName, patch) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = requireRole(state, user.id, deckId, 'owner');
      const now = nowIso();
      const matched = deck.cards.filter((card) => (card.modelName || card.type || 'Basic') === modelName);
      if (!matched.length) fail(404, 'model_not_found', 'Model not found in this deck');
      for (const card of matched) {
        card.templateFront = patch.templateFront;
        card.templateBack = patch.templateBack;
        card.modelCss = patch.modelCss;
        card.modifiedAt = now;
        card.modifiedBy = user.name;
      }
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'template',
        text: `${user.name} updated the ${modelName} model template`,
        at: now
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
      const { deck } = requireRole(state, user.id, suggestion.deckId, 'reviewer');
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

    async bulkDecideSuggestions(user, deckId, suggestionIds, decision) {
      const state = await loadState();
      ensureCollections(state);
      if (new Set(suggestionIds).size !== suggestionIds.length) fail(400, 'duplicate_suggestion_ids', 'suggestionIds must be unique');
      const { deck } = requireRole(state, user.id, deckId, 'reviewer');
      const selected = suggestionIds.map((suggestionId) => state.suggestions.find((item) => item.id === suggestionId && item.deckId === deck.id));
      if (selected.some((suggestion) => !suggestion)) fail(404, 'suggestion_not_found', 'Suggestion not found');
      if (selected.some((suggestion) => suggestion.status !== 'pending')) fail(409, 'suggestion_reviewed', 'Suggestion has already been reviewed');

      const reviewedAt = nowIso();
      for (const suggestion of selected) {
        if (decision === 'accepted') {
          applySuggestion(deck, suggestion, user.name);
          const collaborator = state.collaborators.find((item) => item.id === suggestion.authorId);
          if (collaborator) collaborator.accepted += 1;
        }
        suggestion.status = decision;
        suggestion.reviewedAt = reviewedAt;
        suggestion.reviewedBy = user.name;
      }
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: decision,
        text: `${user.name} ${decision} ${selected.length} suggestion(s)`,
        at: reviewedAt
      });
      await saveState(state);
      return this.getDeckState(user, deck.id);
    },

    async listSuggestionComments(user, suggestionId) {
      const state = await loadState();
      ensureCollections(state);
      const suggestion = state.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      requireRole(state, user.id, suggestion.deckId, 'contributor');
      return state.comments
        .filter((comment) => comment.suggestionId === suggestionId)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .map(toComment);
    },

    async createSuggestionComment(user, suggestionId, payload) {
      const state = await loadState();
      ensureCollections(state);
      const suggestion = state.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      const { collaborator } = requireRole(state, user.id, suggestion.deckId, 'contributor');
      const parentId = payload.parentId || null;
      if (parentId && !state.comments.some((comment) => comment.id === parentId && comment.suggestionId === suggestionId && comment.deckId === suggestion.deckId)) {
        fail(404, 'comment_not_found', 'Parent comment not found');
      }
      const createdAt = nowIso();
      const comment = {
        id: `comment-${randomUUID()}`,
        suggestionId,
        deckId: suggestion.deckId,
        authorId: collaborator.id,
        authorName: collaborator.name,
        body: payload.body,
        parentId,
        createdAt,
        updatedAt: null,
        resolvedAt: null,
        resolvedBy: null
      };
      state.comments.push(comment);
      state.activity.unshift({
        id: `act-${randomUUID()}`,
        kind: 'comment',
        text: `${collaborator.name} commented on a suggestion`,
        at: createdAt
      });
      await saveState(state);
      return toComment(comment);
    },

    async setSuggestionCommentResolved(user, suggestionId, commentId, resolved) {
      const state = await loadState();
      ensureCollections(state);
      const suggestion = state.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      requireRole(state, user.id, suggestion.deckId, 'reviewer');
      const comment = state.comments.find((item) => item.id === commentId && item.suggestionId === suggestionId && item.deckId === suggestion.deckId && !item.parentId);
      if (!comment) fail(404, 'comment_not_found', 'Comment not found');
      const nextResolved = typeof resolved === 'boolean' ? resolved : !comment.resolvedAt;
      comment.resolvedAt = nextResolved ? nowIso() : null;
      comment.resolvedBy = nextResolved ? user.id : null;
      comment.updatedAt = nowIso();
      await saveState(state);
      return toComment(comment);
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

    async recordSyncConflicts(user, deckId, conflicts) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = requireRole(state, user.id, deckId, 'contributor');
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
      const { deck } = requireRole(state, user.id, deckId, 'contributor');
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
      const response = {
        result: {
          syncedAt: result.syncedAt,
          source: lastAddonSync.source,
          client: lastAddonSync.client,
          stats: result.stats,
          conflicts: result.conflicts
        }
      };
      if (syncInput.returnState !== false) response.state = await this.getDeckState(user, deck.id);
      return response;
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
        role
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

    async getAnalytics(user, deckId) {
      const state = await loadState();
      ensureCollections(state);
      const { deck } = getMembership(state, user.id, deckId);
      const suggestions = state.suggestions.filter((s) => s.deckId === deckId);
      const total = suggestions.length;
      const accepted = suggestions.filter((s) => s.status === 'accepted').length;
      const rejected = suggestions.filter((s) => s.status === 'rejected').length;
      const pending = suggestions.filter((s) => s.status === 'pending').length;

      const byAuthor = {};
      for (const s of suggestions) {
        if (!byAuthor[s.authorId]) byAuthor[s.authorId] = { name: s.authorName, total: 0, accepted: 0 };
        byAuthor[s.authorId].total++;
        if (s.status === 'accepted') byAuthor[s.authorId].accepted++;
      }
      const leaderboard = Object.values(byAuthor)
        .sort((a, b) => b.accepted - a.accepted)
        .slice(0, 10);

      const byState = {};
      for (const card of deck.cards) {
        const cardState = card.state || 'Unknown';
        byState[cardState] = (byState[cardState] || 0) + 1;
      }

      const sessions = state.studySessions.filter((s) => s.deckId === deckId);
      const sessionTotals = sessions.reduce((acc, s) => {
        acc.total += 1;
        acc.durationSeconds += Number(s.durationSeconds) || 0;
        acc.cardsStudied += Number(s.cardsStudied) || 0;
        acc.cardsCorrect += Number(s.cardsCorrect) || 0;
        return acc;
      }, { total: 0, durationSeconds: 0, cardsStudied: 0, cardsCorrect: 0 });

      // Group sessions by date (last 8 calendar days with data)
      const dayMap = {};
      for (const s of sessions) {
        const day = String(s.startedAt || s.createdAt || '').slice(0, 10);
        if (day) dayMap[day] = (dayMap[day] || 0) + (Number(s.cardsStudied) || 0);
      }
      const weeklyTrend = Object.entries(dayMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-8)
        .map(([date, count]) => ({ date, count }));

      return {
        suggestions: { total, accepted, rejected, pending, acceptanceRate: total ? Math.round((accepted / total) * 100) : 0 },
        stars: 0,
        leaderboard,
        cards: { total: deck.cards.length, byState },
        study: {
          sessions: {
            ...sessionTotals,
            accuracyRate: sessionTotals.cardsStudied ? Math.round((sessionTotals.cardsCorrect / sessionTotals.cardsStudied) * 100) : 0
          },
          weeklyTrend,
          strugglingCards: []
        }
      };
    },

    async deleteCards(user, deckId, cardIds) {
      const state = await loadState();
      ensureCollections(state);
      requireRole(state, user.id, deckId, 'owner');
      const deck = state.decks.find((d) => d.id === deckId);
      const idSet = new Set(cardIds);
      const before = deck.cards.length;
      deck.cards = deck.cards.filter((c) => !idSet.has(c.id));
      const deleted = before - deck.cards.length;
      await saveState(state);
      return { deleted };
    },

    async createInvite(user, deckId, { email, role }) {
      const state = await loadState();
      ensureCollections(state);
      requireRole(state, user.id, deckId, 'editor');
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const now = nowIso();
      const invite = {
        id: `inv-${randomUUID()}`,
        deckId,
        invitedBy: user.id,
        email: email.toLowerCase(),
        role,
        token,
        status: 'pending',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: now,
        respondedAt: null
      };
      state.invites.unshift(invite);
      await saveState(state);
      return invite;
    },

    async listInvites(user, deckId) {
      const state = await loadState();
      ensureCollections(state);
      requireRole(state, user.id, deckId, 'editor');
      return state.invites
        .filter((inv) => inv.deckId === deckId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    async revokeInvite(user, deckId, inviteId) {
      const state = await loadState();
      ensureCollections(state);
      requireRole(state, user.id, deckId, 'owner');
      state.invites = state.invites.filter((inv) => !(inv.id === inviteId && inv.deckId === deckId));
      await saveState(state);
    },

    async previewInvite(token) {
      const state = await loadState();
      ensureCollections(state);
      const invite = state.invites.find((inv) => inv.token === token);
      if (!invite) fail(404, 'invite_not_found', 'Invite not found');
      const deck = state.decks.find((d) => d.id === invite.deckId);
      return {
        deckId: invite.deckId,
        deckName: deck?.name || null,
        role: invite.role,
        email: invite.email,
        status: invite.status,
        expiresAt: invite.expiresAt
      };
    },

    async acceptInvite(user, token) {
      const state = await loadState();
      ensureCollections(state);
      const invite = state.invites.find((inv) => inv.token === token);
      if (!invite) fail(404, 'invite_not_found', 'Invite not found');
      if (invite.status !== 'pending') fail(409, 'invite_used', `Invite has already been ${invite.status}`);
      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
        invite.status = 'expired';
        await saveState(state);
        fail(410, 'invite_expired', 'This invite link has expired');
      }
      if (invite.email.toLowerCase() !== (user.email || '').toLowerCase()) {
        fail(403, 'invite_email_mismatch', 'This invite was sent to a different email address');
      }
      const existing = state.collaborators.find((c) => c.id === user.id);
      if (!existing) {
        state.collaborators.push({
          id: user.id,
          name: user.name || user.email,
          email: user.email,
          role: invite.role,
          accepted: 1
        });
      } else {
        existing.role = invite.role;
      }
      invite.status = 'accepted';
      invite.respondedAt = nowIso();
      await saveState(state);
      return { deckId: invite.deckId, role: invite.role };
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
