import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRole, requireOwner, requireEditor, requireContributor, requireReviewer } from './rbac.mjs';

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; }
  };
  return res;
}

test('requireRole skips when supabase is null (dev mode)', async () => {
  const middleware = requireRole(null, 'owner');
  const req = { params: {}, body: {}, query: {}, user: { id: 'test' } };
  const res = mockRes();
  let nextArg = 'NOT_CALLED';
  await middleware(req, res, (err) => { nextArg = err; });
  assert.equal(nextArg, undefined);
});

test('requireRole calls next with 400 error when no deckId found', async () => {
  const middleware = requireRole({}, 'owner');
  const req = { params: {}, body: {}, query: {}, user: { id: 'test' } };
  const res = mockRes();
  let nextArg = null;
  await middleware(req, res, (err) => { nextArg = err; });
  assert.ok(nextArg);
  assert.equal(nextArg.status, 400);
  assert.equal(nextArg.code, 'missing_deck_id');
});

test('requireRole calls next with 403 error when user is not a member', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: null })
          })
        })
      })
    })
  };
  const middleware = requireRole(supabase, 'owner');
  const req = { params: { deckId: 'deck-1' }, body: {}, query: {}, user: { id: 'test' } };
  const res = mockRes();
  let nextArg = null;
  await middleware(req, res, (err) => { nextArg = err; });
  assert.ok(nextArg);
  assert.equal(nextArg.status, 403);
  assert.equal(nextArg.code, 'forbidden');
});

test('requireRole calls next without error when role matches', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: { role: 'owner' }, error: null })
          })
        })
      })
    })
  };
  const middleware = requireRole(supabase, 'owner');
  const req = { params: { deckId: 'deck-1' }, body: {}, query: {}, user: { id: 'test' } };
  const res = mockRes();
  let nextArg = 'NOT_CALLED';
  await middleware(req, res, (err) => { nextArg = err; });
  assert.equal(nextArg, undefined);
  assert.equal(req.deckRole, 'owner');
});

test('requireRole calls next with 403 error when role not in allowed list', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: { role: 'viewer' }, error: null })
          })
        })
      })
    })
  };
  const middleware = requireRole(supabase, 'owner', 'editor');
  const req = { params: { deckId: 'deck-1' }, body: {}, query: {}, user: { id: 'test' } };
  const res = mockRes();
  let nextArg = null;
  await middleware(req, res, (err) => { nextArg = err; });
  assert.ok(nextArg);
  assert.equal(nextArg.status, 403);
});

test('requireEditor allows owner role', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: { role: 'owner' }, error: null })
          })
        })
      })
    })
  };
  const middleware = requireEditor(supabase);
  const req = { params: { deckId: 'deck-1' }, body: {}, query: {}, user: { id: 'test' } };
  const res = mockRes();
  let nextArg = 'NOT_CALLED';
  await middleware(req, res, (err) => { nextArg = err; });
  assert.equal(nextArg, undefined);
});

test('requireContributor allows reviewer role', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: { role: 'reviewer' }, error: null })
          })
        })
      })
    })
  };
  const middleware = requireContributor(supabase);
  const req = { params: { deckId: 'deck-1' }, body: {}, query: {}, user: { id: 'test' } };
  const res = mockRes();
  let nextArg = 'NOT_CALLED';
  await middleware(req, res, (err) => { nextArg = err; });
  assert.equal(nextArg, undefined);
  assert.equal(req.deckRole, 'reviewer');
});
