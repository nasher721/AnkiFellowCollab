import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createUserToken, hashToken, listUserTokens, resolveTokenUser, revokeUserToken } from './tokens.mjs';
import {
  assertSelfHostedSecurityConfig,
  assertValidDeckId,
  assertValidEmail,
  assertValidSessionRole,
  buildSecurityHeaders,
  hashSecret,
  isScryptSecretHash,
  parseTrustedProxy,
  verifySecret
} from './security.mjs';

class TokenTestSupabase {
  constructor() {
    this.tables = {
      profiles: [],
      user_tokens: []
    };
  }

  from(table) {
    return new TokenTestQuery(this.tables, table);
  }
}

class TokenTestQuery {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.pendingUpdate = null;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.filters.push({ field, value });
    return this;
  }

  order() {
    return this;
  }

  async upsert(row) {
    const rows = this.rowsForTable();
    const index = rows.findIndex((existing) => existing.id === row.id);
    if (index >= 0) rows[index] = { ...rows[index], ...row };
    else rows.push(row);
    return { data: row, error: null };
  }

  async insert(row) {
    this.rowsForTable().push(row);
    return { data: row, error: null };
  }

  update(values) {
    this.pendingUpdate = values;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  catch(reject) {
    return this.execute().catch(reject);
  }

  async execute() {
    if (this.pendingUpdate) {
      for (const row of this.rows()) Object.assign(row, this.pendingUpdate);
    }
    return { data: this.rows(), error: null };
  }

  async maybeSingle() {
    return { data: this.rows()[0] || null, error: null };
  }

  async single() {
    return this.maybeSingle();
  }

  rowsForTable() {
    if (!this.tables[this.table]) this.tables[this.table] = [];
    return this.tables[this.table];
  }

  rows() {
    return this.rowsForTable().filter((row) => this.filters.every(({ field, value }) => row[field] === value));
  }
}

test('share-link secrets use salted scrypt hashes', async () => {
  const first = await hashSecret('study-room');
  const second = await hashSecret('study-room');

  assert.notEqual(first, second);
  assert.equal(isScryptSecretHash(first), true);
  assert.equal(await verifySecret('study-room', first), true);
  assert.equal(await verifySecret('wrong-room', first), false);
  assert.doesNotMatch(first, /^[a-f0-9]{64}$/);
});

test('share-link secret verification fails closed for malformed scrypt hashes', async () => {
  const malformed = [
    'scrypt$N=16384,r=8,p=1$!!!!$????',
    'scrypt$N=16384,r=8,p=1$validsalt$',
    'scrypt$N=16384,r=8,p=1$$validderived',
    'scrypt$N=16384,r=8,p=1$validsalt$A',
    'scrypt$N=16384,r=8,p=2$validsalt$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'sha256$N=16384,r=8,p=1$validsalt$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  ];

  for (const hash of malformed) {
    assert.equal(isScryptSecretHash(hash), false);
    assert.equal(await verifySecret('study-room', hash), false);
  }
});

test('email validation normalizes and rejects malformed values', () => {
  assert.equal(assertValidEmail(' Owner+Boards@example.COM '), 'owner+boards@example.com');

  for (const value of ['not-an-email', 'a@b']) {
    assert.throws(() => assertValidEmail(value), { code: 'invalid_email' });
  }
});

test('session role validation allowlists membership roles', () => {
  for (const role of ['owner', 'editor', 'reviewer', 'contributor', 'viewer']) {
    assert.equal(assertValidSessionRole(role), role);
  }

  for (const role of ['admin', '__proto__']) {
    assert.throws(() => assertValidSessionRole(role), { code: 'invalid_role' });
  }
});

test('deck id validation accepts safe ids and rejects path-like ids', () => {
  assert.equal(assertValidDeckId('deck-demo-zanki'), 'deck-demo-zanki');
  assert.equal(assertValidDeckId('018f7a3e-3332-7d4d-bf7a-779fcfe084b5'), '018f7a3e-3332-7d4d-bf7a-779fcfe084b5');

  for (const value of ['../state', 'a'.repeat(65), 'deck demo zanki']) {
    assert.throws(() => assertValidDeckId(value), { code: 'invalid_deck_id' });
  }
});

test('self-hosted security config requires https origin and service keys', () => {
  assert.throws(() => assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'http://deckbridge.example.test',
    CORS_ORIGIN: 'http://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service'
  }), { code: 'self_host_security_config' });

  assert.throws(() => assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'https://deckbridge.example.test',
    CORS_ORIGIN: 'https://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon'
  }), { code: 'self_host_security_config' });

  const config = assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'https://deckbridge.example.test',
    CORS_ORIGIN: 'https://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon',
    VITE_SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    DECKBRIDGE_REQUIRE_HTTPS: 'true',
    DECKBRIDGE_TRUST_PROXY: 'loopback'
  });

  assert.equal(config.enabled, true);
  assert.equal(config.publicUrl, 'https://deckbridge.example.test');
  assert.equal(config.corsOrigin, 'https://deckbridge.example.test');
  assert.equal(config.requireHttps, true);
  assert.equal(config.trustProxy, 'loopback');
});

