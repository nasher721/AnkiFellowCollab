import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
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
    this.calls = [];
  }

  from(table) {
    return new FakeQuery(this.tables, table, this.errors, this.calls);
  }
}

class FakeQuery {
  constructor(tables, table, errors = [], calls = []) {
    this.tables = tables;
    this.table = table;
    this.errors = errors;
    this.calls = calls;
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

  async upsert(row, options = {}) {
    const incomingRows = Array.isArray(row) ? row : [row];
    const rows = this.tables[this.table] || [];
    this.tables[this.table] = rows;
    this.calls.push({
      table: this.table,
      operation: 'upsert',
      rowCount: incomingRows.length,
      options
    });
    const conflictColumns = String(options.onConflict || 'id')
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    for (const incoming of incomingRows) {
      const index = rows.findIndex((item) => conflictColumns.every((column) => item[column] === incoming[column]));
      if (index >= 0) rows[index] = { ...rows[index], ...incoming };
      else rows.push(incoming);
    }
    return { data: row, error: null };
  }

  async insert(row) {
    if (!this.tables[this.table]) this.tables[this.table] = [];
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

test('owner can remove a DeckBridge deck without touching Anki', async () => {
  const { app, dataDir } = await createTestApp();

  await asUser(request(app).delete('/api/decks/deck-demo-zanki'), 'maya', 'Maya Patel').expect(403);

  const removed = await asUser(request(app).delete('/api/decks/deck-demo-zanki'), 'you', 'You').expect(200);
  assert.deepEqual(removed.body.deleted, { id: 'deck-demo-zanki', name: 'Zanki Step 2 CK' });
  assert.equal(removed.body.state.decks.length, 0);
  assert.equal(removed.body.state.activeDeckId, null);
  assert.equal(removed.body.state.memberships.length, 0);

  const listed = await asUser(request(app).get('/api/decks'), 'you', 'You').expect(200);
  assert.deepEqual(listed.body.decks, []);

  await asUser(request(app).get('/api/decks/deck-demo-zanki'), 'you', 'You').expect(404);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.decks.length, 0);
  assert.equal(saved.suggestions.some((item) => item.deckId === 'deck-demo-zanki'), false);
});

test('AnkiHub-style subscriptions list visible decks with sync metadata', async () => {
  const { app } = await createTestApp();

  const response = await asUser(request(app).get('/api/decks/subscriptions'), 'you', 'You').expect(200);

  assert.equal(response.body.subscriptions.length, 1);
  assert.equal(response.body.subscriptions[0].deck.uuid, 'deck-demo-zanki');
  assert.equal(response.body.subscriptions[0].role, 'owner');
  assert.equal(response.body.subscriptions[0].pending_suggestions, 1);
  assert.equal(response.body.subscriptions[0].pendingReviewCount, 1);
  assert.equal(response.body.subscriptions[0].unresolvedConflictCount, 0);
  assert.equal(response.body.subscriptions[0].capabilities.deltaUpdates, true);
  assert.equal(response.body.subscriptions[0].capabilities.syncProof, true);
  assert.ok(response.body.subscriptions[0].lastSyncAt);
  assert.equal(response.body.subscriptions[0].deckMetadata.uuid, 'deck-demo-zanki');
  assert.equal(response.body.api.compatibility, 'ankihub-inspired');
  assert.equal(response.body.api.capabilities.mediaUploadTargets, true);
  assert.ok(response.body.api.confirmedFeatures.includes('delta-updates'));
});

test('AnkiHub-style updates return changed notes and suggestions since a checkpoint', async () => {
  const { app } = await createTestApp();

  const initial = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/updates')
    .query({ since: '1970-01-01T00:00:00.000Z' }), 'you', 'You').expect(200);

  assert.equal(initial.body.deck.uuid, 'deck-demo-zanki');
  assert.equal(initial.body.notes.length, 4);
  assert.equal(initial.body.suggestions.length, 1);
  assert.equal(initial.body.notes[0].guid, 'card-anca');
  assert.equal(initial.body.notes[0].note_type, 'Basic');
  assert.match(initial.body.notes[0].content_hash, /^[a-f0-9]{64}$/);
  assert.equal(initial.body.suggestions[0].status, 'pending');
  assert.equal(initial.body.cards.length, 4);
  assert.equal(initial.body.suggestionStatusUpdates[0].status, 'pending');
  assert.ok(Array.isArray(initial.body.media));
  assert.ok(Array.isArray(initial.body.templates));
  assert.ok(Array.isArray(initial.body.scheduling));
  assert.equal(initial.body.counts.notes, 4);
  assert.equal(initial.body.counts.cards, 4);
  assert.equal(initial.body.counts.suggestions, 1);

  const empty = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/updates')
    .query({ since: '2999-01-01T00:00:00.000Z' }), 'you', 'You').expect(200);

  assert.equal(empty.body.notes.length, 0);
  assert.equal(empty.body.suggestions.length, 0);

  const malformed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/updates')
    .query({ since: 'not-a-date' }), 'you', 'You').expect(400);
  assert.match(malformed.headers['content-type'], /^application\/problem\+json/);
  assert.equal(malformed.body.type, 'https://api.deckbridge.app/errors/invalid_since');
  assert.equal(malformed.body.title, 'Invalid Since Parameter');
  assert.equal(malformed.body.status, 400);
  assert.equal(malformed.body.code, 'invalid_since');
  assert.equal(malformed.body.details.parameter, 'since');
});

test('AnkiHub-style suggestion list, diff submit, and patch decision aliases work', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions')
    .send({
      card_guid: 'card-anca',
      diff: {
        reason: 'Use the formal antibody name.',
        proposed_fields: {
          Front: 'Microscopic polyangiitis is associated with which MPO antibody pattern?'
        },
        proposed_tags: ['Rheumatology', 'Vasculitis', 'Step2']
      }
    }), 'you', 'You').expect(201);

  const suggestion = created.body.suggestions.find((item) => item.reason === 'Use the formal antibody name.');
  assert.ok(suggestion);

  const listed = await asUser(request(app)
    .get('/api/suggestions')
    .query({ status: 'pending' }), 'you', 'You').expect(200);
  assert.ok(listed.body.suggestions.some((item) => item.id === suggestion.id));
  assert.equal(listed.body.suggestions.find((item) => item.id === suggestion.id).diff.proposed_fields.Front, 'Microscopic polyangiitis is associated with which MPO antibody pattern?');

  const deckListed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/suggestions')
    .query({ status: 'pending' }), 'you', 'You').expect(200);
  assert.ok(deckListed.body.suggestions.every((item) => item.deck_uuid === 'deck-demo-zanki'));

  const approved = await asUser(request(app)
    .patch(`/api/suggestions/${suggestion.id}`)
    .send({ status: 'approved' }), 'you', 'You').expect(200);

  assert.equal(approved.body.suggestion.status, 'approved');
  assert.equal(approved.body.state.suggestions.find((item) => item.id === suggestion.id).status, 'accepted');
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

