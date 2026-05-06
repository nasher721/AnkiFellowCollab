import test from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, hashToken } from './tokens.mjs';

test('generateToken returns db_ prefixed raw token', () => {
  const { raw, hash } = generateToken();
  assert.ok(raw.startsWith('db_'));
  assert.ok(raw.length > 10);
  assert.ok(typeof hash === 'string');
  assert.equal(hash.length, 64);
});

test('hashToken produces consistent SHA-256', () => {
  const raw = 'db_test123';
  const hash1 = hashToken(raw);
  const hash2 = hashToken(raw);
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

test('different tokens produce different hashes', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
});
