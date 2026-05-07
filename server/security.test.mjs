import assert from 'node:assert/strict';
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