test('deck AI settings default off and only owners can update them', async () => {
  const { app } = await createTestApp();

  const state = await asUser(request(app).get('/api/decks/deck-demo-zanki'), 'you', 'You').expect(200);
  assert.deepEqual(state.body.decks[0].aiSettings, {
    reviewBriefs: false,
    embeddings: false,
    conflictSummaries: false,
    diagnostics: false,
    qualityPulse: false,
    updatedAt: null,
    updatedBy: null
  });

  const settings = await asUser(request(app).get('/api/decks/deck-demo-zanki/ai/settings'), 'maya', 'Maya Patel').expect(200);
  assert.equal(settings.body.settings.reviewBriefs, false);
  assert.equal(settings.body.settings.embeddings, false);

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ reviewBriefs: true }), 'maya', 'Maya Patel')
    .expect(403)
    .expect((res) => {
      assert.equal(res.body.error.code, 'forbidden');
    });

  const updated = await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({
      reviewBriefs: true,
      embeddings: true,
      conflictSummaries: false,
      diagnostics: true,
      qualityPulse: true
    }), 'you', 'You').expect(200);

  assert.equal(updated.body.settings.reviewBriefs, true);
  assert.equal(updated.body.settings.embeddings, true);
  assert.equal(updated.body.settings.conflictSummaries, false);
  assert.equal(updated.body.settings.diagnostics, true);
  assert.equal(updated.body.settings.qualityPulse, true);
  assert.ok(updated.body.settings.updatedAt);
  assert.equal(updated.body.settings.updatedBy, 'you');

  const partial = await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ reviewBriefs: false }), 'you', 'You').expect(200);
  assert.equal(partial.body.settings.reviewBriefs, false);
  assert.equal(partial.body.settings.embeddings, true);
  assert.equal(partial.body.settings.diagnostics, true);
  assert.equal(partial.body.settings.qualityPulse, true);
});

test('AI artifact persistence supports list create update dismiss and stale transitions', async () => {
  const { app } = await createTestApp();
  const artifactPayload = {
    subjectType: 'suggestion',
    subjectId: 'sugg-anca',
    kind: 'review-brief',
    severity: 'medium',
    status: 'active',
    confidence: 0.82,
    model: 'test-chat-model',
    promptVersion: 'review-brief-v1',
    inputHash: 'abc123',
    payload: {
      category: 'quality-risk',
      impact: 'medium',
      risk: 'low',
      rationale: 'Test-only persisted artifact'
    }
  };

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send(artifactPayload), 'maya', 'Maya Patel')
    .expect(403)
    .expect((res) => {
      assert.equal(res.body.error.code, 'forbidden');
    });

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send(artifactPayload), 'you', 'You').expect(201);

  assert.match(created.body.artifact.id, /^ai-/);
  assert.equal(created.body.artifact.deckId, 'deck-demo-zanki');
  assert.equal(created.body.artifact.status, 'active');
  assert.equal(created.body.artifact.payload.rationale, 'Test-only persisted artifact');

  const listed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?status=active&kind=review-brief'), 'maya', 'Maya Patel').expect(200);
  assert.equal(listed.body.artifacts.length, 1);
  assert.equal(listed.body.artifacts[0].id, created.body.artifact.id);

  const accepted = await asUser(request(app)
    .patch(`/api/decks/deck-demo-zanki/ai/artifacts/${created.body.artifact.id}`)
    .send({ status: 'accepted' }), 'you', 'You').expect(200);
  assert.equal(accepted.body.artifact.status, 'accepted');
  assert.ok(accepted.body.artifact.decidedAt);
  assert.equal(accepted.body.artifact.decidedBy, 'you');

  const second = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send({ ...artifactPayload, subjectId: 'sugg-second', inputHash: 'def456' }), 'you', 'You').expect(201);

  const dismissed = await asUser(request(app)
    .post(`/api/decks/deck-demo-zanki/ai/artifacts/${second.body.artifact.id}/dismiss`), 'you', 'You').expect(200);
  assert.equal(dismissed.body.artifact.status, 'dismissed');

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send({ ...artifactPayload, subjectId: 'sugg-stale', inputHash: 'ghi789' }), 'you', 'You').expect(201);

  const stale = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts/stale')
    .send({ subjectType: 'suggestion', kind: 'review-brief' }), 'you', 'You').expect(200);
  assert.equal(stale.body.stale, 1);

  const active = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?status=active'), 'you', 'You').expect(200);
  assert.equal(active.body.artifacts.length, 0);
});

test('AI quality pulse groups active owner artifacts and excludes dismissed or stale items', async () => {
  const { app } = await createTestApp();
  const baseArtifact = {
    subjectType: 'suggestion',
    subjectId: 'sugg-anca',
    kind: 'review-brief',
    severity: 'medium',
    status: 'active',
    confidence: 0.82,
    model: 'test-chat-model',
    promptVersion: 'review-brief-v1',
    inputHash: 'pulse-1',
    payload: {
      category: 'quality-risk',
      rationale: 'Review the proposed ANCA wording before accepting.'
    }
  };

  const disabled = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/pulse'), 'you', 'You').expect(200);
  assert.equal(disabled.body.enabled, false);
  assert.equal(disabled.body.status, 'disabled');
  assert.equal(disabled.body.totalActive, 0);

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ qualityPulse: true }), 'you', 'You').expect(200);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send(baseArtifact), 'you', 'You').expect(201);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send({
      ...baseArtifact,
      subjectType: 'conflict',
      subjectId: 'conflict-ai-1',
      kind: 'conflict-summary',
      severity: 'high',
      inputHash: 'pulse-2',
      payload: { risk: 'high', summary: 'Incoming text conflicts with local edits.' }
    }), 'you', 'You').expect(201);

  const dismissed = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send({ ...baseArtifact, subjectId: 'sugg-dismissed', inputHash: 'pulse-dismissed' }), 'you', 'You').expect(201);
  await asUser(request(app)
    .post(`/api/decks/deck-demo-zanki/ai/artifacts/${dismissed.body.artifact.id}/dismiss`), 'you', 'You').expect(200);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts')
    .send({ ...baseArtifact, subjectId: 'sugg-stale', inputHash: 'pulse-stale' }), 'you', 'You').expect(201);
  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/artifacts/stale')
    .send({ subjectId: 'sugg-stale' }), 'you', 'You').expect(200);

  const pulse = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/pulse'), 'you', 'You').expect(200);
  assert.equal(pulse.body.enabled, true);
  assert.equal(pulse.body.status, 'attention');
  assert.equal(pulse.body.totalActive, 2);
  assert.equal(pulse.body.summary.bySeverity.high, 1);
  assert.equal(pulse.body.summary.bySeverity.medium, 1);
  assert.equal(pulse.body.summary.bySubjectType.suggestion, 1);
  assert.equal(pulse.body.summary.bySubjectType.conflict, 1);
  assert.equal(pulse.body.summary.byStaleness.fresh, 2);
  assert.deepEqual(pulse.body.groups.severity.map((item) => item.key), ['high', 'medium']);
  assert.equal(pulse.body.items[0].action, 'conflict');
  assert.ok(pulse.body.items.every((item) => !['sugg-dismissed', 'sugg-stale'].includes(item.subjectId)));
});

