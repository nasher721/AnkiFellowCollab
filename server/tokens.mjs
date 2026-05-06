import crypto from 'node:crypto';

const TOKEN_PREFIX = 'db_';
const TOKEN_BYTES = 32;

/**
 * Generate a new random API token string.
 * Returns { raw, hash } — store the hash, return raw to the user once.
 */
export function generateToken() {
  const raw = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const hash = hashToken(raw);
  return { raw, hash };
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Resolve a user from a Bearer token that is a DeckBridge API token
 * (not a Supabase JWT). Returns the user row or null.
 */
export async function resolveTokenUser(supabase, rawToken) {
  if (!supabase || !rawToken?.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(rawToken);
  const { data, error } = await supabase
    .from('user_tokens')
    .select('user_id, id')
    .eq('token_hash', hash)
    .single();
  if (error || !data) return null;
  // Touch last_used_at without blocking the request
  supabase
    .from('user_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => undefined)
    .catch(() => undefined);
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, name')
    .eq('id', data.user_id)
    .single();
  if (!profile) return null;
  return { id: profile.id, email: profile.email, name: profile.name };
}

/**
 * Create a token row in Supabase and return { id, raw, label, createdAt }.
 * The raw token is only ever returned here — not stored.
 */
export async function createUserToken(supabase, userId, label = 'Anki Add-on') {
  const { raw, hash } = generateToken();
  const id = crypto.randomUUID();
  const { error } = await supabase.from('user_tokens').insert({
    id,
    user_id: userId,
    token_hash: hash,
    label,
    created_at: new Date().toISOString()
  });
  if (error) throw new Error(`Failed to create token: ${error.message}`);
  return { id, raw, label, createdAt: new Date().toISOString() };
}

/**
 * List token metadata for a user (no raw tokens, no hashes).
 */
export async function listUserTokens(supabase, userId) {
  const { data, error } = await supabase
    .from('user_tokens')
    .select('id, label, created_at, last_used_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to list tokens: ${error.message}`);
  return data.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }));
}

/**
 * Revoke (delete) a token owned by the given user.
 */
export async function revokeUserToken(supabase, userId, tokenId) {
  const { error } = await supabase
    .from('user_tokens')
    .delete()
    .eq('id', tokenId)
    .eq('user_id', userId);
  if (error) throw new Error(`Failed to revoke token: ${error.message}`);
}
