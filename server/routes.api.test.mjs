import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { createSeedState } from './domain.mjs';
import { fail } from './errors.mjs';
import { resolveTokenUser } from './tokens.mjs';

class FakeSupabase {
  constructor() {
    this.tables = {
      profiles: [],
      user_tokens: []
    };
    this.errors = [];
  }

  from(table) {
    return new FakeQuery(this.tables, table, this.errors);
  }
}

class FakeQuery {
  constructor(tables, table, errors = []) {
    this.tables = tables;
    this.table = table;
    this.errors = errors;
    this.filters = [];
    this.pendingUpdate = null;
    this.pendingDelete = false;
    this.limitCount = null;
    this.rangeBounds = null;
    this.selectOptions = {};
    this.orderClauses = [];
  }

  select(_columns, options = {}) {
    this.selectOptions = options || {};
    return this;
  }

  eq(field, value) {
    this.filters.push({ field, value });
    return this;
  }

  lt(field, value) {
    this.filters.push({ field, value, op: 'lt' });
    return this;
  }

  order(field, options = {}) {
    this.orderClauses.push({ field, ascending: options.ascending !== false });
    return this;
  }

  or(expression) {
    this.filters.push({ op: 'or', expression });
    return this;
  }

  range(from, to) {
    this.rangeBounds = { from, to };
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  ilike(field, pattern) {
    const needle = String(pattern).replaceAll('%', '').toLowerCase();
    this.filters.push({ field, value: needle, op: 'ilike' });
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
    const syntheticError = this.syntheticError();
    if (syntheticError) return { data: null, count: null, error: syntheticError };
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
    const rows = this.rows();
    if (this.selectOptions.head) return { data: null, count: rows.length, error: null };
    return { data: rows, count: this.selectOptions.count ? rows.length : null, error: null };
  }

  syntheticError() {
    const isHead = Boolean(this.selectOptions.head);
    const match = this.errors.find((error) => error.table === this.table && (error.head === undefined || error.head === isHead));
    return match ? { message: match.message || 'Synthetic Supabase error' } : null;
  }

  async maybeSingle() {
    return { data: this.rows()[0] || null, error: null };
  }

  async single() {
    return this.maybeSingle();
  }

  rows() {
    let rows = this.tables[this.table].filter((row) => this.matches(row));
    rows = this.applyOrder(rows);
    if (this.rangeBounds) rows = rows.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  applyOrder(rows) {
    if (!this.orderClauses.length) return rows;
    return [...rows].sort((a, b) => {
      for (const { field, ascending } of this.orderClauses) {
        const left = a[field];
        const right = b[field];
        if (left === right) continue;
        const comparison = left > right ? 1 : -1;
        return ascending ? comparison : -comparison;
      }
      return 0;
    });
  }

  matches(row) {
    return this.filters.every(({ field, value, op, expression }) => {
      if (op === 'ilike') return String(row[field] || '').toLowerCase().includes(value);
      if (op === 'lt') return row[field] < value;
      if (op === 'or') return this.matchesOr(row, expression);
      return row[field] === value;
    });
  }

  matchesOr(row, expression) {
    const match = String(expression).match(/^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.(.+)\)$/);
    if (!match) throw new Error(`Unsupported fake Supabase or expression: ${expression}`);
    const [, olderThan, tiedAt, afterId] = match;
    return row.created_at < olderThan || (row.created_at === tiedAt && row.id < afterId);
  }
}

async function createTestApp(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckbridge-api-'));
  process.env.DECKBRIDGE_DATA_DIR = dataDir;
  const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
  return {
    app: createApp({
      production: false,
      repositoryMode: 'local',
      rateLimits: { disabled: true },
      parseApkg: async () => ({
        deck_name: 'Uploaded Deck',
        cards: [{ id: 'uploaded-card', front: 'Front', back: 'Back', type: 'Basic', tags: ['Upload'] }]
      }),
      createApkg: async (_jsonPath, apkgPath) => {
        await fs.writeFile(apkgPath, 'fake-apkg', 'utf8');
      },
      ...options
    }),
    dataDir
  };
}

async function createTokenTestApp(options = {}) {
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
    app: createApp({ production: false, repositoryMode: 'local', auth, rateLimits: { disabled: true }, ...options }),
    supabase
  };
}