test('suggestion review brief generation is explicit, advisory, and persisted as an AI artifact', async () => {
  const calls = [];
  const { app } = await createTestApp({
    aiGateway: {
      async chatJson({ messages, validate }) {
        calls.push(messages);
        const value = {
          category: 'factual-correction',
          impact: 'medium',
          risk: 'low',
          recommendedAction: 'accept-with-care',
          rationale: 'The proposed ANCA wording is more precise while preserving the tested fact.',
          evidence: ['Existing card asks about microscopic polyangiitis.', 'Proposed answer expands MPO / myeloperoxidase.'],
          confidence: 0.84
        };
        const validation = validate(value);
        assert.equal(validation.ok, true);
        return { value, model: 'test-chat-model', raw: {} };
      }
    }
  });

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ reviewBriefs: true }), 'you', 'You').expect(200);

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/suggestions/sugg-anca/brief'), 'you', 'You').expect(201);

  assert.equal(response.body.status, 'created');
  assert.equal(response.body.artifact.subjectType, 'suggestion');
  assert.equal(response.body.artifact.subjectId, 'sugg-anca');
  assert.equal(response.body.artifact.kind, 'review-brief');
  assert.equal(response.body.artifact.status, 'active');
  assert.equal(response.body.artifact.model, 'test-chat-model');
  assert.equal(response.body.artifact.promptVersion, 'suggestion-review-brief-v1');
  assert.match(response.body.artifact.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(response.body.artifact.payload.recommendedAction, 'accept-with-care');
  assert.equal(response.body.artifact.payload.confidence, 0.84);
  assert.equal(calls.length, 1);

  const listed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?kind=review-brief&subjectType=suggestion&subjectId=sugg-anca'), 'you', 'You').expect(200);
  assert.equal(listed.body.artifacts.length, 1);
  assert.equal(listed.body.artifacts[0].id, response.body.artifact.id);

  const useful = await asUser(request(app)
    .patch(`/api/decks/deck-demo-zanki/ai/artifacts/${response.body.artifact.id}`)
    .send({ status: 'accepted' }), 'you', 'You').expect(200);
  assert.equal(useful.body.artifact.status, 'accepted');

  const state = await asUser(request(app).get('/api/decks/deck-demo-zanki'), 'you', 'You').expect(200);
  assert.equal(state.body.suggestions.find((item) => item.id === 'sugg-anca').status, 'pending');
});

test('suggestion review brief returns typed recoverable results when disabled or invalid', async () => {
  let calls = 0;
  const { app } = await createTestApp({
    aiGateway: {
      async chatJson() {
        calls += 1;
        const error = new Error('AI response failed validation');
        error.code = 'ai_validation_failed';
        throw error;
      }
    }
  });

  const disabled = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/suggestions/sugg-anca/brief'), 'you', 'You').expect(200);
  assert.equal(disabled.body.status, 'disabled');
  assert.equal(disabled.body.artifact, null);
  assert.equal(calls, 0);

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ reviewBriefs: true }), 'you', 'You').expect(200);

  const invalid = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/suggestions/sugg-anca/brief'), 'you', 'You').expect(200);
  assert.equal(invalid.body.status, 'invalid');
  assert.equal(invalid.body.code, 'ai_validation_failed');
  assert.equal(invalid.body.artifact, null);
  assert.equal(calls, 1);

  const listed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?kind=review-brief&subjectType=suggestion&subjectId=sugg-anca'), 'you', 'You').expect(200);
  assert.equal(listed.body.artifacts.length, 0);
});

test('conflict summary generation is grounded in sync conflict fields and remains advisory', async () => {
  const calls = [];
  const { app } = await createTestApp({
    aiGateway: {
      async chatJson({ messages, validate }) {
        calls.push(messages);
        const requestBody = JSON.parse(messages[1].content);
        assert.equal(requestBody.input.conflict.id, 'conflict-ai-1');
        assert.equal(requestBody.input.conflict.localFields.Back, 'Local answer');
        assert.equal(requestBody.input.conflict.incomingFields.Back, 'Incoming answer');
        const value = {
          summary: 'The incoming Back field changes the answer wording.',
          risk: 'medium',
          recommendation: 'manual-review',
          rationale: 'The recommendation is grounded in Back: local says Local answer while incoming says Incoming answer.',
          evidence: ['Back differs between localFields and incomingFields.'],
          confidence: 0.77
        };
        const validation = validate(value);
        assert.equal(validation.ok, true);
        return { value, model: 'test-chat-model', raw: {} };
      }
    }
  });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/conflicts')
    .send({
      conflicts: [{
        id: 'conflict-ai-1',
        cardId: 'card-anca',
        source: 'DeckBridge Sync test',
        localFields: { Front: 'Question', Back: 'Local answer' },
        incomingFields: { Front: 'Question', Back: 'Incoming answer' }
      }]
    }), 'you', 'You').expect(200);

  const disabled = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/conflicts/conflict-ai-1/summary'), 'you', 'You').expect(200);
  assert.equal(disabled.body.status, 'disabled');
  assert.equal(disabled.body.artifact, null);
  assert.equal(calls.length, 0);

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ conflictSummaries: true }), 'you', 'You').expect(200);

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/conflicts/conflict-ai-1/summary'), 'you', 'You').expect(201);
  assert.equal(response.body.status, 'created');
  assert.equal(response.body.artifact.subjectType, 'conflict');
  assert.equal(response.body.artifact.subjectId, 'conflict-ai-1');
  assert.equal(response.body.artifact.kind, 'conflict-summary');
  assert.equal(response.body.artifact.promptVersion, 'conflict-summary-v1');
  assert.equal(response.body.artifact.payload.recommendation, 'manual-review');
  assert.equal(response.body.artifact.payload.risk, 'medium');

  const listed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?kind=conflict-summary&subjectType=conflict&subjectId=conflict-ai-1'), 'you', 'You').expect(200);
  assert.equal(listed.body.artifacts.length, 1);

  const state = await asUser(request(app).get('/api/decks/deck-demo-zanki'), 'you', 'You').expect(200);
  assert.equal(state.body.sync.conflicts.length, 1);
});

