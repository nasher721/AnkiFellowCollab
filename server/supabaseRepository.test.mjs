import assert from 'node:assert/strict';
import test from 'node:test';
import { roleMeetsMinimum } from './repositories/supabaseRepository.mjs';

test('Supabase repository role ladder includes collaboration roles', () => {
  assert.equal(roleMeetsMinimum('owner', 'editor'), true);
  assert.equal(roleMeetsMinimum('editor', 'reviewer'), true);
  assert.equal(roleMeetsMinimum('reviewer', 'contributor'), true);
  assert.equal(roleMeetsMinimum('contributor', 'viewer'), true);
  assert.equal(roleMeetsMinimum('contributor', 'reviewer'), false);
  assert.equal(roleMeetsMinimum('reviewer', 'editor'), false);
});

test('Supabase repository role ladder rejects unknown roles', () => {
  assert.equal(roleMeetsMinimum('admin', 'viewer'), false);
  assert.equal(roleMeetsMinimum('owner', 'admin'), false);
  assert.equal(roleMeetsMinimum(undefined, 'viewer'), false);
});