function asUser(req, id, name = id) {
  return req
    .set('x-deckbridge-user-id', id)
    .set('x-deckbridge-user-email', `${id}@example.com`)
    .set('x-deckbridge-user-name', name);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function seedLocalState(dataDir, mutator) {
  const state = createSeedState();
  mutator(state);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
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

  const contributorSession = await asUser(request(app)
    .patch('/api/session')
    .send({ role: 'contributor' }), 'you', 'You').expect(200);
  assert.equal(contributorSession.body.role, 'contributor');
});

test('rate limiting protects read and sync routes with configurable limits', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckbridge-api-'));
  process.env.DECKBRIDGE_DATA_DIR = dataDir;
  const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
  const app = createApp({
    production: false,
    repositoryMode: 'local',
    rateLimits: {
      windowMs: 60_000,
      readLimit: 1,
      syncLimit: 1,
      uploadLimit: 1,
      analyticsLimit: 1
    }
  });

  await asUser(request(app).get('/api/decks'), 'you', 'You').expect(200);
  const readLimited = await asUser(request(app).get('/api/decks'), 'you', 'You').expect(429);
  assert.equal(readLimited.body.error.code, 'rate_limited');

  const syncBody = {
    conflictPolicy: 'overwrite-platform',
    source: 'DeckBridge Sync rate-limit test',
    client: { name: 'DeckBridge Sync', version: '0.1.0', fingerprint: 'rate-limit-test' },
    cards: [{
      id: 'anki-rate-limit-1',
      ankiNoteId: 99001,
      type: 'Basic',
      modelName: 'Basic',
      fieldOrder: ['Front', 'Back'],
      fields: { Front: 'Rate limit front', Back: 'Rate limit back' },
      tags: ['DeckBridge'],
      state: 'Review',
      suspended: false
    }]
  };

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send(syncBody), 'you', 'You').expect(200);
  const syncLimited = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send(syncBody), 'you', 'You').expect(429);
  assert.equal(syncLimited.body.error.code, 'rate_limited');
});

test('rate limiting separates forwarded client IPs behind one trusted proxy', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckbridge-api-'));
  process.env.DECKBRIDGE_DATA_DIR = dataDir;
  const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
  const app = createApp({
    production: false,
    repositoryMode: 'local',
    trustProxy: 1,
    rateLimits: {
      windowMs: 60_000,
      readLimit: 1,
      syncLimit: 1,
      uploadLimit: 1,
      analyticsLimit: 1
    }
  });

  await asUser(request(app)
    .get('/api/decks')
    .set('x-forwarded-for', '203.0.113.10'), 'you', 'You').expect(200);
  const sameIpLimited = await asUser(request(app)
    .get('/api/decks')
    .set('x-forwarded-for', '203.0.113.10'), 'you', 'You').expect(429);
  assert.equal(sameIpLimited.body.error.code, 'rate_limited');

  await asUser(request(app)
    .get('/api/decks')
    .set('x-forwarded-for', '203.0.113.11'), 'you', 'You').expect(200);

  const multiHopDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckbridge-api-'));
  process.env.DECKBRIDGE_DATA_DIR = multiHopDataDir;
  const multiHopApp = createApp({
    production: false,
    repositoryMode: 'local',
    trustProxy: 1,
    rateLimits: {
      windowMs: 60_000,
      readLimit: 1,
      syncLimit: 1,
      uploadLimit: 1,
      analyticsLimit: 1
    }
  });

  await asUser(request(multiHopApp)
    .get('/api/decks')
    .set('x-forwarded-for', '198.51.100.1, 203.0.113.10'), 'you', 'You').expect(200);
  const sameTrustedHopLimited = await asUser(request(multiHopApp)
    .get('/api/decks')
    .set('x-forwarded-for', '198.51.100.2, 203.0.113.10'), 'you', 'You').expect(429);
  assert.equal(sameTrustedHopLimited.body.error.code, 'rate_limited');
});