test('setup diagnostics require structured errors and return typed recoverable results', async () => {
  let calls = 0;
  const { app } = await createTestApp({
    aiGateway: {
      async chatJson({ messages, validate }) {
        calls += 1;
        const requestBody = JSON.parse(messages[1].content);
        assert.equal(requestBody.input.error.code, 'addon_not_built');
        assert.equal(requestBody.input.error.path, '/api/addon/download');
        assert.equal(requestBody.input.error.message, 'Add-on package missing');
        const value = {
          summary: 'The add-on package download returned a build-needed error.',
          risk: 'low',
          recommendedAction: 'Build the add-on package before retrying the download.',
          rationale: 'This uses code addon_not_built on /api/addon/download with message Add-on package missing.',
          recoverySteps: ['Run the package build, then retry /api/addon/download.'],
          citedError: {
            code: 'addon_not_built',
            path: '/api/addon/download',
            message: 'Add-on package missing'
          },
          confidence: 0.86
        };
        const validation = validate(value);
        assert.equal(validation.ok, true);
        return { value, model: 'test-chat-model', raw: {} };
      }
    }
  });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/diagnostics/setup-error')
    .send({ error: { code: 'addon_not_built', path: '/api/addon/download', message: 'Add-on package missing', status: 404 } }), 'you', 'You')
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.status, 'disabled');
      assert.equal(res.body.artifact, null);
    });
  assert.equal(calls, 0);

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ diagnostics: true }), 'you', 'You').expect(200);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/diagnostics/setup-error')
    .send({ error: { code: 'missing_message', path: '/api/me' } }), 'you', 'You')
    .expect(400)
    .expect((res) => {
      assert.equal(res.body.error.code, 'invalid_setup_error_payload');
    });

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/diagnostics/setup-error')
    .send({ error: { code: 'addon_not_built', path: '/api/addon/download', message: 'Add-on package missing', status: 404 } }), 'you', 'You').expect(201);

  assert.equal(created.body.status, 'created');
  assert.equal(created.body.artifact.subjectType, 'setup-error');
  assert.equal(created.body.artifact.kind, 'diagnostic');
  assert.equal(created.body.artifact.promptVersion, 'setup-diagnostic-v1');
  assert.equal(created.body.artifact.payload.citedError.code, 'addon_not_built');
  assert.equal(created.body.artifact.payload.citedError.path, '/api/addon/download');

  const listed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?kind=diagnostic&subjectType=setup-error'), 'you', 'You').expect(200);
  assert.equal(listed.body.artifacts.length, 1);
});

test('setup diagnostics reject AI citedError mismatches without persisting artifacts', async () => {
  const { app } = await createTestApp({
    aiGateway: {
      async chatJson({ validate }) {
        const value = {
          summary: 'The setup request failed.',
          risk: 'low',
          recommendedAction: 'Retry the submitted endpoint after checking the setup.',
          rationale: 'This cites a different path than the submitted setup error.',
          recoverySteps: ['Retry after reviewing the submitted error.'],
          citedError: {
            code: 'addon_not_built',
            path: '/api/wrong-endpoint',
            message: 'Add-on package missing'
          },
          confidence: 0.72
        };
        const validation = validate(value);
        assert.equal(validation.ok, false);
        assert.match(validation.message, /citedError\.path/);
        const error = new Error(validation.message);
        error.code = 'ai_validation_failed';
        throw error;
      }
    }
  });

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ diagnostics: true }), 'you', 'You').expect(200);

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/diagnostics/setup-error')
    .send({ error: { code: 'addon_not_built', path: '/api/addon/download', message: 'Add-on package missing', status: 404 } }), 'you', 'You').expect(200);
  assert.equal(response.body.status, 'invalid');
  assert.equal(response.body.code, 'ai_validation_failed');
  assert.match(response.body.message, /citedError\.path/);
  assert.equal(response.body.artifact, null);

  const artifacts = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?kind=diagnostic&subjectType=setup-error'), 'you', 'You').expect(200);
  assert.equal(artifacts.body.artifacts.length, 0);
});

test('setup diagnostics report unavailable AI gateway errors without persisting artifacts', async () => {
  const { app } = await createTestApp({
    aiGateway: {
      async chatJson() {
        const error = new Error('9Router is unreachable.');
        error.code = 'ai_provider_unavailable';
        throw error;
      }
    }
  });

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ diagnostics: true }), 'you', 'You').expect(200);

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/diagnostics/setup-error')
    .send({ error: { code: 'sync_failed', path: '/api/decks/deck-demo-zanki/sync/cards', message: 'Invalid sync payload' } }), 'you', 'You').expect(200);
  assert.equal(response.body.status, 'unavailable');
  assert.equal(response.body.code, 'ai_provider_unavailable');
  assert.equal(response.body.message, '9Router is unreachable.');
  assert.equal(response.body.artifact, null);

  const artifacts = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?kind=diagnostic&subjectType=setup-error'), 'you', 'You').expect(200);
  assert.equal(artifacts.body.artifacts.length, 0);
});

test('conflict summaries and diagnostics return invalid results without persisting bad AI output', async () => {
  const { app } = await createTestApp({
    aiGateway: {
      async chatJson() {
        const error = new Error('AI response failed validation');
        error.code = 'ai_validation_failed';
        throw error;
      }
    }
  });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/conflicts')
    .send({
      conflicts: [{
        id: 'conflict-invalid-ai',
        cardId: 'card-anca',
        localFields: { Front: 'Local' },
        incomingFields: { Front: 'Incoming' }
      }]
    }), 'you', 'You').expect(200);
  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ conflictSummaries: true, diagnostics: true }), 'you', 'You').expect(200);

  const conflict = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/conflicts/conflict-invalid-ai/summary'), 'you', 'You').expect(200);
  assert.equal(conflict.body.status, 'invalid');
  assert.equal(conflict.body.artifact, null);

  const diagnostic = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/diagnostics/setup-error')
    .send({ error: { code: 'sync_failed', path: '/api/decks/deck-demo-zanki/sync/cards', message: 'Invalid sync payload' } }), 'you', 'You').expect(200);
  assert.equal(diagnostic.body.status, 'invalid');
  assert.equal(diagnostic.body.artifact, null);

  const artifacts = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?status=active'), 'you', 'You').expect(200);
  assert.equal(artifacts.body.artifacts.length, 0);
});