test('self-hosted config blocks service role exposure through Vite env', () => {
  assert.throws(() => assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'https://deckbridge.example.test',
    CORS_ORIGIN: 'https://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon',
    VITE_SUPABASE_ANON_KEY: 'service-role-secret',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
    DECKBRIDGE_REQUIRE_HTTPS: 'true'
  }), { code: 'self_host_security_config' });

  assert.throws(() => assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'https://deckbridge.example.test',
    CORS_ORIGIN: 'https://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon',
    VITE_SUPABASE_ANON_KEY: 'anon',
    VITE_SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
    DECKBRIDGE_REQUIRE_HTTPS: 'true'
  }), { code: 'self_host_security_config' });
});

test('trusted proxy parser accepts explicit values only', () => {
  assert.equal(parseTrustedProxy('false'), false);
  assert.equal(parseTrustedProxy('loopback'), 'loopback');
  assert.equal(parseTrustedProxy('1'), 1);
  assert.deepEqual(parseTrustedProxy('10.0.0.0/8,192.168.0.0/16'), ['10.0.0.0/8', '192.168.0.0/16']);

  for (const value of ['', 'true', 'all', '*', '::::/64', ':/128']) {
    assert.throws(() => parseTrustedProxy(value), { code: 'self_host_security_config' });
  }
});

test('buildSecurityHeaders enables hsts only when https is required', () => {
  const headers = buildSecurityHeaders({ requireHttps: true });
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /camera=\(\)/);
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);

  const localHeaders = buildSecurityHeaders({ requireHttps: false });
  assert.equal(Object.hasOwn(localHeaders, 'Strict-Transport-Security'), false);
});

test('comment resolution migration limits client updates to resolution fields', async () => {
  const sql = await fs.readFile(new URL('../supabase/migrations/20260507120000_comment_resolution.sql', import.meta.url), 'utf8');

  assert.match(sql, /create or replace function public\.enforce_comment_insert_scope/i);
  assert.match(sql, /where s\.id = new\.suggestion_id\s+and s\.deck_id = new\.deck_id/i);
  assert.match(sql, /parent\.suggestion_id = new\.suggestion_id\s+and parent\.deck_id = new\.deck_id/i);
  assert.match(sql, /new\.resolved_at := null/i);
  assert.match(sql, /create trigger enforce_comment_insert_scope/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.suggestions/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.comments/i);
  assert.match(sql, /create policy "comments insert contributor"/i);
  assert.match(sql, /m\.role in \('owner', 'editor', 'reviewer', 'contributor'\)/i);
  assert.match(sql, /create or replace function public\.enforce_comment_resolution_update/i);
  assert.match(sql, /old\.parent_id is not null/i);
  assert.match(sql, /new\.body is distinct from old\.body/i);
  assert.match(sql, /raise exception 'Only comment resolution fields may be updated'/i);
  assert.match(sql, /new\.resolved_at := now\(\)/i);
  assert.match(sql, /new\.resolved_by := auth\.uid\(\)::text/i);
  assert.match(sql, /new\.updated_at := now\(\)/i);
  assert.match(sql, /revoke update on public\.comments from anon, authenticated/i);
  assert.match(sql, /grant update \(resolved_at, resolved_by, updated_at\) on public\.comments to authenticated/i);
  assert.match(sql, /create policy "comments update reviewer"/i);
  assert.match(sql, /m\.role in \('owner', 'editor', 'reviewer'\)/i);
});

test('user token lockdown migration adds scoped active token controls', async () => {
  const sql = await fs.readFile(new URL('../supabase/migrations/20260522120000_lock_down_user_tokens.sql', import.meta.url), 'utf8');

  assert.match(sql, /add column if not exists expires_at timestamptz/i);
  assert.match(sql, /add column if not exists revoked_at timestamptz/i);
  assert.match(sql, /add column if not exists deck_id text references public\.decks\(id\)/i);
  assert.match(sql, /add column if not exists token_tail text/i);
  assert.match(sql, /create index if not exists user_tokens_active_idx/i);
  assert.match(sql, /where revoked_at is null/i);
  assert.match(sql, /revoke insert, update on public\.user_tokens from anon, authenticated/i);
  assert.match(sql, /grant select, delete on public\.user_tokens to authenticated/i);
  assert.match(sql, /create policy "tokens read own active"/i);
  assert.match(sql, /for select/i);
  assert.match(sql, /auth\.uid\(\)::text = user_id/i);
  assert.match(sql, /revoked_at is null/i);
  assert.match(sql, /expires_at is null or expires_at > now\(\)/i);
  assert.match(sql, /create policy "tokens delete own active"/i);
});