test('rate limiting ignores spoofed forwarded IPs without a trusted proxy', async () => {
  const previousVercel = process.env.VERCEL;
  delete process.env.VERCEL;
  try {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckbridge-api-'));
    process.env.DECKBRIDGE_DATA_DIR = dataDir;
    const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
    const app = createApp({
      production: false,
      repositoryMode: 'local',
      rateLimits: {
        windowMs: 60_000,
        readLimit: 1,
        syncLimit: 1,
        uploadLimit: 1,
        analyticsLimit: 1
      }
    });

    await asUser(request(app)
      .get('/api/decks')
      .set('x-forwarded-for', '203.0.113.20'), 'you', 'You').expect(200);
    const spoofedIpLimited = await asUser(request(app)
      .get('/api/decks')
      .set('x-forwarded-for', '203.0.113.21'), 'you', 'You').expect(429);
    assert.equal(spoofedIpLimited.body.error.code, 'rate_limited');
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
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

test('Anki login exchanges account credentials for an add-on token', async () => {
  const authLoginClient = {
    auth: {
      async signInWithPassword({ email, password }) {
        assert.equal(email, 'anki@example.com');
        assert.equal(password, 'correct horse');
        return {
          data: {
            user: {
              id: 'anki-user',
              email,
              user_metadata: { name: 'Anki User' }
            }
          },
          error: null
        };
      }
    }
  };
  const { app, supabase } = await createTokenTestApp({ authLoginClient });

  const response = await request(app)
    .post('/api/anki/login')
    .send({ email: 'anki@example.com', password: 'correct horse' })
    .expect(200);

  assert.equal(response.body.user.id, 'anki-user');
  assert.match(response.body.token.token, /^db_/);
  assert.equal(supabase.tables.user_tokens[0].user_id, 'anki-user');
  assert.equal(response.body.decks.length, 0);
});

test('add-on endpoints expose manifest version and package download behavior', async () => {
  const { app } = await createTestApp();
  const addonPath = path.resolve(process.cwd(), 'dist', 'deckbridge-sync.ankiaddon');
  const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), 'addons', 'deckbridge_sync', 'manifest.json'), 'utf8'));
  await fs.rm(addonPath, { force: true });

  const version = await request(app).get('/api/addon/version').expect(200);
  assert.equal(version.body.version, manifest.version);
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

test('suggestion comments can be listed and resolved in local repository mode', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/suggestions/sugg-anca/comments')
    .send({ body: 'This thread is handled by the source edit.' }), 'maya', 'Maya Patel').expect(201);

  assert.equal(created.body.authorId, 'maya');
  assert.equal(created.body.resolvedAt, null);
  assert.equal(created.body.resolvedBy, null);

  const listed = await asUser(request(app)
    .get('/api/suggestions/sugg-anca/comments'), 'you', 'You').expect(200);
  assert.equal(listed.body.comments.length, 1);
  assert.equal(listed.body.comments[0].id, created.body.id);

  const resolved = await asUser(request(app)
    .patch(`/api/suggestions/sugg-anca/comments/${created.body.id}/resolved`)
    .send({ resolved: true }), 'you', 'You').expect(200);
  assert.ok(resolved.body.resolvedAt);
  assert.equal(resolved.body.resolvedBy, 'you');

  const unresolved = await asUser(request(app)
    .patch(`/api/suggestions/sugg-anca/comments/${created.body.id}/resolved`)
    .send({ resolved: false }), 'you', 'You').expect(200);
  assert.equal(unresolved.body.resolvedAt, null);
  assert.equal(unresolved.body.resolvedBy, null);
});

test('suggestion comment API rejects non-members, missing comments, and invalid parents', async () => {
  const { app } = await createTestApp();

  await asUser(request(app)
    .get('/api/suggestions/sugg-anca/comments'), 'outsider', 'Outside User')
    .expect(403)
    .expect((res) => {
      assert.equal(res.body.error.code, 'forbidden');
    });

  await asUser(request(app)
    .post('/api/suggestions/sugg-anca/comments')
    .send({ body: 'Reply to a missing parent', parentId: 'comment-missing' }), 'you', 'You')
    .expect(404)
    .expect((res) => {
      assert.equal(res.body.error.code, 'comment_not_found');
    });

  await asUser(request(app)
    .patch('/api/suggestions/sugg-anca/comments/comment-missing/resolved')
    .send({ resolved: true }), 'you', 'You')
    .expect(404)
    .expect((res) => {
      assert.equal(res.body.error.code, 'comment_not_found');
    });
});

