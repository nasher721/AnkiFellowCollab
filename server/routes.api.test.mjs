import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { fail } from './errors.mjs';
import { resolveTokenUser } from './tokens.mjs';

class FakeSupabase {
  constructor() {
    this.tables = {
      profiles: [],
      user_tokens: []
    };
  }

  from(table) {
    return new FakeQuery(this.tables, table);
  }
}

class FakeQuery {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.pendingUpdate = null;
    this.pendingDelete = false;
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
    const rows = this.tables[this.table];
    const index = rows.findIndex((item) => item.id === row.id);
    if (index >= 0) rows[index] = { ...rows[index], ...row };
    else rows.push(row);
    return { data: row, error: null };
  }

  async insert(row) {
    this.tables[this.table].push(row);
    return { data: row, error: null };
  }

  update(values) {
    this.pendingUpdate = values;
    return this;
  }

  delete() {
    this.pendingDelete = true;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  catch(reject) {
    return this.execute().catch(reject);
  }

  async execute() {
    if (this.pendingDelete) {
      const rows = this.tables[this.table];
      const kept = rows.filter((row) => !this.matches(row));
      this.tables[this.table].splice(0, rows.length, ...kept);
      return { error: null };
    }
    if (this.pendingUpdate) {
      for (const row of this.rows()) {
        Object.assign(row, this.pendingUpdate);
      }
      return { error: null };
    }
    return { data: this.rows(), error: null };
  }

  async maybeSingle() {
    return { data: this.rows()[0] || null, error: null };
  }

  async single() {
    return this.maybeSingle();
  }

  rows() {
    return this.tables[this.table].filter((row) => this.matches(row));
  }

  matches(row) {
    return this.filters.every(({ field, value }) => row[field] === value);
  }
}

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

async function createTokenTestApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckbridge-api-'));
  process.env.DECKBRIDGE_DATA_DIR = dataDir;
  const supabase = new FakeSupabase();
  const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
  const auth = {
    supabase,
    async requireUser(req, _res, next) {
      try {
        const authHeader = req.get('authorization') || '';
        const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
        if (bearer) {
          const tokenUser = await resolveTokenUser(supabase, bearer);
          if (!tokenUser) fail(401, 'unauthorized', 'Invalid or expired session');
          req.user = tokenUser;
        } else {
          req.user = {
            id: req.get('x-deckbridge-user-id') || 'user-1',
            email: req.get('x-deckbridge-user-email') || 'user-1@example.com',
            name: req.get('x-deckbridge-user-name') || 'User One'
          };
        }
        next();
      } catch (error) {
        next(error);
      }
    }
  };
  return {
    app: createApp({ production: false, repositoryMode: 'local', auth }),
    supabase
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
  assert.equal(me.body.decks.length, 1);
  assert.equal(me.body.decks[0].id, 'deck-demo-zanki');

  const decks = await asUser(request(app).get('/api/decks'), 'you', 'You').expect(200);
  assert.equal(decks.body.decks.length, 1);
});

test('token API creates one-time raw tokens and lists metadata only', async () => {
  const { app, supabase } = await createTokenTestApp();

  const created = await asUser(request(app).post('/api/tokens').send({ label: 'MacBook Anki' }), 'you', 'You').expect(201);
  assert.equal(created.body.label, 'MacBook Anki');
  assert.match(created.body.token, /^db_/);
  assert.equal(created.body.raw, created.body.token);
  assert.equal(supabase.tables.profiles[0].id, 'you');
  assert.equal(supabase.tables.user_tokens[0].user_id, 'you');
  assert.notEqual(supabase.tables.user_tokens[0].token_hash, created.body.token);

  const listed = await asUser(request(app).get('/api/tokens'), 'you', 'You').expect(200);
  assert.equal(listed.body.tokens.length, 1);
  assert.equal(listed.body.tokens[0].label, 'MacBook Anki');
  assert.equal(Object.hasOwn(listed.body.tokens[0], 'raw'), false);
  assert.equal(Object.hasOwn(listed.body.tokens[0], 'token'), false);
  assert.equal(Object.hasOwn(listed.body.tokens[0], 'token_hash'), false);
});

test('Bearer API tokens authenticate /api/me and invalid tokens fail', async () => {
  const { app } = await createTokenTestApp();

  const created = await asUser(request(app).post('/api/tokens').send({}), 'you', 'You').expect(201);
  const me = await request(app).get('/api/me').set('authorization', `Bearer ${created.body.token}`).expect(200);
  assert.equal(me.body.user.id, 'you');
  assert.equal(me.body.user.email, 'dylan.smith@example.com');
  assert.equal(me.body.decks.length, 1);

  await request(app).get('/api/me').set('authorization', 'Bearer db_invalid')
    .expect(401)
    .expect((res) => {
      assert.equal(res.body.error.code, 'unauthorized');
    });
});

test('token management gracefully reports unavailable Supabase setup', async () => {
  const { app } = await createTestApp();

  await asUser(request(app).post('/api/tokens').send({}), 'you', 'You')
    .expect(501)
    .expect((res) => {
      assert.equal(res.body.error.code, 'tokens_unavailable');
    });
});

test('add-on endpoints expose manifest version and package download behavior', async () => {
  const { app } = await createTestApp();
  const addonPath = path.resolve(process.cwd(), 'dist', 'deckbridge-sync.ankiaddon');
  await fs.rm(addonPath, { force: true });

  const version = await request(app).get('/api/addon/version').expect(200);
  assert.equal(version.body.version, '0.1.0');
  assert.equal(version.body.minVersion, '23.10.0');
  assert.equal(version.body.package, 'deckbridge_sync');
  assert.equal(version.body.downloadUrl, '/api/addon/download');

  await request(app).get('/api/addon/download')
    .expect(404)
    .expect((res) => {
      assert.equal(res.body.error.code, 'addon_not_built');
    });

  await fs.mkdir(path.dirname(addonPath), { recursive: true });
  await fs.writeFile(addonPath, 'fake-addon', 'utf8');
  const download = await request(app).get('/api/addon/download').expect(200);
  assert.equal(download.headers['content-disposition'], 'attachment; filename="deckbridge-sync.ankiaddon"');
  assert.equal(download.text || download.body.toString('utf8'), 'fake-addon');
  await fs.rm(addonPath, { force: true });
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

test('Anki add-on sync endpoint creates cards and records safe conflicts', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      source: 'DeckBridge Sync test',
      cards: [{
        id: 'anki-9001',
        ankiNoteId: 9001,
        type: 'Basic',
        modelName: 'Basic',
        fieldOrder: ['Front', 'Back'],
        fields: { Front: 'Created from Anki', Back: 'Synced into platform' },
        tags: ['DeckBridge'],
        state: 'Review',
        suspended: false
      }]
    }), 'you', 'You').expect(200);

  assert.equal(created.body.result.stats.created, 1);
  assert.equal(created.body.state.decks[0].cards.some((card) => card.ankiNoteId === 9001), true);

  const conflict = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'detect',
      source: 'DeckBridge Sync test',
      cards: [{
        id: 'anki-9001',
        ankiNoteId: 9001,
        type: 'Basic',
        modelName: 'Basic',
        fieldOrder: ['Front', 'Back'],
        fields: { Front: 'Different local Anki text', Back: 'Synced into platform' },
        tags: ['DeckBridge'],
        state: 'Review',
        suspended: false
      }]
    }), 'you', 'You').expect(200);

  assert.equal(conflict.body.result.stats.conflicts, 1);
  assert.equal(conflict.body.state.sync.conflicts[0].cardId, 'anki-9001');
});