test('semantic duplicate indexing is explicit, stores links, and remains advisory', async () => {
  let embedCalls = 0;
  const { app } = await createTestApp({
    aiGateway: {
      async embed(input) {
        embedCalls += 1;
        const text = Array.isArray(input) ? input[0] : input;
        const embedding = text.includes('H. pylori')
          ? [0.96, 0.04, 0]
          : text.includes('Vitamin B12')
            ? [0, 1, 0]
            : text.includes('ADH')
              ? [0, 0.2, 0.8]
              : [1, 0, 0];
        return {
          model: 'test-embedding-model',
          dimensions: embedding.length,
          embeddings: [embedding],
          inputCount: 1
        };
      }
    }
  });

  const disabled = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/cards/card-anca/embed'), 'you', 'You').expect(200);
  assert.equal(disabled.body.status, 'disabled');
  assert.equal(disabled.body.embedding, null);
  assert.equal(embedCalls, 0);

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ embeddings: true }), 'you', 'You').expect(200);

  const batch = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/cards/embed')
    .send({ cardIds: ['card-anca', 'card-hpylori'], minScore: 0.7 }), 'you', 'You').expect(201);
  assert.equal(batch.body.status, 'indexed');
  assert.equal(batch.body.indexed, 2);
  assert.equal(embedCalls, 2);

  const related = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/cards/card-anca/related?minScore=0.7'), 'you', 'You').expect(200);
  assert.equal(related.body.status, 'ready');
  assert.equal(related.body.links.length, 1);
  assert.equal(related.body.links[0].sourceCardId, 'card-hpylori');
  assert.equal(related.body.links[0].targetCardId, 'card-anca');
  assert.equal(related.body.links[0].relationship, 'duplicate');
  assert.match(related.body.links[0].rationale, /card-hpylori|H\. pylori|card-anca/);
  assert.deepEqual(related.body.links[0].comparedFields, ['Front', 'Back']);

  const artifacts = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/artifacts?kind=duplicate-link&subjectType=card'), 'you', 'You').expect(200);
  assert.equal(artifacts.body.artifacts.length, 1);
  assert.equal(artifacts.body.artifacts[0].payload.targetCardId, 'card-anca');

  const state = await asUser(request(app).get('/api/decks/deck-demo-zanki'), 'you', 'You').expect(200);
  assert.equal(state.body.decks[0].cards.length, 4);
  assert.ok(state.body.decks[0].cards.some((card) => card.id === 'card-hpylori'));
});

test('semantic duplicate query marks changed card embeddings stale', async () => {
  const { app } = await createTestApp({
    aiGateway: {
      async embed(input) {
        const text = Array.isArray(input) ? input[0] : input;
        const embedding = text.includes('H. pylori') ? [0.95, 0.05] : [1, 0];
        return { model: 'test-embedding-model', dimensions: 2, embeddings: [embedding], inputCount: 1 };
      }
    }
  });

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ embeddings: true }), 'you', 'You').expect(200);
  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/cards/embed')
    .send({ cardIds: ['card-anca', 'card-hpylori'], minScore: 0.7 }), 'you', 'You').expect(201);

  await asUser(request(app)
    .post('/api/suggestions/sugg-anca/decision')
    .send({ decision: 'accepted' }), 'you', 'You').expect(200);

  const related = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/ai/cards/card-anca/related?minScore=0.7'), 'you', 'You').expect(200);
  assert.equal(related.body.links.length, 0);
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

test('suggestion comment API rejects non-members, non-reviewer resolution, missing comments, replies, and invalid parents', async () => {
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

  const topLevel = await asUser(request(app)
    .post('/api/suggestions/sugg-anca/comments')
    .send({ body: 'Thread to resolve' }), 'maya', 'Maya Patel').expect(201);

  await asUser(request(app)
    .patch(`/api/suggestions/sugg-anca/comments/${topLevel.body.id}/resolved`)
    .send({ resolved: true }), 'maya', 'Maya Patel')
    .expect(403)
    .expect((res) => {
      assert.equal(res.body.error.code, 'forbidden');
    });

  const reply = await asUser(request(app)
    .post('/api/suggestions/sugg-anca/comments')
    .send({ body: 'Reply should not be resolvable', parentId: topLevel.body.id }), 'maya', 'Maya Patel').expect(201);

  await asUser(request(app)
    .patch(`/api/suggestions/sugg-anca/comments/${reply.body.id}/resolved`)
    .send({ resolved: true }), 'you', 'You')
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
  assert.equal(created.body.result.proof.client.version, '0.1.0');
  assert.equal(created.body.result.proof.stats.created, 1);
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

  const lightweight = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      returnState: false,
      conflictPolicy: 'overwrite-platform',
      source: 'DeckBridge Sync lightweight response',
      cards: [{
        id: 'anki-9002',
        ankiNoteId: 9002,
        fields: { Front: 'Large-note sync should not echo deck state', Back: 'Only return the sync result.' }
      }]
    }), 'you', 'You').expect(200);

  assert.equal(lightweight.body.result.stats.created, 1);
  assert.equal('state' in lightweight.body, false);

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
  assert.equal(batch.body.result.proof.batch.complete, true);

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

test('Anki add-on sync endpoint rejects oversized card sync requests before repository work', async () => {
  let called = false;
  const { app } = await createTestApp({
    repository: {
      async syncCardsFromAddon() {
        called = true;
        throw new Error('repository should not receive oversized sync card payloads');
      }
    }
  });

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      source: 'DeckBridge Sync oversized request',
      cards: [{
        id: 'anki-oversized',
        ankiNoteId: 9999,
        fields: { Front: 'A'.repeat(1_600_000), Back: 'oversized' }
      }]
    }), 'you', 'You').expect(413);

  assert.equal(response.body.error.code, 'sync_cards_request_too_large');
  assert.equal(called, false);
});

test('Anki add-on sync rejects invalid payloads with RFC 7807 details', async () => {
  const { app } = await createTestApp();

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({ returnState: false, cards: [] }), 'you', 'You')
    .expect(400);

  assert.match(response.headers['content-type'], /^application\/problem\+json/);
  assert.equal(response.body.type, 'https://api.deckbridge.app/errors/invalid_sync_payload');
  assert.equal(response.body.title, 'Invalid Sync Payload');
  assert.equal(response.body.status, 400);
  assert.equal(response.body.code, 'invalid_sync_payload');
  assert.equal(response.body.details.endpoint, 'sync_cards');
  assert.equal(response.body.error.code, 'invalid_sync_payload');
});