test('single suggestion role access allows reviewers and editors but rejects contributors', async () => {
  for (const role of ['reviewer', 'editor']) {
    const { app, dataDir } = await createTestApp();
    await seedLocalState(dataDir, (state) => {
      state.collaborators.find((person) => person.id === 'you').role = role;
    });

    await asUser(request(app)
      .post('/api/suggestions/sugg-anca/decision')
      .send({ decision: 'rejected' }), 'you', 'You')
      .expect(200)
      .expect((res) => {
        assert.equal(res.body.suggestions.find((item) => item.id === 'sugg-anca').status, 'rejected');
      });
  }

  const { app, dataDir } = await createTestApp();
  await seedLocalState(dataDir, (state) => {
    state.collaborators.find((person) => person.id === 'you').role = 'contributor';
  });

  await asUser(request(app)
    .post('/api/suggestions/sugg-anca/decision')
    .send({ decision: 'rejected' }), 'you', 'You')
    .expect(403)
    .expect((res) => {
      assert.equal(res.body.error.code, 'forbidden');
    });
});

test('bulk suggestion decisions accept multiple pending suggestions for a deck', async () => {
  const { app } = await createTestApp();

  const first = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions')
    .send({
      cardId: 'card-hpylori',
      reason: 'First change',
      proposedFields: { Front: 'First bulk update?' },
      proposedTags: ['GI', 'Bulk']
    }), 'maya', 'Maya Patel').expect(201);
  const firstId = first.body.suggestions[0].id;

  const second = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions')
    .send({
      cardId: 'card-b12',
      reason: 'Second change',
      proposedFields: { Front: 'Second bulk update?' },
      proposedTags: ['Neurology', 'Bulk']
    }), 'maya', 'Maya Patel').expect(201);
  const secondId = second.body.suggestions[0].id;

  const decided = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: [firstId, secondId], decision: 'rejected' }), 'you', 'You').expect(200);

  const statuses = new Map(decided.body.suggestions.map((item) => [item.id, item.status]));
  assert.equal(statuses.get(firstId), 'rejected');
  assert.equal(statuses.get(secondId), 'rejected');
});

test('bulk suggestion validation rejects duplicate and oversized id lists', async () => {
  const { app } = await createTestApp();

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: 'sugg-anca', decision: 'rejected' }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'missing_suggestion_ids');
    });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: [], decision: 'rejected' }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'missing_suggestion_ids');
    });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: ['sugg-anca', 'sugg-anca'], decision: 'rejected' }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'duplicate_suggestion_ids');
    });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: Array.from({ length: 101 }, (_, index) => `sugg-${index}`), decision: 'rejected' }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'too_many_suggestion_ids');
    });

  for (const invalidId of ['', '   ', 42, 'x'.repeat(201)]) {
    await asUser(request(app)
      .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
      .send({ suggestionIds: ['sugg-anca', invalidId], decision: 'rejected' }), 'you', 'You')
      .expect(400)
      .expect((res) => {
        assert.equal(res.body.error.code, 'invalid_suggestion_id');
      });
  }
});

test('bulk suggestion role access allows reviewers and editors but rejects contributors', async () => {
  for (const role of ['reviewer', 'editor']) {
    const { app, dataDir } = await createTestApp();
    await seedLocalState(dataDir, (state) => {
      state.collaborators.find((person) => person.id === 'you').role = role;
    });

    await asUser(request(app)
      .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
      .send({ suggestionIds: ['sugg-anca'], decision: 'rejected' }), 'you', 'You')
      .expect(200)
      .expect((res) => {
        assert.equal(res.body.suggestions.find((item) => item.id === 'sugg-anca').status, 'rejected');
      });
  }

  const { app, dataDir } = await createTestApp();
  await seedLocalState(dataDir, (state) => {
    state.collaborators.find((person) => person.id === 'you').role = 'contributor';
  });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: ['sugg-anca'], decision: 'rejected' }), 'you', 'You')
    .expect(403)
    .expect((res) => {
      assert.equal(res.body.error.code, 'forbidden');
    });
});

