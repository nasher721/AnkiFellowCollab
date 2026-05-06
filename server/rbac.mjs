import { fail } from './errors.mjs';

export function requireRole(supabase, ...allowedRoles) {
  return async (req, _res, next) => {
    try {
      if (!supabase) return next();
      const deckId = req._resolvedDeckId || req.params.deckId || req.body.deckId || req.query.deckId;
      if (!deckId) fail(400, 'missing_deck_id', 'Deck ID is required');
      const { data: member } = await supabase.from('deck_members')
        .select('role')
        .eq('deck_id', deckId)
        .eq('user_id', req.user.id)
        .single();
      if (!member) fail(403, 'forbidden', 'You are not a member of this deck');
      if (!allowedRoles.includes(member.role)) fail(403, 'forbidden', `Requires role: ${allowedRoles.join(' or ')}`);
      req.deckRole = member.role;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireOwner(supabase) {
  return requireRole(supabase, 'owner');
}

export function requireEditor(supabase) {
  return requireRole(supabase, 'owner', 'editor');
}

export function requireContributor(supabase) {
  return requireRole(supabase, 'owner', 'editor', 'reviewer', 'contributor');
}

export function requireReviewer(supabase) {
  return requireRole(supabase, 'owner', 'editor', 'reviewer');
}

export function resolveSuggestionDeck(supabase) {
  return async (req, _res, next) => {
    try {
      if (!supabase) return next();
      const { data: suggestion } = await supabase.from('suggestions')
        .select('deck_id')
        .eq('id', req.params.id)
        .single();
      if (!suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      req._resolvedDeckId = suggestion.deck_id;
      next();
    } catch (error) {
      next(error);
    }
  };
}