test('Anki add-on sync preserves full decoded compressed field content', async () => {
  const { app } = await createTestApp();
  const fullBack = `High-yield explanation\n${Array.from({ length: 600 }, (_, index) => `preserved-content-${index}`).join('|')}`;
  const compressed = deflateSync(Buffer.from(fullBack, 'utf8'));

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      source: 'DeckBridge Sync compressed test',
      cards: [{
        id: 'anki-compressed-1',
        ankiNoteId: 9910,
        fieldOrder: ['Front', 'Back'],
        fields: { Front: 'Compressed payload card?' },
        compressedFields: {
          Back: {
            encoding: 'zlib+base64',
            data: compressed.toString('base64'),
            originalBytes: Buffer.byteLength(fullBack, 'utf8'),
            sha256: sha256(Buffer.from(fullBack, 'utf8'))
          }
        }
      }]
    }), 'you', 'You').expect(200);

  const card = response.body.state.decks[0].cards.find((item) => item.id === 'anki-compressed-1');
  assert.equal(card.fields.Back, fullBack);
  assert.equal(card.fields.Back.length, fullBack.length);
  assert.equal(response.body.result.proof.stats.created, 1);
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
  assert.equal(synced.body.result.stats.mediaReceived, 1);
  assert.equal(synced.body.result.proof.stats.mediaReceived, 1);
  assert.equal(synced.body.result.proof.mediaReceived, 1);

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

test('large media upload targets return signed storage metadata', async () => {
  const upload = {
    filename: 'large.png',
    mimeType: 'image/png',
    sha256: 'd'.repeat(64),
    sizeBytes: 12_000_000,
    storageBucket: 'deckbridge-media',
    storagePath: `deck-demo-zanki/${'d'.repeat(64)}/large.png`,
    uploadUrl: 'https://storage.example/upload/sign/large.png?token=signed',
    expiresAt: new Date(Date.now() + 7200_000).toISOString()
  };
  const repository = {
    async createMediaUploadTargets(_user, deckId, files) {
      assert.equal(deckId, 'deck-demo-zanki');
      assert.deepEqual(files, [{
        filename: 'large.png',
        mimeType: 'image/png',
        sha256: 'd'.repeat(64),
        sizeBytes: 12_000_000
      }]);
      return [upload];
    }
  };
  const { app } = await createTestApp({ repository });

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/media/uploads')
    .send({ files: [{ filename: 'large.png', mimeType: 'image/png', sha256: 'd'.repeat(64), sizeBytes: 12_000_000 }] }), 'you', 'You')
    .expect(201);

  assert.deepEqual(response.body.uploads, [upload]);
  assert.equal(response.body.uploads[0].uploadUrl, upload.uploadUrl);
  assert.equal(response.body.uploads[0].storageBucket, 'deckbridge-media');
  assert.equal(response.body.uploads[0].storagePath, `deck-demo-zanki/${'d'.repeat(64)}/large.png`);
});

test('large media upload target requests are bounded before signing', async () => {
  const repository = {
    async createMediaUploadTargets() {
      throw new Error('should not create upload targets for oversized target batches');
    }
  };
  const { app } = await createTestApp({ repository });
  const files = Array.from({ length: 76 }, (_, index) => ({
    filename: `large-${index}.png`,
    mimeType: 'image/png',
    sha256: `${index + 1}`.padStart(64, 'a').slice(-64),
    sizeBytes: 12_000_000
  }));

  const response = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/media/uploads')
    .send({ files }), 'you', 'You')
    .expect(413);

  assert.equal(response.body.error.code, 'too_many_media_upload_targets');
  assert.match(response.body.error.message, /75 media upload targets/);
});

test('OpenAPI documents sync result fields and supported suggestion diff limits', async () => {
  const openapi = await fs.readFile(path.resolve(process.cwd(), 'openapi.yaml'), 'utf8');
  const addonSyncResult = openapi.slice(
    openapi.indexOf('    AddonSyncResult:'),
    openapi.indexOf('    # ─── Comments', openapi.indexOf('    AddonSyncResult:'))
  );
  const createSuggestion = openapi.slice(
    openapi.indexOf('  /api/decks/{deckId}/suggestions:'),
    openapi.indexOf('  /api/decks/{deckId}/suggestions/bulk-decision:')
  );

  for (const token of ['proof:', 'conflicts:', 'mediaReceived:', 'stats:', 'batch:']) {
    assert.ok(addonSyncResult.includes(token), `AddonSyncResult must document ${token}`);
  }
  assert.ok(createSuggestion.includes('Only field and tag'));
  assert.ok(createSuggestion.includes('diffs are accepted in this slice;'));
  assert.ok(openapi.includes('invalid_sync_payload'));
  assert.ok(openapi.includes('details:'));
});

test('storage-backed media route redirects through authenticated signed download', async () => {
  const asset = {
    filename: 'large.png',
    mimeType: 'image/png',
    sha256: 'd'.repeat(64),
    sizeBytes: 12_000_000,
    storageBucket: 'deckbridge-media',
    storagePath: `deck-demo-zanki/${'d'.repeat(64)}/large.png`
  };
  const repository = {
    async getDeckState(_user, deckId) {
      assert.equal(deckId, 'deck-demo-zanki');
      return { decks: [{ id: deckId, media: { 'large.png': asset } }] };
    },
    async createMediaDownload(_user, deckId, mediaAsset) {
      assert.equal(deckId, 'deck-demo-zanki');
      assert.deepEqual(mediaAsset, asset);
      return { url: 'https://storage.example/signed/large.png' };
    }
  };
  const { app } = await createTestApp({ repository });

  const response = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/media/large.png'), 'you', 'You')
    .expect(302);

  assert.equal(response.headers.location, 'https://storage.example/signed/large.png');
});