test('bulk suggestion decisions apply accepted suggestions in request order', async () => {
  const { app } = await createTestApp();

  const first = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions')
    .send({
      cardId: 'card-hpylori',
      reason: 'First accepted change',
      proposedFields: { Front: 'First accepted bulk update?' },
      proposedTags: ['GI', 'Bulk', 'First']
    }), 'maya', 'Maya Patel').expect(201);
  const firstId = first.body.suggestions[0].id;

  const second = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions')
    .send({
      cardId: 'card-hpylori',
      reason: 'Second accepted change',
      proposedFields: { Front: 'Second accepted bulk update?' },
      proposedTags: ['GI', 'Bulk', 'Second']
    }), 'maya', 'Maya Patel').expect(201);
  const secondId = second.body.suggestions[0].id;

  const decided = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: [firstId, secondId], decision: 'accepted' }), 'you', 'You').expect(200);

  const card = decided.body.decks[0].cards.find((item) => item.id === 'card-hpylori');
  const statuses = new Map(decided.body.suggestions.map((item) => [item.id, item.status]));
  assert.equal(card.fields.Front, 'Second accepted bulk update?');
  assert.deepEqual(card.tags, ['GI', 'Bulk', 'Second']);
  assert.equal(statuses.get(firstId), 'accepted');
  assert.equal(statuses.get(secondId), 'accepted');
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
      client: { name: 'DeckBridge Sync', version: '0.1.0', fingerprint: 'test-host' },
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
  assert.equal(created.body.result.source, 'DeckBridge Sync test');
  assert.equal(created.body.result.client.name, 'DeckBridge Sync');
  assert.equal(created.body.state.sync.lastAddonSync.stats.created, 1);
  assert.equal(created.body.state.sync.lastAddonSync.client.version, '0.1.0');
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

  const dryRun = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      dryRun: true,
      conflictPolicy: 'detect',
      source: 'DeckBridge Sync preview',
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

  assert.equal(dryRun.body.result.stats.dryRun, true);
  assert.equal(dryRun.body.state.sync.lastAddonSync.stats.dryRun, true);
  assert.equal(dryRun.body.state.sync.lastAddonSync.source, 'DeckBridge Sync preview');

  const batchId = 'test-batch-1';
  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      source: 'DeckBridge Sync batch',
      batch: { id: batchId, index: 0, total: 2, totalCards: 2 },
      cards: [{
        id: 'anki-9101',
        ankiNoteId: 9101,
        fields: { Front: 'Batch card one', Back: 'First chunk' }
      }]
    }), 'you', 'You').expect(200);

  const batch = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      source: 'DeckBridge Sync batch',
      batch: { id: batchId, index: 1, total: 2, totalCards: 2 },
      cards: [{
        id: 'anki-9102',
        ankiNoteId: 9102,
        fields: { Front: 'Batch card two', Back: 'Second chunk' }
      }]
    }), 'you', 'You').expect(200);

  assert.equal(batch.body.state.sync.lastAddonSync.stats.total, 2);
  assert.equal(batch.body.state.sync.lastAddonSync.stats.created, 2);
  assert.equal(batch.body.state.sync.lastAddonSync.batch.complete, true);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'detect',
      source: 'DeckBridge Sync conflict batch',
      batch: { id: 'conflict-batch-1', index: 0, total: 2, totalCards: 2 },
      cards: [{
        id: 'anki-9101',
        ankiNoteId: 9101,
        fields: { Front: 'Changed batch card one', Back: 'First chunk' }
      }]
    }), 'you', 'You').expect(200);

  const conflictBatch = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'detect',
      source: 'DeckBridge Sync conflict batch',
      batch: { id: 'conflict-batch-1', index: 1, total: 2, totalCards: 2 },
      cards: [{
        id: 'anki-9102',
        ankiNoteId: 9102,
        fields: { Front: 'Changed batch card two', Back: 'Second chunk' }
      }]
    }), 'you', 'You').expect(200);

  assert.equal(conflictBatch.body.state.sync.conflicts.length, 2);
  assert.equal(conflictBatch.body.state.sync.lastAddonSync.stats.conflicts, 2);
});