test('created add-on tokens default to 90 day expiry and store only token tail metadata', async () => {
  const previousTtl = process.env.DECKBRIDGE_TOKEN_TTL_DAYS;
  delete process.env.DECKBRIDGE_TOKEN_TTL_DAYS;
  try {
    const supabase = new TokenTestSupabase();
    const before = Date.now();
    const created = await createUserToken(supabase, {
      id: 'user-token-default',
      email: 'token@example.com',
      name: 'Token User'
    });
    const after = Date.now();
    const row = supabase.tables.user_tokens[0];
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    assert.match(created.raw, /^db_/);
    assert.equal(created.token, created.raw);
    assert.equal(created.label, 'Anki Add-on');
    assert.equal(created.deckId, null);
    assert.equal(row.token_hash, hashToken(created.raw));
    assert.equal(row.token_tail, created.raw.slice(-8));
    assert.equal(row.deck_id, null);
    assert.equal(Object.hasOwn(row, 'raw'), false);
    assert.equal(Object.hasOwn(row, 'token'), false);
    assert.equal(row.expires_at, created.expiresAt);
    assert.ok(Date.parse(row.expires_at) >= before + ninetyDaysMs);
    assert.ok(Date.parse(row.expires_at) <= after + ninetyDaysMs + 1000);
  } finally {
    if (previousTtl === undefined) delete process.env.DECKBRIDGE_TOKEN_TTL_DAYS;
    else process.env.DECKBRIDGE_TOKEN_TTL_DAYS = previousTtl;
  }
});

test('add-on token TTL falls back for empty env and invalid non-positive values', async () => {
  const previousTtl = process.env.DECKBRIDGE_TOKEN_TTL_DAYS;
  try {
    for (const [envTtl, optionTtl] of [
      ['', undefined],
      ['not-a-number', undefined],
      [undefined, 0],
      [undefined, -5],
      [undefined, 'not-a-number']
    ]) {
      if (envTtl === undefined) delete process.env.DECKBRIDGE_TOKEN_TTL_DAYS;
      else process.env.DECKBRIDGE_TOKEN_TTL_DAYS = envTtl;

      const supabase = new TokenTestSupabase();
      const before = Date.now();
      const created = await createUserToken(supabase, `ttl-user-${String(envTtl)}-${String(optionTtl)}`, 'TTL test', { ttlDays: optionTtl });
      const after = Date.now();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const expiresAtMs = Date.parse(created.expiresAt);

      assert.ok(Number.isFinite(expiresAtMs));
      assert.ok(expiresAtMs >= before + ninetyDaysMs);
      assert.ok(expiresAtMs <= after + ninetyDaysMs + 1000);
    }
  } finally {
    if (previousTtl === undefined) delete process.env.DECKBRIDGE_TOKEN_TTL_DAYS;
    else process.env.DECKBRIDGE_TOKEN_TTL_DAYS = previousTtl;
  }
});

test('resolveTokenUser rejects expired and deck-mismatched add-on tokens', async () => {
  const supabase = new TokenTestSupabase();
  const user = {
    id: 'scoped-user',
    email: 'scoped@example.com',
    name: 'Scoped User'
  };

  const expired = await createUserToken(supabase, user, 'Expired add-on', { deckId: 'deck-a' });
  supabase.tables.user_tokens.find((row) => row.id === expired.id).expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await resolveTokenUser(supabase, expired.raw, { deckId: 'deck-a' }), null);

  const scoped = await createUserToken(supabase, user, 'Scoped add-on', { deckId: 'deck-a', ttlDays: 1 });
  assert.equal(await resolveTokenUser(supabase, scoped.raw, { deckId: 'deck-b' }), null);

  const resolved = await resolveTokenUser(supabase, scoped.raw, { deckId: 'deck-a' });
  assert.equal(resolved.id, 'scoped-user');
  assert.equal(resolved.email, 'scoped@example.com');
  assert.equal(resolved.token.id, scoped.id);
  assert.equal(resolved.token.deckId, 'deck-a');
  assert.equal(resolved.token.expiresAt, scoped.expiresAt);
  assert.ok(supabase.tables.user_tokens.find((row) => row.id === scoped.id).last_used_at);
});

test('token listing hides revoked and expired tokens while revoke marks revoked_at', async () => {
  const supabase = new TokenTestSupabase();
  const user = {
    id: 'list-user',
    email: 'list@example.com',
    name: 'List User'
  };

  const active = await createUserToken(supabase, user, 'Active', { deckId: 'deck-a' });
  const revoked = await createUserToken(supabase, user, 'Revoked', { deckId: 'deck-a' });
  const expired = await createUserToken(supabase, user, 'Expired', { deckId: 'deck-a' });
  supabase.tables.user_tokens.find((row) => row.id === expired.id).expires_at = new Date(Date.now() - 1000).toISOString();

  await revokeUserToken(supabase, user.id, revoked.id);
  assert.ok(supabase.tables.user_tokens.find((row) => row.id === revoked.id).revoked_at);

  const listed = await listUserTokens(supabase, user.id);
  assert.deepEqual(listed.map((row) => row.id), [active.id]);
  assert.equal(listed[0].deckId, 'deck-a');
  assert.equal(listed[0].expiresAt, active.expiresAt);
  assert.equal(listed[0].tokenTail, active.raw.slice(-8));
});