test('storage-backed media route falls back to managed file rows', async () => {
  const asset = {
    filename: 'large.png',
    mimeType: 'image/png',
    sha256: 'd'.repeat(64),
    sizeBytes: 12_000_000,
    storageBucket: 'deckbridge-media',
    storagePath: `deck-demo-zanki/${'d'.repeat(64)}/large.png`
  };
  const repository = {
    async getDeckState(_user, deckId) {
      assert.equal(deckId, 'deck-demo-zanki');
      return { decks: [{ id: deckId, media: {} }] };
    },
    async getManagedMediaAsset(_user, deckId, filename) {
      assert.equal(deckId, 'deck-demo-zanki');
      assert.equal(filename, 'large.png');
      return asset;
    },
    async createMediaDownload(_user, deckId, mediaAsset) {
      assert.equal(deckId, 'deck-demo-zanki');
      assert.deepEqual(mediaAsset, asset);
      return { url: 'https://storage.example/signed/large.png' };
    }
  };
  const { app } = await createTestApp({ repository });

  const response = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/media/large.png'), 'you', 'You')
    .expect(302);

  assert.equal(response.headers.location, 'https://storage.example/signed/large.png');
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

test('Anki add-on first push can create a deck without echoing full state', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/decks/sync/from-anki')
    .send({
      returnState: false,
      deckName: 'Large Neuro Boards',
      source: 'DeckBridge Sync lightweight create',
      cards: [{
        id: 'anki-778',
        ankiNoteId: 778,
        type: 'Cloze',
        modelName: 'Cloze',
        fieldOrder: ['Text', 'Extra'],
        fields: { Text: '{{c1::Milrinone}} can support vasospasm rescue.', Extra: 'Keep the first-push response small.' },
        tags: ['NeuroICU'],
        state: 'Review',
        suspended: false,
        sourceDeckName: 'Large Neuro Boards'
      }]
    }), 'new-user', 'New User').expect(201);

  assert.equal(created.body.deck.name, 'Large Neuro Boards');
  assert.equal(created.body.result.stats.created, 1);
  assert.equal('state' in created.body, false);
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

test('study progress API batches Supabase upserts', async () => {
  const { app, supabase } = await createTokenTestApp();
  supabase.tables.study_progress = [{
    id: 'existing-progress',
    user_id: 'you',
    deck_id: 'deck-demo-zanki',
    card_id: 'card-1',
    interval_days: 1,
    ease_factor: 2.5,
    repetitions: 0,
    next_due: '2026-05-11T00:00:00.000Z',
    last_rating: null,
    updated_at: '2026-05-11T00:00:00.000Z'
  }];

  const response = await asUser(request(app)
    .post('/api/study/progress')
    .send({
      updates: [
        {
          deckId: 'deck-demo-zanki',
          cardId: 'card-1',
          intervalDays: 5,
          easeFactor: 2.8,
          repetitions: 2,
          nextDue: '2026-05-16T00:00:00.000Z',
          lastRating: 4
        },
        {
          deckId: 'deck-demo-zanki',
          cardId: 'card-2',
          intervalDays: 1,
          easeFactor: 2.5,
          repetitions: 1,
          nextDue: '2026-05-12T00:00:00.000Z',
          lastRating: 3
        }
      ]
    }), 'you', 'You').expect(200);

  assert.equal(response.body.synced, 2);
  assert.deepEqual(
    supabase.calls.filter((call) => call.table === 'study_progress' && call.operation === 'upsert').map((call) => call.rowCount),
    [2]
  );
  assert.equal(supabase.tables.study_progress.length, 2);
  const updated = supabase.tables.study_progress.find((row) => row.card_id === 'card-1');
  assert.equal(updated.interval_days, 5);
  assert.equal(updated.last_rating, 4);
});

test('spreadsheet import creates one pending suggestion per changed row', async () => {
  const { app } = await createTestApp();

  const csv = [
    'Card ID,Note Type,State,Tags,Front,Back',
    '"card-hpylori","Basic (and reverse)","Learning","GI; Step2; Updated","First-line treatment for H. pylori infection?","Bismuth quadruple therapy plus local resistance review."',
    '"card-anca","Basic","Learning","Rheumatology; Step2","Microscopic polyangiitis is most strongly associated with which autoantibody?","p-ANCA (myeloperoxidase)"'
  ].join('\n');

  const imported = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/import')
    .send({ filename: 'deck.csv', content: csv }), 'maya', 'Maya Patel')
    .expect(201);

  assert.equal(imported.body.imported, 1);
  assert.equal(imported.body.skipped.length, 1);
  const suggestion = imported.body.state.suggestions.find((item) => item.cardId === 'card-hpylori');
  assert.equal(suggestion.status, 'pending');
  assert.equal(suggestion.proposedFields.Back, 'Bismuth quadruple therapy plus local resistance review.');
  assert.deepEqual(suggestion.proposedTags, ['GI', 'Step2', 'Updated']);
});

test('owner can update model templates and CSS for matching cards', async () => {
  const { app } = await createTestApp();

  const updated = await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/models/Basic/template')
    .send({
      templateFront: '<section>{{Front}}</section>',
      templateBack: '{{FrontSide}}<hr>{{Back}}',
      modelCss: '.card { font-size: 22px; }'
    }), 'you', 'You')
    .expect(200);

  const card = updated.body.decks[0].cards.find((item) => item.id === 'card-anca');
  assert.equal(card.templateFront, '<section>{{Front}}</section>');
  assert.equal(card.templateBack, '{{FrontSide}}<hr>{{Back}}');
  assert.equal(card.modelCss, '.card { font-size: 22px; }');

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/models/Basic/template')
    .send({ templateFront: '{{Front}}', templateBack: '{{Back}}', modelCss: '' }), 'maya', 'Maya Patel')
    .expect(403);
});

test('scheduling sync endpoint returns web study progress mapped to Anki note ids', async () => {
  const { app, supabase } = await createTokenTestApp();

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      cards: [{
        id: 'anki-srs-1',
        ankiNoteId: 4242,
        type: 'Basic',
        modelName: 'Basic',
        fieldOrder: ['Front', 'Back'],
        fields: { Front: 'SRS front', Back: 'SRS back' },
        tags: ['SRS'],
        state: 'Review',
        suspended: false
      }]
    }), 'you', 'You').expect(200);

  supabase.tables.study_progress = [{
    id: 'progress-1',
    user_id: 'you',
    deck_id: 'deck-demo-zanki',
    card_id: 'anki-srs-1',
    interval_days: 9,
    ease_factor: 2.7,
    repetitions: 4,
    next_due: '2026-05-18T00:00:00.000Z',
    last_rating: 4,
    updated_at: '2026-05-08T15:00:00.000Z'
  }];

  const scheduling = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/sync/scheduling'), 'you', 'You')
    .expect(200);

  assert.equal(scheduling.body.updates.length, 1);
  assert.equal(scheduling.body.updates[0].ankiNoteId, 4242);
  assert.equal(scheduling.body.updates[0].intervalDays, 9);
  assert.equal(scheduling.body.updates[0].easeFactor, 2.7);
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

test('card version history: create, list metadata, get snapshot', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/card-anca/versions'), 'you', 'You')
    .expect(200);
  assert.ok(created.body.id);
  assert.equal(created.body.cardId, 'card-anca');
  assert.equal(created.body.deckId, 'deck-demo-zanki');
  assert.ok(created.body.snapshot);
  assert.deepEqual(created.body.snapshot.fields, {
    Front: 'Microscopic polyangiitis is most strongly associated with which autoantibody?',
    Back: 'p-ANCA (myeloperoxidase)'
  });
  assert.deepEqual(created.body.snapshot.tags, ['Rheumatology', 'Step2']);

  const listed = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/cards/card-anca/versions'), 'you', 'You')
    .expect(200);
  assert.ok(listed.body.versions.length >= 1);
  assert.equal(listed.body.versions[0].id, created.body.id);
  assert.equal(listed.body.versions[0].createdBy, 'You');
  assert.ok(listed.body.versions[0].createdAt);

  const got = await asUser(request(app)
    .get(`/api/decks/deck-demo-zanki/cards/card-anca/versions/${created.body.id}`), 'you', 'You')
    .expect(200);
  assert.ok(got.body.version.snapshot);
  assert.deepEqual(got.body.version.snapshot.fields, created.body.snapshot.fields);
});

