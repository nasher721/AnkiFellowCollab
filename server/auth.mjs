import { createClient } from '@supabase/supabase-js';
import { fail } from './errors.mjs';
import { resolveTokenUser } from './tokens.mjs';

const defaultDevUser = {
  id: 'you',
  email: 'dylan.smith@example.com',
  name: 'You'
};

function getBearerToken(req) {
  const value = req.get('authorization') || '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

function deckScopeFromRequest(req) {
  if (req.params?.deckId) return req.params.deckId;
  if (req.method === 'POST' && req.path === '/api/tokens') {
    return req.body?.deckId || req.body?.deck_id || req.body?.deck_uuid;
  }
  return undefined;
}

export function createAuth(options = {}) {
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  const serviceKey = options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  }) : null;

  async function resolveUser(req) {
    const token = getBearerToken(req);
    if (supabase && token) {
      // Try DeckBridge API token first (db_ prefix)
      const tokenUser = await resolveTokenUser(supabase, token, {
        deckId: deckScopeFromRequest(req)
      });
      if (tokenUser) return tokenUser;
      if (token.startsWith('db_')) fail(401, 'unauthorized', 'Invalid or expired session');
      // Fall back to Supabase JWT
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) fail(401, 'unauthorized', 'Invalid or expired session');
      return {
        id: data.user.id,
        email: data.user.email || '',
        name: data.user.user_metadata?.name || data.user.email || 'DeckBridge User'
      };
    }

    if (production) {
      fail(401, 'unauthorized', 'Missing authenticated session');
    }

    return {
      id: req.get('x-deckbridge-user-id') || defaultDevUser.id,
      email: req.get('x-deckbridge-user-email') || defaultDevUser.email,
      name: req.get('x-deckbridge-user-name') || defaultDevUser.name
    };
  }

  return {
    async requireUser(req, _res, next) {
      try {
        req.user = await resolveUser(req);
        next();
      } catch (error) {
        next(error);
      }
    },
    resolveUser,
    supabase
  };
}
