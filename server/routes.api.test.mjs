import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';

async function createTestApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckbridge-api-'));
  process.env.DECKBRIDGE_DATA_DIR = dataDir;
  const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
  return {
    app: createApp({
      production: false,
      repositoryMode: 'local',
      parseApkg: async () => ({
        deck_name: 'Uploaded Deck',
        cards: [{ id: 'uploaded-card', front: 'Front', back: 'Back', type: 'Basic', tags: ['Upload'] }]
      }),
      createApkg: async (_jsonPath, apkgPath) => {
        await fs.writeFile(apkgPath, 'fake-apkg', 'utf8');
      }
    }),
    dataDir
  };
}

function asUser(req, id, name = id) {
  return req
    .set('x-deckbridge-user-id', id)
    .set('x-deckbridge-user-email', `${id}@example.com`)
    .set('x-deckbridge-user-name', name);
}

test('authenticated API returns current user and visible decks', async () => {
  const { app } = await createTestApp();

  const me = await asUser(request(app).get('/api/me'), 'you', 'You').expect(200);
  assert.equal(me.body.user.id, 'you');
  assert.equal(me.body.memberships[0].role, 'owner');

  const decks = await asUser(request(app).get('/api/decks'), 'you', 'You').expect(200);
  assert.equal(decks.body.decks.length, 1);
});

test('membership roles gate owner decisions and collaborator suggestions', async () => {
  const { app } = await createTestApp();

  await asUser(request(app).post('/api/suggestions/sugg-anca/decision').send({ decision: 'accepted' }), 'maya', 'Maya Patel')
    .expect(403)
    .expect((res) => {
      assert.equal(res.body.error.code, 'forbidden');
    });

  const suggested = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions')
    .send({
      cardId: 'card-hpylori',
      reason: 'Clarifies regimen',
      proposedFields: { Front: 'Updated H. pylori treatment?' },
      proposedTags: ['GI', 'Step2', 'Review']
    }), 'maya', 'Maya Patel').expect(201);
  assert.equal(suggested.body.suggestions[0].authorId, 'maya');

  await asUser(request(app).post(`/api/suggestions/${suggested.body.suggestions[0].id}/decision`).send({ decision: 'accepted' }), 'you', 'You')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.suggestions[0].status, 'accepted');
    });
});

test('upload, export, and local-bridge conflict APIs use authenticated deck scope', async () => {
  const { app } = await createTestApp();
  const uploadPath = path.join(os.tmpdir(), `deck-${Date.now()}.apkg`);
  await fs.writeFile(uploadPath, 'fake', 'utf8');

  const uploaded = await asUser(request(app).post('/api/decks/upload').attach('deck', uploadPath), 'you', 'You').expect(201);
  const deckId = uploaded.body.activeDeckId;
  assert.equal(uploaded.body.decks[0].name, 'Uploaded Deck');

  const exportResult = await asUser(request(app).post(`/api/decks/${deckId}/export`).send({}), 'you', 'You').expect(200);
  assert.match(exportResult.body.download.url, /^\/downloads\//);

  const conflicts = await asUser(request(app)
    .post(`/api/decks/${deckId}/sync/conflicts`)
    .send({ conflicts: [{ cardId: 'uploaded-card', incomingFields: { Front: 'A' }, localFields: { Front: 'B' } }] }), 'you', 'You').expect(200);
  assert.equal(conflicts.body.sync.conflicts.length, 1);

  await fs.rm(uploadPath, { force: true });
});