test('Anki add-on sync persists media and serves it through authenticated route', async () => {
  const { app } = await createTestApp();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const filename = 'neuro-image.png';

  const synced = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      source: 'DeckBridge Sync media test',
      cards: [{
        id: 'anki-media-route-1',
        ankiNoteId: 9901,
        fields: { Front: `<img src="${filename}">`, Back: 'Image answer' },
        mediaRefs: [filename]
      }],
      media: {
        [filename]: {
          mimeType: 'image/png',
          sha256: sha256(bytes),
          dataBase64: bytes.toString('base64')
        }
      }
    }), 'you', 'You').expect(200);

  assert.equal(synced.body.state.decks[0].media[filename].mimeType, 'image/png');

  const media = await asUser(request(app)
    .get(`/api/decks/deck-demo-zanki/media/${encodeURIComponent(filename)}`), 'you', 'You')
    .expect(200);

  assert.equal(media.headers['content-type'], 'image/png');
  assert.equal(media.headers['cache-control'], 'private, max-age=3600');
  assert.equal(media.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(media.body, bytes);
});

test('Anki add-on sync stores unsafe media mime as octet-stream attachment', async () => {
  const { app } = await createTestApp();
  const bytes = Buffer.from('<script>alert(1)</script>');
  const filename = 'unsafe.html';

  const synced = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      cards: [{
        id: 'anki-media-unsafe-1',
        ankiNoteId: 9902,
        fields: { Front: `<img src="${filename}">` },
        mediaRefs: [filename]
      }],
      media: {
        [filename]: {
          mimeType: 'text/html',
          sha256: sha256(bytes),
          dataBase64: bytes.toString('base64')
        }
      }
    }), 'you', 'You').expect(200);

  assert.equal(synced.body.state.decks[0].media[filename].mimeType, 'application/octet-stream');

  const media = await asUser(request(app)
    .get(`/api/decks/deck-demo-zanki/media/${encodeURIComponent(filename)}`), 'you', 'You')
    .expect(200);

  assert.equal(media.headers['content-type'], 'application/octet-stream');
  assert.equal(media.headers['content-disposition'], 'attachment; filename="unsafe.html"');
  assert.deepEqual(media.body, bytes);
});

test('Anki add-on can create the first DeckBridge workspace from a local deck', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/decks/sync/from-anki')
    .send({
      deckName: 'Neuro Boards',
      source: 'DeckBridge Sync test',
      cards: [{
        id: 'anki-777',
        ankiNoteId: 777,
        type: 'Cloze',
        modelName: 'Cloze',
        fieldOrder: ['Text', 'Extra'],
        fields: { Text: '{{c1::Nimodipine}} after SAH reduces delayed ischemia risk.', Extra: 'Board-style pearl' },
        tags: ['NeuroICU'],
        state: 'Review',
        suspended: false,
        sourceDeckName: 'Neuro Boards'
      }]
    }), 'new-user', 'New User').expect(201);

  assert.equal(created.body.deck.name, 'Neuro Boards');
  assert.equal(created.body.result.stats.created, 1);
  assert.equal(created.body.state.decks[0].name, 'Neuro Boards');
  assert.equal(created.body.state.memberships[0].role, 'owner');
  assert.equal(created.body.state.decks[0].cards[0].ankiNoteId, 777);
});

test('study session API persists and lists sessions without changing progress contract', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/study/sessions')
    .send({
      deckId: 'deck-demo-zanki',
      durationSeconds: 420,
      cardsStudied: 12,
      cardsCorrect: 9,
      newCards: 3,
      reviewCards: 9,
      metadata: { mode: 'review' }
    }), 'you', 'You').expect(201);

  assert.equal(created.body.session.deckId, 'deck-demo-zanki');
  assert.equal(created.body.session.cardsStudied, 12);
  assert.equal(created.body.session.metadata.mode, 'review');

  const listed = await asUser(request(app).get('/api/study/sessions/deck-demo-zanki'), 'you', 'You').expect(200);
  assert.equal(listed.body.sessions.length, 1);
  assert.equal(listed.body.sessions[0].cardsCorrect, 9);

  await asUser(request(app).post('/api/study/progress').send({ updates: [] }), 'you', 'You')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.ok, true);
    });
});

