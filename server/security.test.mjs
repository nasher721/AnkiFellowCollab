import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  assertValidDeckId,
  assertValidEmail,
  assertValidSessionRole,
  hashSecret,
  isScryptSecretHash,
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

test('comment resolution migration limits client updates to resolution fields', async () => {
  const sql = await fs.readFile(new URL('../supabase/migrations/20260507120000_comment_resolution.sql', import.meta.url), 'utf8');

  assert.match(sql, /create or replace function public\.enforce_comment_insert_scope/i);
  assert.match(sql, /where s\.id = new\.suggestion_id\s+and s\.deck_id = new\.deck_id/i);
  assert.match(sql, /parent\.suggestion_id = new\.suggestion_id\s+and parent\.deck_id = new\.deck_id/i);
  assert.match(sql, /new\.resolved_at := null/i);
  assert.match(sql, /create trigger enforce_comment_insert_scope/i);
  assert.match(sql, /create or replace function public\.enforce_comment_resolution_update/i);
  assert.match(sql, /new\.body is distinct from old\.body/i);
  assert.match(sql, /raise exception 'Only comment resolution fields may be updated'/i);
  assert.match(sql, /new\.resolved_by := auth\.uid\(\)::text/i);
  assert.match(sql, /revoke update on public\.comments from anon, authenticated/i);
  assert.match(sql, /grant update \(resolved_at, resolved_by, updated_at\) on public\.comments to authenticated/i);
});