test('auto-versioning on suggestion accept creates a card version', async () => {
  const { app } = await createTestApp();

  const stateBefore = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki'), 'you', 'You')
    .expect(200);
  const versionsBefore = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/cards/card-anca/versions'), 'you', 'You')
    .expect(200);
  const countBefore = versionsBefore.body.versions.length;

  await asUser(request(app)
    .post('/api/suggestions/sugg-anca/decision')
    .send({ decision: 'accepted' }), 'you', 'You')
    .expect(200);

  const versionsAfter = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/cards/card-anca/versions'), 'you', 'You')
    .expect(200);
  assert.equal(versionsAfter.body.versions.length, countBefore + 1);
  const version = versionsAfter.body.versions[0];
  assert.ok(version.id);
  assert.equal(version.createdBy, 'You');
});

test('rollback restores card fields and creates prior snapshot', async () => {
  const { app } = await createTestApp();

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/card-hpylori/versions'), 'you', 'You')
    .expect(200);
  const originalSnapshot = created.body.snapshot;

  const stateBefore = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki'), 'you', 'You')
    .expect(200);
  const cardBefore = stateBefore.body.decks[0].cards.find((c) => c.id === 'card-hpylori');

  const rollback = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/card-hpylori/rollback')
    .query({ version: created.body.id }), 'you', 'You')
    .expect(200);
  assert.ok(rollback.body.card);
  assert.ok(rollback.body.priorVersion);
  assert.ok(rollback.body.priorVersion.id);

  const stateAfter = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki'), 'you', 'You')
    .expect(200);
  const cardAfter = stateAfter.body.decks[0].cards.find((c) => c.id === 'card-hpylori');
  assert.deepEqual(cardAfter.fields, cardBefore.fields);
  assert.deepEqual(cardAfter.tags, cardBefore.tags);
});

test('non-editor receives 403 on rollback', async () => {
  const { app, dataDir } = await createTestApp();
  await seedLocalState(dataDir, (state) => {
    state.collaborators.find((p) => p.id === 'maya').role = 'contributor';
  });

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/card-anca/versions'), 'maya', 'Maya Patel')
    .expect(200);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/card-anca/rollback')
    .query({ version: 'dummy' }), 'maya', 'Maya Patel')
    .expect(403);
});

test('card modified after version receives 409 on rollback', async () => {
  const { app, dataDir } = await createTestApp();
  await seedLocalState(dataDir, (state) => {
    const card = state.decks[0].cards.find((c) => c.id === 'card-anca');
    card.modifiedAt = new Date(Date.now() + 86400000).toISOString();
  });

  const created = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/card-anca/versions'), 'you', 'You')
    .expect(200);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/card-anca/rollback')
    .query({ version: created.body.id }), 'you', 'You')
    .expect(409);
});

test('find similar cards returns results sorted by score descending', async () => {
  const { app } = await createTestApp({
    aiGateway: {
      async embed(input) {
        const text = Array.isArray(input) ? input[0] : input;
        const embedding = text.includes('H. pylori')
          ? [0.96, 0.04, 0]
          : text.includes('Vitamin B12')
            ? [0, 1, 0]
            : text.includes('ADH')
              ? [0, 0.2, 0.8]
              : [1, 0, 0];
        return { model: 'test-embedding-model', dimensions: 3, embeddings: [embedding], inputCount: 1 };
      }
    }
  });

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ embeddings: true }), 'you', 'You').expect(200);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/cards/embed')
    .send({ cardIds: ['card-anca', 'card-hpylori', 'card-b12', 'card-endo'] }), 'you', 'You').expect(201);

  const result = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/similar')
    .send({ cardId: 'card-anca', topK: 5, threshold: 0.1 }), 'you', 'You').expect(200);

  assert.ok(Array.isArray(result.body.similar));
  assert.ok(result.body.similar.length > 0);
  for (let i = 1; i < result.body.similar.length; i++) {
    assert.ok(result.body.similar[i - 1].score >= result.body.similar[i].score);
  }
  assert.ok(result.body.similar.every((item) => item.card && typeof item.score === 'number'));
});

test('find similar cards returns empty results when no embeddings exist', async () => {
  const { app } = await createTestApp();

  const result = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/similar')
    .send({ cardId: 'card-anca', topK: 5, threshold: 0.7 }), 'you', 'You').expect(200);

  assert.deepEqual(result.body, { similar: [] });
});

test('find similar cards threshold filtering works', async () => {
  const { app } = await createTestApp({
    aiGateway: {
      async embed(input) {
        const text = Array.isArray(input) ? input[0] : input;
        const embedding = text.includes('H. pylori')
          ? [0.96, 0.04, 0]
          : text.includes('Vitamin B12')
            ? [0, 1, 0]
            : [1, 0, 0];
        return { model: 'test-embedding-model', dimensions: 3, embeddings: [embedding], inputCount: 1 };
      }
    }
  });

  await asUser(request(app)
    .patch('/api/decks/deck-demo-zanki/ai/settings')
    .send({ embeddings: true }), 'you', 'You').expect(200);

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/ai/cards/embed')
    .send({ cardIds: ['card-anca', 'card-hpylori', 'card-b12'] }), 'you', 'You').expect(201);

  const permissive = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/similar')
    .send({ cardId: 'card-anca', topK: 5, threshold: 0.1 }), 'you', 'You').expect(200);
  assert.ok(permissive.body.similar.length > 0, 'should return results with low threshold');

  const strict = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/cards/similar')
    .send({ cardId: 'card-anca', topK: 5, threshold: 1.0 }), 'you', 'You').expect(200);
  assert.equal(strict.body.similar.length, 0, 'threshold of 1.0 should filter all results');
});

test('cursor pagination for cards returns non-overlapping pages', async () => {
  const { app } = await createTestApp();

  const page1 = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/cards')
    .query({ limit: 3 }), 'you', 'You')
    .expect(200);

  assert.equal(page1.body.cards.length, 3);
  assert.ok(page1.body.nextCursor, 'should have a next cursor');

  const page2 = await asUser(request(app)
    .get('/api/decks/deck-demo-zanki/cards')
    .query({ limit: 3, cursor: page1.body.nextCursor }), 'you', 'You')
    .expect(200);

  assert.ok(page2.body.cards.length > 0, 'page 2 should have cards');
  const page1Ids = new Set(page1.body.cards.map((c) => c.id));
  const overlap = page2.body.cards.filter((c) => page1Ids.has(c.id));
  assert.equal(overlap.length, 0, 'no overlapping card IDs between pages');
  assert.equal(page2.body.nextCursor, null, 'last page has no next cursor');
});