test('share link API creates owner links and redacts password hashes', async () => {
  const { app } = await createTestApp();

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/share-links')
    .send({ label: 'Board review group', password: 'study-room' }), 'maya', 'Maya Patel')
    .expect(403);

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/share-links')
    .send({ label: 'Board review group', password: 'study-room' }), 'you', 'You')
    .expect(201);

  assert.equal(created.body.shareLink.label, 'Board review group');
  assert.match(created.body.shareLink.token, /^[A-Za-z0-9_-]+$/);
  assert.equal(created.body.shareLink.passwordProtected, true);
  assert.equal(Object.hasOwn(created.body.shareLink, 'passwordHash'), false);

  const listed = await asUser(request(app).get('/api/decks/deck-demo-zanki/share-links'), 'you', 'You').expect(200);
  assert.equal(listed.body.shareLinks.length, 1);
  assert.equal(listed.body.shareLinks[0].passwordProtected, true);
  assert.equal(Object.hasOwn(listed.body.shareLinks[0], 'passwordHash'), false);
});

test('security validation rejects malformed deck ids and session roles', async () => {
  const { app } = await createTestApp();

  await asUser(request(app)
    .patch('/api/session')
    .send({ role: 'admin' }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'invalid_role');
    });

  await asUser(request(app)
    .post('/api/decks/../../state/export')
    .send({}), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'invalid_deck_id');
    });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/share-links')
    .send({ label: 'Unsafe', passwordHash: 'client-supplied' }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'password_hash_not_allowed');
    });
});

test('invite API rejects malformed email before storing invite', async () => {
  const { app } = await createTestApp();

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/invites')
    .send({ email: 'not-an-email', role: 'contributor' }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'invalid_email');
    });

  const invites = await asUser(request(app).get('/api/decks/deck-demo-zanki/invites'), 'you', 'You').expect(200);
  assert.equal(invites.body.invites.length, 0);
});

test('notifications API supports limit and created_at cursor pagination', async () => {
  const supabase = new FakeSupabase();
  supabase.tables.notifications = [
    { id: 'n1', user_id: 'you', deck_id: 'deck-demo-zanki', kind: 'decision', body: 'Oldest', ref_id: null, read: true, created_at: '2026-05-07T12:01:00.000Z' },
    { id: 'n3', user_id: 'you', deck_id: 'deck-demo-zanki', kind: 'comment', body: 'Tied newer', ref_id: null, read: false, created_at: '2026-05-07T12:03:00.000Z' },
    { id: 'n2', user_id: 'you', deck_id: 'deck-demo-zanki', kind: 'reaction', body: 'Middle', ref_id: null, read: false, created_at: '2026-05-07T12:02:00.000Z' },
    { id: 'n4', user_id: 'you', deck_id: 'deck-demo-zanki', kind: 'comment', body: 'Newest tie', ref_id: 'comment-4', read: false, created_at: '2026-05-07T12:03:00.000Z' }
  ];
  const { app } = await createTestApp({
    auth: {
      supabase,
      requireUser(req, _res, next) {
        req.user = { id: 'you', email: 'you@example.com', name: 'You' };
        next();
      }
    }
  });

  const first = await request(app)
    .get('/api/notifications')
    .query({ limit: 2 })
    .expect(200);
  assert.deepEqual(first.body.notifications.map((notification) => notification.id), ['n4', 'n3']);
  assert.equal(first.body.unread, 3);
  assert.ok(first.body.nextCursor);
  assert.equal(first.body.notifications[0].deckId, 'deck-demo-zanki');
  assert.equal(first.body.notifications[0].refId, 'comment-4');
  assert.equal(first.body.notifications[0].createdAt, '2026-05-07T12:03:00.000Z');
  assert.equal(first.body.notifications[0].deck_id, undefined);
  assert.equal(first.body.notifications[0].ref_id, undefined);
  assert.equal(first.body.notifications[0].created_at, undefined);

  const second = await request(app)
    .get('/api/notifications')
    .query({ limit: 2, cursor: first.body.nextCursor })
    .expect(200);
  assert.deepEqual(second.body.notifications.map((notification) => notification.id), ['n2', 'n1']);
  assert.equal(second.body.nextCursor, null);
});

