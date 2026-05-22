import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
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
