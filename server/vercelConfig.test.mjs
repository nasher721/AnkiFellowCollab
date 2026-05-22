import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Vercel function bundles runtime files read from disk', async () => {
  const config = JSON.parse(await fs.readFile('vercel.json', 'utf8'));
  const apiFunction = config.functions?.['api/index.mjs'];
  const includeFiles = apiFunction?.includeFiles || [];

  assert.ok(includeFiles.includes('addons/deckbridge_sync/manifest.json'));
  assert.ok(includeFiles.includes('dist/deckbridge-sync.ankiaddon'));
  assert.ok(includeFiles.includes('openapi.yaml'));
});