test('notifications API reports page query errors', async () => {
  const supabase = new FakeSupabase();
  supabase.tables.notifications = [];
  supabase.errors = [{ table: 'notifications', head: false, message: 'page query failed' }];
  const { app } = await createTestApp({
    auth: {
      supabase,
      requireUser(req, _res, next) {
        req.user = { id: 'you', email: 'you@example.com', name: 'You' };
        next();
      }
    }
  });

  await request(app)
    .get('/api/notifications')
    .expect(500)
    .expect((res) => {
      assert.equal(res.body.error.code, 'notifications_error');
      assert.equal(res.body.error.message, 'page query failed');
    });
});

test('notifications API reports unread count query errors', async () => {
  const supabase = new FakeSupabase();
  supabase.tables.notifications = [];
  supabase.errors = [{ table: 'notifications', head: true, message: 'unread count failed' }];
  const { app } = await createTestApp({
    auth: {
      supabase,
      requireUser(req, _res, next) {
        req.user = { id: 'you', email: 'you@example.com', name: 'You' };
        next();
      }
    }
  });

  await request(app)
    .get('/api/notifications')
    .expect(500)
    .expect((res) => {
      assert.equal(res.body.error.code, 'notifications_error');
      assert.equal(res.body.error.message, 'unread count failed');
    });
});

test('notifications API rejects malformed cursors', async () => {
  const supabase = new FakeSupabase();
  supabase.tables.notifications = [];
  const { app } = await createTestApp({
    auth: {
      supabase,
      requireUser(req, _res, next) {
        req.user = { id: 'you', email: 'you@example.com', name: 'You' };
        next();
      }
    }
  });

  await request(app)
    .get('/api/notifications')
    .query({ cursor: 'not-a-valid-cursor' })
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'invalid_cursor');
    });
});

test('discover API returns real preview fields from public deck cards', async () => {
  const supabase = new FakeSupabase();
  supabase.tables.decks = [{
    id: 'public-deck',
    name: 'Public Deck',
    description: 'Visible deck',
    owner_id: 'you',
    owner_name: 'You',
    imported_at: new Date().toISOString(),
    visibility: 'public',
    download_count: 4,
    fork_of: null,
    deck_stars: [{ count: 2 }]
  }];
  supabase.tables.cards = [
    { id: 'card-1', deck_id: 'public-deck', note_type: 'Basic', fields: { Front: 'Preview front', Back: 'Preview back' }, created_at: '2026-05-06T00:00:00.000Z' },
    { id: 'card-2', deck_id: 'public-deck', note_type: 'Cloze', fields: { Text: 'Preview {{c1::cloze}}' }, created_at: '2026-05-06T00:01:00.000Z' }
  ];
  const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
  const app = createApp({
    production: false,
    repositoryMode: 'local',
    auth: {
      supabase,
      requireUser(_req, _res, next) { next(); }
    }
  });

  const response = await request(app).get('/api/discover').expect(200);
  assert.equal(response.body.decks.length, 1);
  assert.equal(response.body.decks[0].cardCount, 2);
  assert.deepEqual(response.body.decks[0].noteTypes.sort(), ['Basic', 'Cloze']);
  assert.deepEqual(response.body.decks[0].sampleCards[0], { Front: 'Preview front', Back: 'Preview back' });
});

test('activity filtering and summary exports return backend-only artifacts', async () => {
  const { app } = await createTestApp();

  const activity = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/activity')
    .query({ kind: 'export', limit: 1 }), 'you', 'You')
    .expect(200);
  assert.equal(activity.body.activity.length, 1);
  assert.equal(activity.body.activity[0].kind, 'export');

  const csv = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/export/activity')
    .query({ kind: 'export' }), 'you', 'You')
    .expect(200);
  assert.match(csv.text, /Kind,Text/);
  assert.match(csv.text, /export/);
  assert.doesNotMatch(csv.text, /suggestion/);

  const pdf = await asUser(request(app).get('/api/decks/deck-demo-zanki/export/summary'), 'you', 'You')
    .buffer(true)
    .parse((res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.body.subarray(0, 8).toString('utf8'), '%PDF-1.4');

  const html = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/export/summary')
    .query({ format: 'html' }), 'you', 'You')
    .expect(200);
  assert.match(html.text, /DeckBridge summary/);
});
