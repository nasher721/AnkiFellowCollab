# DeckBridge Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the recommended DeckBridge security, collaboration, study, media, maintainability, accessibility, and mobile improvements in small verified commits.

**Architecture:** Keep the existing Express `createApp()` plus repository abstraction intact. Add route-edge validation and rate limiting in `server/app.mjs`, shared pure helpers in focused server/domain files, repository methods only where persistent state must change, and frontend improvements as small React components adjacent to existing views. The large feature areas are intentionally sequenced so security can merge first, then daily workflow UX, then heavier media and refactor work.

**Tech Stack:** Node.js ESM, Express 5, `node:test`, Supertest, Supabase repository, Vite, React 19, TypeScript, Vitest, Python unittest for the Anki add-on, macOS zsh.

---

## Scope Check

The recommendation list spans independent subsystems: backend security, rate limiting, reviewer workflow, Anki add-on media sync, study UI, comments, conflict resolution, component extraction, frontend test infrastructure, accessibility, and responsive CSS. Execute this as a sequence of small commits. If execution needs PR splitting, use these boundaries:

1. Security and rate limiting: Tasks 1-3.
2. Collaboration workflow: Tasks 4, 7, 8.
3. Study workflow: Tasks 6 and 10.
4. Media sync: Task 5.
5. Maintainability and accessibility: Tasks 9, 11, 12.

## Current Repo Notes

- `server/app.mjs` already has invite email validation and a 60-second analytics cache; this plan keeps them and adds tests/hardening so they remain protected.
- `src/StudyView.tsx` already has a progress bar and a post-session rating breakdown; this plan adds the missing fraction label, skip action, session persistence, and responsive polish.
- `src/App.tsx` currently defines `StudyPrepView`, `DeckStatsView`, and `DeckSettingsView` inline after the main `App` component.
- `addons/deckbridge_sync/__init__.py` syncs note fields/tags but does not collect media bytes.
- Existing backend tests run with `npm test`. Frontend unit tests are not configured yet.

## File Structure

- Create `server/security.mjs`: password hashing, email validation, role validation, deck ID validation.
- Create `server/security.test.mjs`: pure tests for `server/security.mjs`.
- Create `server/rateLimits.mjs`: Express rate limiter factory with test overrides.
- Modify `server/app.mjs`: wire validators, rate limiters, bulk suggestion route, notification pagination, media route, session validation, study-session persistence, and comment-resolution route.
- Modify `server/domain.mjs`: normalize sync media payloads and merge deck media during add-on sync.
- Modify `server/domain.test.mjs` and `server/domain-extra.test.mjs`: lock media and SM-2-adjacent domain behavior.
- Modify `server/routes.api.test.mjs`: route coverage for security validation, rate limits, bulk decisions, media retrieval, paginated notifications, resolved comments, and study sessions.
- Modify `server/repositories/localRepository.mjs`: bulk suggestion decisions, comment-thread state for local fallback if needed, and media merge support.
- Modify `server/repositories/supabaseRepository.mjs`: bulk suggestion decisions and media merge persistence.
- Create `supabase/migrations/20260507120000_comment_resolution.sql`: resolved/unresolved comment thread columns.
- Modify `addons/deckbridge_sync/__init__.py`: collect media references and base64 media payloads.
- Modify `addons/deckbridge_sync/tests/test_addon.py`: media sync payload tests.
- Modify `package.json` and `vite.config.ts`: add Vitest script/config.
- Create `src/sm2.test.ts`: frontend unit tests for SM-2.
- Create `src/media.ts`: convert synced media references into platform URLs for study/card rendering.
- Modify `src/api.ts`: bulk suggestions, paginated notifications, study sessions.
- Modify `src/types.ts`: session role type, comment resolution fields, media type.
- Modify `src/App.tsx`: use extracted views, suggestion bulk selection, resolved comment indicators, conflict localStorage resume, and accessibility labels.
- Create `src/views/StudyPrepView.tsx`: extracted study prep component.
- Create `src/views/DeckStatsView.tsx`: extracted stats component.
- Create `src/views/DeckSettingsView.tsx`: extracted settings component.
- Modify `src/StudyView.tsx`: fraction label, skip action, session persistence, responsive/ARIA improvements.
- Modify `src/ConflictResolution.tsx`: localStorage resume and keyboard labels.
- Modify `src/SuggestionDiscussion.tsx`: resolved/unresolved visual status and toggle.
- Modify `src/CardEditor.tsx`: formatting toolbar ARIA labels and keyboard button names.
- Modify `src/NotificationsBell.tsx`: cursor pagination and load-more UI.
- Modify `src/styles.css`: responsive styles for `StudyView`, `CardEditor`, and `ConflictResolution`, plus resolved-thread styling and accessible toolbar focus.

---

### Task 1: Backend Security Validators

**Files:**
- Create: `server/security.mjs`
- Create: `server/security.test.mjs`
- Modify: `server/app.mjs`
- Modify: `server/routes.api.test.mjs`
- Modify: `src/types.ts`
- Modify: `src/App.tsx`
- Modify: `src/api.ts`

- [ ] **Step 1: Write failing pure security tests**

Add `server/security.test.mjs`:

```js
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

test('email validation accepts normal invites and rejects malformed values', () => {
  assert.equal(assertValidEmail(' Owner+Boards@example.COM '), 'owner+boards@example.com');
  assert.throws(() => assertValidEmail('not-an-email'), /valid email/i);
  assert.throws(() => assertValidEmail('a@b'), /valid email/i);
});

test('session role validation allowlists collaboration roles only', () => {
  assert.equal(assertValidSessionRole('owner'), 'owner');
  assert.equal(assertValidSessionRole('editor'), 'editor');
  assert.equal(assertValidSessionRole('reviewer'), 'reviewer');
  assert.equal(assertValidSessionRole('contributor'), 'contributor');
  assert.equal(assertValidSessionRole('viewer'), 'viewer');
  assert.throws(() => assertValidSessionRole('admin'), /valid role/i);
  assert.throws(() => assertValidSessionRole('__proto__'), /valid role/i);
});

test('deck id validation blocks path-like and oversized ids', () => {
  assert.equal(assertValidDeckId('deck-demo-zanki'), 'deck-demo-zanki');
  assert.equal(assertValidDeckId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.throws(() => assertValidDeckId('../state'), /valid deck id/i);
  assert.throws(() => assertValidDeckId('x'.repeat(65)), /valid deck id/i);
  assert.throws(() => assertValidDeckId('deck with spaces'), /valid deck id/i);
});
```

- [ ] **Step 2: Run security tests to verify they fail**

Run:

```bash
npm test -- --test-name-pattern="share-link secrets|email validation|session role validation|deck id validation"
```

Expected: FAIL with module-not-found for `./security.mjs`.

- [ ] **Step 3: Implement shared security helpers**

Create `server/security.mjs`:

```js
import crypto, { scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './errors.mjs';

const scrypt = promisify(nodeScrypt);
const SCRYPT_PREFIX = 'scrypt';
const SCRYPT_PARAMS = 'N=16384,r=8,p=1';
const SECRET_KEYLEN = 64;
const DECK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const VALID_SESSION_ROLES = ['owner', 'editor', 'reviewer', 'contributor', 'viewer'];

export async function hashSecret(value) {
  const secret = String(value ?? '');
  if (!secret) fail(400, 'missing_password', 'Password is required');
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scrypt(secret, salt, SECRET_KEYLEN);
  return `${SCRYPT_PREFIX}$${SCRYPT_PARAMS}$${salt}$${Buffer.from(derived).toString('base64url')}`;
}

export function isScryptSecretHash(value) {
  return typeof value === 'string' && value.startsWith(`${SCRYPT_PREFIX}$${SCRYPT_PARAMS}$`);
}

export async function verifySecret(value, stored) {
  if (!isScryptSecretHash(stored)) return false;
  const [, , salt, encoded] = stored.split('$');
  if (!salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'base64url');
  const actual = Buffer.from(await scrypt(String(value ?? ''), salt, expected.length));
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function assertValidEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    fail(400, 'invalid_email', 'A valid email address is required');
  }
  return email;
}

export function assertValidSessionRole(value) {
  const role = typeof value === 'string' ? value.trim() : '';
  if (!VALID_SESSION_ROLES.includes(role)) {
    fail(400, 'invalid_role', `Role must be one of: ${VALID_SESSION_ROLES.join(', ')}`);
  }
  return role;
}

export function assertValidDeckId(value) {
  const deckId = typeof value === 'string' ? value.trim() : '';
  if (!DECK_ID_PATTERN.test(deckId)) {
    fail(400, 'invalid_deck_id', 'A valid deck id is required');
  }
  return deckId;
}

export function deckIdFromRequest(req) {
  return assertValidDeckId(req.params.deckId || req.body.deckId || req.query.deckId);
}
```

- [ ] **Step 4: Run security tests to verify they pass**

Run:

```bash
npm test -- --test-name-pattern="share-link secrets|email validation|session role validation|deck id validation"
```

Expected: PASS for the four tests in `server/security.test.mjs`.

- [ ] **Step 5: Wire route-edge validation**

In `server/app.mjs`, replace the local `hashSecret()` function with imports:

```js
import {
  assertValidDeckId,
  assertValidEmail,
  assertValidSessionRole,
  deckIdFromRequest,
  hashSecret
} from './security.mjs';
```

Delete the old function:

```js
function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
```

Patch the session route:

```js
app.patch('/api/session', auth.requireUser, async (req, res, next) => {
  try {
    if (production) fail(404, 'not_found', 'Demo session controls are not available in production');
    if (req.body.activeDeckId && repository.setActiveDeck) {
      const deckId = assertValidDeckId(req.body.activeDeckId);
      res.json(await repository.setActiveDeck(req.user, deckId));
      return;
    }
    if (req.body.role && repository.setDemoRole) {
      const role = assertValidSessionRole(req.body.role);
      res.json(await repository.setDemoRole(req.user, role));
      return;
    }
    res.json(await repository.getDeckState(req.user));
  } catch (error) {
    next(error);
  }
});
```

Patch share links:

```js
app.get('/api/decks/:deckId/share-links', auth.requireUser, async (req, res, next) => {
  try {
    const deckId = deckIdFromRequest(req);
    if (!repository.listShareLinks) fail(501, 'share_links_unavailable', 'Share links are not available for this repository');
    res.json({ shareLinks: await repository.listShareLinks(req.user, deckId) });
  } catch (err) { next(err); }
});

app.post('/api/decks/:deckId/share-links', auth.requireUser, async (req, res, next) => {
  try {
    const deckId = deckIdFromRequest(req);
    if (!repository.createShareLink) fail(501, 'share_links_unavailable', 'Share links are not available for this repository');
    if (req.body.passwordHash) fail(400, 'password_hash_not_allowed', 'Send a password, not a passwordHash');
    const passwordHash = req.body.password ? await hashSecret(req.body.password) : null;
    const link = await repository.createShareLink(req.user, deckId, {
      token: crypto.randomBytes(18).toString('base64url'),
      label: cleanShortText(req.body.label, 'Share link'),
      passwordHash,
      expiresAt: cleanIsoOrNull(req.body.expiresAt)
    });
    res.status(201).json({ shareLink: link });
  } catch (err) { next(err); }
});
```

Patch invite email validation:

```js
const email = assertValidEmail(req.body.email);
```

Patch these routes to call `deckIdFromRequest(req)` before repository/Supabase access and use the returned `deckId`: export, CSV export, activity export, summary export, visibility, share-links, invites list/create/revoke, fork, star/unstar, analytics, study progress by deck, sync conflicts, and add-on card sync.

- [ ] **Step 6: Update client role types away from legacy `collaborator`**

In `src/types.ts`, replace:

```ts
export type DemoRole = 'owner' | 'collaborator';
```

with:

```ts
export type DemoRole = MembershipRole;
```

In `src/App.tsx`, replace:

```ts
function switchRole(role: 'owner' | 'collaborator') {
  refreshWith(api.session({ role }), role === 'owner' ? 'Owner review controls enabled' : 'Collaborator suggestion mode enabled');
}
```

with:

```ts
function switchRole(role: 'owner' | 'contributor') {
  refreshWith(api.session({ role }), role === 'owner' ? 'Owner review controls enabled' : 'Contributor suggestion mode enabled');
}
```

Replace the collaborator toggle call:

```tsx
<button className={membershipRole !== 'owner' ? 'selected' : ''} onClick={() => switchRole('contributor')}>Contributor</button>
```

- [ ] **Step 7: Write failing route tests for validation**

Append to `server/routes.api.test.mjs`:

```js
test('security validation rejects malformed deck ids and session roles', async () => {
  const { app } = await createTestApp();

  await asUser(request(app).patch('/api/session').send({ role: 'admin' }), 'you', 'You')
    .expect(400)
    .expect((res) => assert.equal(res.body.error.code, 'invalid_role'));

  await asUser(request(app).post('/api/decks/../../state/export').send({}), 'you', 'You')
    .expect(400)
    .expect((res) => assert.equal(res.body.error.code, 'invalid_deck_id'));

  await asUser(request(app).post('/api/decks/deck-demo-zanki/share-links').send({ passwordHash: 'abc' }), 'you', 'You')
    .expect(400)
    .expect((res) => assert.equal(res.body.error.code, 'password_hash_not_allowed'));
});

test('invite API rejects malformed email before storing invite', async () => {
  const { app } = await createTestApp();

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/invites')
    .send({ email: 'not-an-email', role: 'contributor' }), 'you', 'You')
    .expect(400)
    .expect((res) => assert.equal(res.body.error.code, 'invalid_email'));
});
```

- [ ] **Step 8: Run route tests**

Run:

```bash
npm test -- --test-name-pattern="security validation|invite API rejects"
```

Expected: PASS.

- [ ] **Step 9: Commit security validators**

Run:

```bash
git add server/security.mjs server/security.test.mjs server/app.mjs server/routes.api.test.mjs src/types.ts src/App.tsx src/api.ts
git commit -m "Reject unsafe deck inputs before repository access" -m "Security-sensitive routes now validate deck IDs, session roles, invite email addresses, and share-link passwords at the Express edge.

Constraint: Share-link passwords must not use fast unsalted SHA-256.
Rejected: Trusting client-supplied passwordHash | lets callers bypass server-side password hashing policy
Confidence: high
Scope-risk: moderate
Tested: npm test -- --test-name-pattern=\"share-link secrets|email validation|session role validation|deck id validation|security validation|invite API rejects\""
```

---

### Task 2: Express Rate Limiting

**Files:**
- Create: `server/rateLimits.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/app.mjs`
- Modify: `server/routes.api.test.mjs`

- [ ] **Step 1: Install the explicit rate-limit dependency**

Run:

```bash
npm install express-rate-limit --save
```

Expected: `package.json` and `package-lock.json` include `express-rate-limit`.

- [ ] **Step 2: Create rate limiter factory**

Create `server/rateLimits.mjs`:

```js
import rateLimit from 'express-rate-limit';

function passThrough(_req, _res, next) {
  next();
}

function makeLimiter({ limit, windowMs, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'rate_limited',
        message
      },
      legacyError: message
    }
  });
}

export function createRateLimiters(options = {}) {
  if (options.disabled) {
    return {
      upload: passThrough,
      sync: passThrough,
      analytics: passThrough,
      read: passThrough
    };
  }

  const windowMs = Number(options.windowMs || 60_000);
  return {
    upload: makeLimiter({
      windowMs,
      limit: Number(options.uploadLimit || 5),
      message: 'Too many upload attempts. Try again in a minute.'
    }),
    sync: makeLimiter({
      windowMs,
      limit: Number(options.syncLimit || 30),
      message: 'Too many sync attempts. Try again in a minute.'
    }),
    analytics: makeLimiter({
      windowMs,
      limit: Number(options.analyticsLimit || 60),
      message: 'Too many analytics requests. Try again in a minute.'
    }),
    read: makeLimiter({
      windowMs,
      limit: Number(options.readLimit || 200),
      message: 'Too many read requests. Try again in a minute.'
    })
  };
}
```

- [ ] **Step 3: Wire rate limiters before matching routes**

In `server/app.mjs`, import:

```js
import { createRateLimiters } from './rateLimits.mjs';
```

Inside `createApp()` after `corsOrigin`:

```js
const rateLimiters = createRateLimiters(options.rateLimits);
```

Before route definitions that receive traffic, add:

```js
app.use('/api/decks/upload', rateLimiters.upload);
app.use('/api/decks/:deckId/sync/cards', rateLimiters.sync);
app.use('/api/decks/:deckId/analytics', rateLimiters.analytics);
app.use('/api/notifications', rateLimiters.read);
app.use('/api/decks', rateLimiters.read);
```

In `createTestApp()` inside `server/routes.api.test.mjs`, pass disabled defaults:

```js
rateLimits: { disabled: true },
```

Do the same in `createTokenTestApp()` unless a test overrides it:

```js
rateLimits: { disabled: true },
```

- [ ] **Step 4: Write failing route test for rate limiting**

Append to `server/routes.api.test.mjs`:

```js
test('rate limiting protects read and sync routes with configurable limits', async () => {
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
  await asUser(request(app).get('/api/decks'), 'you', 'You')
    .expect(429)
    .expect((res) => assert.equal(res.body.error.code, 'rate_limited'));

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({ cards: [{ id: 'anki-rate-1', fields: { Front: 'A' } }] }), 'you', 'You').expect(200);
  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({ cards: [{ id: 'anki-rate-2', fields: { Front: 'B' } }] }), 'you', 'You')
    .expect(429)
    .expect((res) => assert.equal(res.body.error.code, 'rate_limited'));
});
```

- [ ] **Step 5: Run rate-limit test**

Run:

```bash
npm test -- --test-name-pattern="rate limiting protects"
```

Expected: PASS.

- [ ] **Step 6: Run backend suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit rate limiting**

Run:

```bash
git add package.json package-lock.json server/rateLimits.mjs server/app.mjs server/routes.api.test.mjs
git commit -m "Throttle abusive DeckBridge API paths" -m "Uploads, sync, analytics, and common read routes now have explicit Express rate limits with test overrides for deterministic route coverage.

Constraint: Upload and sync endpoints are the most abusable routes.
Rejected: A single global limiter | would make high-volume read paths and uploads share the same budget
Confidence: high
Scope-risk: moderate
Tested: npm test"
```

---

### Task 3: Notification Pagination

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/routes.api.test.mjs`
- Modify: `src/api.ts`
- Modify: `src/NotificationsBell.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Write failing API test for cursor pagination**

Append to `server/routes.api.test.mjs`:

```js
test('notifications API supports limit and created_at cursor pagination', async () => {
  const supabase = new FakeSupabase();
  supabase.tables.notifications = [
    { id: 'n3', user_id: 'you', deck_id: null, kind: 'comment', body: 'Third', ref_id: null, read: false, created_at: '2026-05-07T12:03:00.000Z' },
    { id: 'n2', user_id: 'you', deck_id: null, kind: 'comment', body: 'Second', ref_id: null, read: false, created_at: '2026-05-07T12:02:00.000Z' },
    { id: 'n1', user_id: 'you', deck_id: null, kind: 'comment', body: 'First', ref_id: null, read: true, created_at: '2026-05-07T12:01:00.000Z' }
  ];
  const { createApp } = await import(`./app.mjs?test=${Date.now()}-${Math.random()}`);
  const app = createApp({
    production: false,
    repositoryMode: 'local',
    rateLimits: { disabled: true },
    auth: {
      supabase,
      requireUser(req, _res, next) {
        req.user = { id: 'you', email: 'you@example.com', name: 'You' };
        next();
      }
    }
  });

  const first = await request(app).get('/api/notifications?limit=2').expect(200);
  assert.deepEqual(first.body.notifications.map((item) => item.id), ['n3', 'n2']);
  assert.equal(first.body.unread, 2);
  assert.equal(first.body.nextCursor, '2026-05-07T12:02:00.000Z');

  const second = await request(app)
    .get('/api/notifications')
    .query({ limit: 2, cursor: first.body.nextCursor })
    .expect(200);
  assert.deepEqual(second.body.notifications.map((item) => item.id), ['n1']);
  assert.equal(second.body.nextCursor, null);
});
```

- [ ] **Step 2: Add cursor support in route**

Replace the current `GET /api/notifications` handler in `server/app.mjs` with:

```js
app.get('/api/notifications', auth.requireUser, async (req, res, next) => {
  try {
    if (!auth.supabase) return res.json({ notifications: [], unread: 0, nextCursor: null });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const cursor = cleanIsoOrNull(req.query.cursor);
    let query = auth.supabase.from('notifications')
      .select('id, deck_id, kind, body, ref_id, read, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (cursor) query = query.lt('created_at', cursor);
    const { data, error } = await query;
    if (error) fail(500, 'notifications_error', error.message);
    const rows = data || [];
    const page = rows.slice(0, limit);
    const unread = rows.filter((n) => !n.read).length;
    const nextCursor = rows.length > limit ? page[page.length - 1].created_at : null;
    res.json({ notifications: page, unread, nextCursor });
  } catch (err) { next(err); }
});
```

Extend `FakeQuery` in `server/routes.api.test.mjs`:

```js
lt(field, value) {
  this.filters.push({ field, value, op: 'lt' });
  return this;
}
```

Update `matches(row)`:

```js
if (op === 'lt') return String(row[field]) < String(value);
```

- [ ] **Step 3: Update frontend API and notification UI**

In `src/api.ts`, change `Notification` response type by adding:

```ts
export interface NotificationPage {
  notifications: Notification[];
  unread: number;
  nextCursor: string | null;
}
```

Replace `notifications.list` with:

```ts
list: (params?: { limit?: number; cursor?: string | null }) => {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.cursor) qs.set('cursor', params.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return jsonRequest<NotificationPage>(`/api/notifications${suffix}`);
},
```

In `src/NotificationsBell.tsx`, add state:

```ts
const [nextCursor, setNextCursor] = useState<string | null>(null);
const [loadingMore, setLoadingMore] = useState(false);
```

Replace `load()` body with:

```ts
const { notifications: data, unread: count, nextCursor: cursor } = await api.notifications.list({ limit: 20 });
setNotifications(data);
setUnread(count);
setNextCursor(cursor);
```

Add function:

```ts
async function loadMore() {
  if (!nextCursor || loadingMore) return;
  setLoadingMore(true);
  try {
    const { notifications: data, nextCursor: cursor } = await api.notifications.list({ limit: 20, cursor: nextCursor });
    setNotifications((prev) => [...prev, ...data]);
    setNextCursor(cursor);
  } finally {
    setLoadingMore(false);
  }
}
```

After notification items:

```tsx
{nextCursor && (
  <button className="notif-load-more" onClick={loadMore} disabled={loadingMore}>
    {loadingMore ? 'Loading...' : 'Load more'}
  </button>
)}
```

In `src/styles.css`, add:

```css
.notif-load-more {
  width: 100%;
  border: 0;
  border-top: 1px solid var(--border, #e5e7eb);
  background: var(--bg-secondary, #f3f4f6);
  color: var(--text-secondary, #555);
  font-weight: 700;
  padding: 10px 12px;
  cursor: pointer;
}

.notif-load-more:hover:not(:disabled),
.notif-load-more:focus-visible {
  background: var(--bg-hover, #e9ebee);
  outline: 2px solid var(--color-primary, #4f46e5);
  outline-offset: -2px;
}
```

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npm test -- --test-name-pattern="notifications API supports"
npm run build
```

Expected: both PASS.

- [ ] **Step 5: Commit notification pagination**

Run:

```bash
git add server/app.mjs server/routes.api.test.mjs src/api.ts src/NotificationsBell.tsx src/styles.css
git commit -m "Page notification history by cursor" -m "Notifications now return bounded pages with a stable created_at cursor and a load-more control in the bell menu.

Constraint: Active decks can accumulate notification history indefinitely.
Rejected: Offset pagination | inserts during polling can shift pages and duplicate rows
Confidence: high
Scope-risk: narrow
Tested: npm test -- --test-name-pattern=\"notifications API supports\"; npm run build"
```

---

### Task 4: Bulk Suggestion Decisions

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/repositories/localRepository.mjs`
- Modify: `server/repositories/supabaseRepository.mjs`
- Modify: `server/routes.api.test.mjs`
- Modify: `src/api.ts`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Write failing backend test**

Append to `server/routes.api.test.mjs`:

```js
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
      cardId: 'card-mpa',
      reason: 'Second change',
      proposedFields: { Front: 'Second bulk update?' },
      proposedTags: ['Rheumatology', 'Bulk']
    }), 'maya', 'Maya Patel').expect(201);
  const secondId = second.body.suggestions[0].id;

  const decided = await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/suggestions/bulk-decision')
    .send({ suggestionIds: [firstId, secondId], decision: 'rejected' }), 'you', 'You').expect(200);

  const statuses = new Map(decided.body.suggestions.map((item) => [item.id, item.status]));
  assert.equal(statuses.get(firstId), 'rejected');
  assert.equal(statuses.get(secondId), 'rejected');
});
```

- [ ] **Step 2: Add repository methods**

In `server/repositories/localRepository.mjs`, add after `decideSuggestion`:

```js
async bulkDecideSuggestions(user, deckId, suggestionIds, decision) {
  const state = await loadState();
  ensureCollections(state);
  requireRole(state, user.id, deckId, 'owner');
  const ids = new Set(suggestionIds);
  const selected = state.suggestions.filter((item) => ids.has(item.id) && item.deckId === deckId);
  if (selected.length !== ids.size) fail(404, 'suggestion_not_found', 'One or more suggestions were not found');
  for (const suggestion of selected) {
    if (suggestion.status !== 'pending') fail(409, 'suggestion_reviewed', 'One or more suggestions have already been reviewed');
    const deck = state.decks.find((item) => item.id === deckId);
    if (decision === 'accepted') {
      applySuggestion(deck, suggestion, user.name);
      const collaborator = state.collaborators.find((item) => item.id === suggestion.authorId);
      if (collaborator) collaborator.accepted += 1;
    }
    suggestion.status = decision;
    suggestion.reviewedAt = nowIso();
    suggestion.reviewedBy = user.name;
  }
  state.activity.unshift({
    id: `act-${randomUUID()}`,
    kind: decision,
    text: `${user.name} ${decision} ${selected.length} suggestion(s)`,
    at: nowIso()
  });
  await saveState(state);
  return this.getDeckState(user, deckId);
},
```

In `server/repositories/supabaseRepository.mjs`, add after `decideSuggestion`:

```js
async bulkDecideSuggestions(user, deckId, suggestionIds, decision) {
  await assertMembership(user.id, deckId, 'reviewer');
  const { data: suggestions, error } = await supabase.from('suggestions')
    .select('*')
    .eq('deck_id', deckId)
    .in('id', suggestionIds);
  if (error) throw error;
  if ((suggestions || []).length !== suggestionIds.length) fail(404, 'suggestion_not_found', 'One or more suggestions were not found');
  if ((suggestions || []).some((item) => item.status !== 'pending')) {
    fail(409, 'suggestion_reviewed', 'One or more suggestions have already been reviewed');
  }

  for (const suggestion of suggestions || []) {
    if (decision === 'accepted') {
      const { data: card, error: cardError } = await supabase.from('cards').select('*').eq('id', suggestion.card_id).single();
      if (cardError || !card) fail(404, 'card_not_found', 'Card not found');
      const deck = toDeck({ id: deckId, name: '', imported_at: nowIso() }, [toCard(card)]);
      applySuggestion(deck, toSuggestion(suggestion), user.name);
      const nextCard = deck.cards[0];
      const { error: updateCardError } = await supabase.from('cards').update({
        fields: nextCard.fields,
        tags: nextCard.tags,
        modified_at: nextCard.modifiedAt,
        modified_by: nextCard.modifiedBy
      }).eq('id', suggestion.card_id).eq('deck_id', deckId);
      if (updateCardError) throw updateCardError;
    }
  }

  const reviewedAt = nowIso();
  const { error: updateError } = await supabase.from('suggestions').update({
    status: decision,
    reviewed_at: reviewedAt,
    reviewed_by: user.name
  }).eq('deck_id', deckId).in('id', suggestionIds);
  if (updateError) throw updateError;
  await supabase.from('activity').insert({
    id: `act-${randomUUID()}`,
    deck_id: deckId,
    user_id: user.id,
    kind: decision,
    text: `${user.name} ${decision} ${suggestionIds.length} suggestion(s)`,
    created_at: reviewedAt
  });
  return getDeckRows(user, deckId);
},
```

- [ ] **Step 3: Add Express endpoint**

In `server/app.mjs`, add after the single suggestion decision route:

```js
app.post('/api/decks/:deckId/suggestions/bulk-decision', auth.requireUser, requireReviewer(auth.supabase), async (req, res, next) => {
  try {
    const deckId = deckIdFromRequest(req);
    if (!['accepted', 'rejected', 'revision'].includes(req.body.decision)) {
      fail(400, 'invalid_decision', 'Decision must be accepted, rejected, or revision');
    }
    const suggestionIds = Array.isArray(req.body.suggestionIds)
      ? req.body.suggestionIds.map((id) => cleanShortText(id, '', 200)).filter(Boolean).slice(0, 100)
      : [];
    if (!suggestionIds.length) fail(400, 'missing_suggestion_ids', 'suggestionIds array is required');
    if (!repository.bulkDecideSuggestions) fail(501, 'bulk_decision_unavailable', 'Bulk suggestion decisions are not available');
    res.json(await repository.bulkDecideSuggestions(req.user, deckId, suggestionIds, req.body.decision));
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Run backend bulk test**

Run:

```bash
npm test -- --test-name-pattern="bulk suggestion decisions"
```

Expected: PASS.

- [ ] **Step 5: Add API client method**

In `src/api.ts`, add:

```ts
bulkDecideSuggestions: (deckId: string, suggestionIds: string[], decision: 'accepted' | 'rejected' | 'revision') =>
  jsonRequest<AppState>(`/api/decks/${deckId}/suggestions/bulk-decision`, {
    method: 'POST',
    body: JSON.stringify({ suggestionIds, decision })
  }),
```

Place it next to `decideSuggestion`.

- [ ] **Step 6: Add queue selection state and handlers**

In `src/App.tsx`, add state near other suggestion/review state:

```ts
const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(() => new Set());
```

Add helper functions:

```ts
function toggleSuggestionSelection(id: string) {
  setSelectedSuggestionIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

function clearSuggestionSelection() {
  setSelectedSuggestionIds(new Set());
}

function bulkDecideSuggestions(decision: 'accepted' | 'rejected' | 'revision') {
  if (!activeDeck || !selectedSuggestionIds.size) return;
  const ids = [...selectedSuggestionIds];
  refreshWith(api.bulkDecideSuggestions(activeDeck.id, ids, decision), `${ids.length} suggestion(s) ${decision}`, (next) => {
    clearSuggestionSelection();
    return next;
  });
}
```

- [ ] **Step 7: Add review-queue bulk toolbar and checkboxes**

Above `<div className="queue-list">` in `src/App.tsx`, add:

```tsx
{canReview && selectedSuggestionIds.size > 0 && (
  <div className="suggestion-bulk-toolbar" role="toolbar" aria-label="Bulk suggestion actions">
    <strong>{selectedSuggestionIds.size} selected</strong>
    <button className="button secondary" onClick={() => bulkDecideSuggestions('rejected')} disabled={busy}>Reject</button>
    <button className="button secondary" onClick={() => bulkDecideSuggestions('revision')} disabled={busy}>Request revision</button>
    <button className="button primary" onClick={() => bulkDecideSuggestions('accepted')} disabled={busy}>Accept</button>
    <button className="button secondary" onClick={clearSuggestionSelection} disabled={busy}>Clear</button>
  </div>
)}
```

Inside each `queue-item` button, add a checkbox before the avatar:

```tsx
{canReview && suggestion.status === 'pending' && (
  <span
    className={`queue-select ${selectedSuggestionIds.has(suggestion.id) ? 'checked' : ''}`}
    role="checkbox"
    aria-checked={selectedSuggestionIds.has(suggestion.id)}
    aria-label={selectedSuggestionIds.has(suggestion.id) ? 'Deselect suggestion' : 'Select suggestion'}
    onClick={(event) => {
      event.stopPropagation();
      toggleSuggestionSelection(suggestion.id);
    }}
  />
)}
```

- [ ] **Step 8: Add styles**

In `src/styles.css`, add:

```css
.suggestion-bulk-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border-primary, #bdd8ff);
  background: var(--bg-primary-subtle, #eef6ff);
  border-radius: 8px;
  padding: 8px;
  margin: 10px 0;
  flex-wrap: wrap;
}

.suggestion-bulk-toolbar strong {
  color: var(--color-primary, #4f46e5);
  font-size: 0.82rem;
  margin-right: auto;
}

.queue-select {
  width: 18px;
  height: 18px;
  border: 2px solid var(--line-strong, #cbd5e1);
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.queue-select.checked::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--color-primary, #4f46e5);
}
```

- [ ] **Step 9: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit bulk decisions**

Run:

```bash
git add server/app.mjs server/repositories/localRepository.mjs server/repositories/supabaseRepository.mjs server/routes.api.test.mjs src/api.ts src/App.tsx src/styles.css
git commit -m "Let reviewers decide suggestions in batches" -m "Reviewers can select multiple pending suggestions and apply one accepted/rejected/revision decision through a bounded backend endpoint.

Constraint: Active contributor decks make one-by-one suggestion triage slow.
Rejected: Client-side loops over the existing single-decision endpoint | creates partial updates and slow feedback on larger queues
Confidence: high
Scope-risk: moderate
Tested: npm test -- --test-name-pattern=\"bulk suggestion decisions\"; npm run build"
```

---

### Task 5: Media Sync From Anki Add-on To Platform

**Files:**
- Modify: `server/domain.mjs`
- Modify: `server/domain.test.mjs`
- Modify: `server/repositories/localRepository.mjs`
- Modify: `server/repositories/supabaseRepository.mjs`
- Modify: `server/app.mjs`
- Modify: `server/routes.api.test.mjs`
- Modify: `addons/deckbridge_sync/__init__.py`
- Modify: `addons/deckbridge_sync/tests/test_addon.py`
- Create: `src/media.ts`
- Modify: `src/StudyView.tsx`
- Modify: `src/types.ts`

- [ ] **Step 1: Write failing domain tests for media payload normalization**

Add to imports in `server/domain.test.mjs`:

```js
import { normalizeAddonSyncInput, mergeAddonCards } from './domain.mjs';
```

Append:

```js
test('add-on sync normalizes media payloads and merges them into deck media', () => {
  const syncInput = normalizeAddonSyncInput({
    cards: [{
      id: 'anki-media-1',
      fields: { Front: '<img src="heart.png">', Back: '[sound:lubdub.mp3]' },
      mediaRefs: ['heart.png', 'lubdub.mp3']
    }],
    media: {
      'heart.png': {
        filename: 'heart.png',
        mimeType: 'image/png',
        sha256: 'abc123',
        dataBase64: Buffer.from('fake-png').toString('base64')
      },
      'lubdub.mp3': {
        filename: 'lubdub.mp3',
        mimeType: 'audio/mpeg',
        sha256: 'def456',
        dataBase64: Buffer.from('fake-mp3').toString('base64')
      }
    }
  });

  assert.equal(syncInput.cards[0].mediaRefs.length, 2);
  assert.equal(syncInput.media['heart.png'].mimeType, 'image/png');

  const deck = { id: 'deck-media', cards: [], media: {}, lastSyncedAt: null };
  const result = mergeAddonCards(deck, syncInput, 'Anki');
  assert.equal(result.stats.created, 1);
  assert.equal(deck.media['heart.png'].sha256, 'abc123');
  assert.equal(deck.media['lubdub.mp3'].mimeType, 'audio/mpeg');
});
```

- [ ] **Step 2: Implement media normalization and merge**

In `server/domain.mjs`, add:

```js
function normalizeMediaPayload(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 300)
      .map(([key, item]) => {
        const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
        const filename = cleanText(source.filename || key, '', 240);
        const dataBase64 = cleanText(source.dataBase64, '', 8_000_000);
        const mimeType = cleanText(source.mimeType, 'application/octet-stream', 120);
        const sha256 = cleanText(source.sha256, '', 120);
        return [filename, { filename, mimeType, sha256, dataBase64 }];
      })
      .filter(([filename, item]) => filename && item.dataBase64)
  );
}
```

In `normalizeAddonSyncInput()`, add to returned object:

```js
media: normalizeMediaPayload(body.media),
```

In `normalizeAddonDeckCreateInput()`, replace `media: {},` with:

```js
media: syncInput.media,
```

At the top of `mergeAddonCards()`, after `result` is created:

```js
if (!syncInput.dryRun && syncInput.media && Object.keys(syncInput.media).length) {
  deck.media = { ...(deck.media || {}), ...syncInput.media };
}
```

- [ ] **Step 3: Persist media changes in repositories**

In `server/repositories/localRepository.mjs`, no extra write is needed after `mergeAddonCards()` because it mutates the in-memory deck before `saveState(state)`. Add this assertion to the existing add-on sync route test in Step 6.

In `server/repositories/supabaseRepository.mjs`, inside `syncCardsFromAddon()` after `lastAddonSync` is computed:

```js
const nextMedia = { ...(deck.media || {}), ...(syncInput.media || {}) };
```

When updating `decks` in both non-dry-run and dry-run branches, include:

```js
media: nextMedia,
```

Use the same `nextMedia` only for non-dry-run if dry-run should not persist media:

```js
...(syncInput.dryRun ? {} : { media: nextMedia }),
```

- [ ] **Step 4: Add authenticated media route**

In `server/app.mjs`, add before Anki routes:

```js
app.get('/api/decks/:deckId/media/:filename', auth.requireUser, async (req, res, next) => {
  try {
    const deckId = deckIdFromRequest(req);
    const filename = cleanShortText(req.params.filename, '', 240);
    if (!filename) fail(400, 'invalid_media_filename', 'A valid media filename is required');
    const state = await repository.getDeckState(req.user, deckId);
    const deck = state.decks[0];
    const asset = deck?.media?.[filename];
    if (!asset?.dataBase64) fail(404, 'media_not_found', 'Media file not found');
    res.set({
      'Content-Type': asset.mimeType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600'
    });
    res.send(Buffer.from(asset.dataBase64, 'base64'));
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 5: Write route test for media serving**

Append to `server/routes.api.test.mjs`:

```js
test('add-on media sync stores and serves referenced media', async () => {
  const { app } = await createTestApp();
  const payload = Buffer.from('fake-image-bytes').toString('base64');

  await asUser(request(app)
    .post('/api/decks/deck-demo-zanki/sync/cards')
    .send({
      conflictPolicy: 'overwrite-platform',
      cards: [{
        id: 'anki-media-route',
        fields: { Front: '<img src="heart.png">', Back: 'sound' },
        mediaRefs: ['heart.png']
      }],
      media: {
        'heart.png': {
          filename: 'heart.png',
          mimeType: 'image/png',
          sha256: 'sha-media-route',
          dataBase64: payload
        }
      }
    }), 'you', 'You').expect(200);

  const media = await asUser(request(app).get('/api/decks/deck-demo-zanki/media/heart.png'), 'you', 'You')
    .buffer(true)
    .parse((res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.equal(media.headers['content-type'], 'image/png');
  assert.equal(media.body.toString('utf8'), 'fake-image-bytes');
});
```

- [ ] **Step 6: Add add-on media extraction**

In `addons/deckbridge_sync/__init__.py`, add imports:

```python
import base64
import hashlib
import mimetypes
```

Add helpers before `note_to_card()`:

```python
MEDIA_REF_RE = re.compile(r"""(?:<img[^>]+src=["']([^"']+)["']|\[sound:([^\]]+)\])""", re.IGNORECASE)


def media_refs_from_fields(fields: Dict[str, str]) -> List[str]:
    refs: List[str] = []
    for value in fields.values():
        for image_ref, sound_ref in MEDIA_REF_RE.findall(str(value or "")):
            ref = image_ref or sound_ref
            if ref and not ref.startswith(("http://", "https://", "data:")):
                refs.append(ref)
    return sorted(set(refs))


def media_dir() -> str:
    return str(mw.col.media.dir())


def collect_media_payload(cards: List[Dict[str, Any]]) -> Dict[str, Dict[str, str]]:
    refs = sorted({ref for card in cards for ref in card.get("mediaRefs", [])})
    payload: Dict[str, Dict[str, str]] = {}
    root = media_dir()
    for ref in refs:
        filename = os.path.basename(ref)
        path = os.path.join(root, filename)
        if not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            raw = handle.read()
        payload[filename] = {
            "filename": filename,
            "mimeType": mimetypes.guess_type(filename)[0] or "application/octet-stream",
            "sha256": hashlib.sha256(raw).hexdigest(),
            "dataBase64": base64.b64encode(raw).decode("ascii"),
        }
    return payload
```

In `note_to_card()`, build fields first and add `mediaRefs`:

```python
fields = {name: str(note[name]) for name in field_names}
```

Then return:

```python
"fields": fields,
"mediaRefs": media_refs_from_fields(fields),
```

In `sync_payload()`, after cards are resolved:

```python
payload_cards = collect_cards() if cards is None else cards
```

Use `payload_cards` for `"cards"` and add:

```python
"media": collect_media_payload(payload_cards),
```

- [ ] **Step 7: Add add-on tests for media**

Update imports in `addons/deckbridge_sync/tests/test_addon.py`:

```python
from deckbridge_sync import (
    ADDON_VERSION,
    apply_autoconfig,
    addon_manifest,
    collect_media_payload,
    config,
    create_platform_deck_from_anki,
    DEFAULT_CONFIG,
    media_refs_from_fields,
    CONFIG_KEY,
    last_autoconfig_error,
    login_to_account,
    local_deck_names,
    normalize_platform_url,
    open_settings,
    platform_url,
    post_cards,
    pull_to_anki,
    save_config,
    safe_tag,
    sync_payload,
    sync_payload_chunks,
    tracking_tag,
    note_query,
    validate_token,
    TRACKING_TAG_PREFIX,
    _flat_from_stored,
    _handle_url_scheme,
)
```

Append:

```python
class TestMediaSync(unittest.TestCase):
    def test_extracts_image_and_sound_refs_from_fields(self):
        refs = media_refs_from_fields({
            'Front': '<img src="heart.png">',
            'Back': '[sound:lubdub.mp3] <img src="https://example.com/remote.png">',
        })
        self.assertEqual(refs, ['heart.png', 'lubdub.mp3'])

    @patch('deckbridge_sync.media_dir')
    def test_collect_media_payload_reads_local_media_files(self, mock_media_dir):
        import tempfile
        with tempfile.TemporaryDirectory() as tempdir:
            mock_media_dir.return_value = tempdir
            path = os.path.join(tempdir, 'heart.png')
            with open(path, 'wb') as handle:
                handle.write(b'fake-png')
            payload = collect_media_payload([{'mediaRefs': ['heart.png']}])
        self.assertEqual(payload['heart.png']['mimeType'], 'image/png')
        self.assertEqual(payload['heart.png']['dataBase64'], 'ZmFrZS1wbmc=')
```

- [ ] **Step 8: Render platform media in study cards**

Create `src/media.ts`:

```ts
export function mediaUrl(deckId: string, filename: string) {
  return `/api/decks/${encodeURIComponent(deckId)}/media/${encodeURIComponent(filename)}`;
}

export function renderMediaHtml(deckId: string, html: string) {
  return String(html || '')
    .replace(/(<img\b[^>]*\bsrc=["'])(?!https?:|data:)([^"']+)(["'][^>]*>)/gi, (_match, before, filename, after) => {
      return `${before}${mediaUrl(deckId, filename)}${after}`;
    })
    .replace(/\[sound:([^\]]+)\]/gi, (_match, filename) => {
      const src = mediaUrl(deckId, filename);
      return `<audio controls src="${src}"></audio>`;
    });
}
```

In `src/StudyView.tsx`, import:

```ts
import { renderMediaHtml } from './media';
```

Replace the front/back render calls with:

```tsx
dangerouslySetInnerHTML={{ __html: renderMediaHtml(deckId, fieldVal(currentCard, 'Front')) }}
```

and:

```tsx
dangerouslySetInnerHTML={{ __html: renderMediaHtml(deckId, fieldVal(currentCard, 'Back')) }}
```

- [ ] **Step 9: Run media verification**

Run:

```bash
npm test -- --test-name-pattern="media"
python -m unittest addons.deckbridge_sync.tests.test_addon.TestMediaSync
npm run build
```

Expected: all PASS.

- [ ] **Step 10: Commit media sync**

Run:

```bash
git add server/domain.mjs server/domain.test.mjs server/repositories/localRepository.mjs server/repositories/supabaseRepository.mjs server/app.mjs server/routes.api.test.mjs addons/deckbridge_sync/__init__.py addons/deckbridge_sync/tests/test_addon.py src/media.ts src/StudyView.tsx src/types.ts
git commit -m "Carry Anki media through add-on sync" -m "The add-on now uploads local referenced media, the backend stores it on the deck, and study cards rewrite local image/audio refs to authenticated media URLs.

Constraint: Real Anki decks frequently use image and audio refs inside note HTML.
Rejected: Syncing only media filenames | still leaves platform study cards with broken image and sound references
Confidence: medium
Scope-risk: broad
Tested: npm test -- --test-name-pattern=\"media\"; python -m unittest addons.deckbridge_sync.tests.test_addon.TestMediaSync; npm run build
Not-tested: Large media collections near hosted request-size limits"
```

---

### Task 6: Study UX Progress, Skip, And Session Summary

**Files:**
- Modify: `src/api.ts`
- Modify: `src/StudyView.tsx`
- Modify: `src/styles.css`
- Modify: `server/routes.api.test.mjs`

- [ ] **Step 1: Add frontend API method**

In `src/api.ts`, add:

```ts
createStudySession: (payload: {
  deckId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  cardsStudied: number;
  cardsCorrect: number;
  newCards: number;
  reviewCards: number;
  metadata: Record<string, unknown>;
}) =>
  jsonRequest<{ session: StudySession }>('/api/study/sessions', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
```

- [ ] **Step 2: Update StudyView state and skip action**

In `src/StudyView.tsx`, replace session stats state:

```ts
const [sessionStats, setSessionStats] = useState({ again: 0, hard: 0, good: 0, easy: 0, skipped: 0 });
const [sessionSaved, setSessionSaved] = useState(false);
const startedAt = useRef(new Date().toISOString());
```

Add helper:

```ts
const advanceQueue = useCallback(() => {
  const nextIndex = queueIndex + 1;
  if (nextIndex >= queue.length) {
    const newQueue = buildStudyQueue(cards.map((c) => c.id), allProgress);
    if (newQueue.length === 0) {
      setDone(true);
      return;
    }
  }
  setQueueIndex(nextIndex);
  setFlipped(false);
}, [allProgress, cards, queue.length, queueIndex]);
```

Add skip callback:

```ts
const skipCard = useCallback(() => {
  if (!currentCardId) return;
  setSessionStats((s) => ({ ...s, skipped: s.skipped + 1 }));
  advanceQueue();
}, [advanceQueue, currentCardId]);
```

In `rate()`, after updating stats and handling Again queue append, replace manual queue advancement with:

```ts
advanceQueue();
```

Update keyboard shortcuts:

```ts
else if (e.key.toLowerCase() === 's') skipCard();
```

- [ ] **Step 3: Add progress fraction and skip button**

In `src/StudyView.tsx`, compute:

```ts
const totalSeen = Math.min(queueIndex + 1, queue.length);
const progressPercent = queue.length ? Math.round((queueIndex / queue.length) * 100) : 0;
```

Replace progress fill width:

```tsx
style={{ width: `${progressPercent}%` }}
```

In `.study-meta`, add:

```tsx
<span aria-label="Study session progress">Card {totalSeen} of {queue.length}</span>
```

Add a skip button next to close or in the rating row placeholder:

```tsx
<button className="btn btn-ghost study-skip" onClick={skipCard} aria-label="Skip this card without rating it">
  Skip <kbd>S</kbd>
</button>
```

In the done view breakdown, add:

```tsx
<span className="rating-skipped">Skipped: {sessionStats.skipped}</span>
```

- [ ] **Step 4: Persist session summary once**

In `src/StudyView.tsx`, import API:

```ts
import { api } from './api';
```

Add effect:

```ts
useEffect(() => {
  if ((!done && queue.length !== 0) || sessionSaved) return;
  const endedAt = new Date().toISOString();
  const cardsStudied = sessionStats.again + sessionStats.hard + sessionStats.good + sessionStats.easy;
  if (!cardsStudied && !sessionStats.skipped) return;
  setSessionSaved(true);
  api.createStudySession({
    deckId,
    startedAt: startedAt.current,
    endedAt,
    durationSeconds: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt.current)) / 1000)),
    cardsStudied,
    cardsCorrect: sessionStats.good + sessionStats.easy,
    newCards: 0,
    reviewCards: cardsStudied,
    metadata: {
      ratings: sessionStats,
      modeLabel
    }
  }).catch(() => undefined);
}, [deckId, done, modeLabel, queue.length, sessionSaved, sessionStats]);
```

- [ ] **Step 5: Add responsive and skip styles**

In `src/styles.css`, add:

```css
.study-skip {
  margin-left: auto;
}

.rating-skipped {
  border-color: #cbd5e1;
  background: #f8fafc;
  color: #475569;
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  padding: 4px 8px;
}

@media (max-width: 640px) {
  .study-overlay {
    align-items: stretch;
    padding: 0;
  }

  .study-panel {
    min-height: 100vh;
    max-width: none;
    border-radius: 0;
    padding: 18px;
  }

  .study-meta {
    flex-wrap: wrap;
    gap: 8px;
  }

  .study-card {
    min-height: 46vh;
    padding: 18px;
  }

  .study-rating-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

- [ ] **Step 6: Run build and existing study route test**

Run:

```bash
npm test -- --test-name-pattern="study session API"
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit study UX**

Run:

```bash
git add src/api.ts src/StudyView.tsx src/styles.css server/routes.api.test.mjs
git commit -m "Make study sessions resumable in the learner's head" -m "Study mode now shows explicit card position, supports skipping without SM-2 penalty, and records a post-session rating breakdown to the existing study session API.

Constraint: Learners need visible progress and an option to defer a card without changing its score.
Rejected: Treating skip as Again | would penalize cards the learner intentionally deferred
Confidence: high
Scope-risk: narrow
Tested: npm test -- --test-name-pattern=\"study session API\"; npm run build"
```

---

### Task 7: Resolved Comment Threads

**Files:**
- Create: `supabase/migrations/20260507120000_comment_resolution.sql`
- Modify: `server/app.mjs`
- Modify: `server/routes.api.test.mjs`
- Modify: `src/api.ts`
- Modify: `src/SuggestionDiscussion.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Add migration**

Create `supabase/migrations/20260507120000_comment_resolution.sql`:

```sql
alter table public.comments
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by text;

create index if not exists comments_unresolved_thread_idx
  on public.comments (suggestion_id, resolved_at)
  where parent_id is null;
```

- [ ] **Step 2: Update comment reads and add resolve endpoint**

In `server/app.mjs`, change the comment select list:

```js
.select('id, author_id, author_name, body, parent_id, resolved_at, resolved_by, created_at, updated_at')
```

Map the response if Supabase returns snake case:

```js
res.json({ comments: (data || []).map((comment) => ({
  id: comment.id,
  authorId: comment.author_id,
  authorName: comment.author_name,
  body: comment.body,
  parentId: comment.parent_id,
  resolvedAt: comment.resolved_at || null,
  resolvedBy: comment.resolved_by || null,
  createdAt: comment.created_at,
  updatedAt: comment.updated_at
})) });
```

Add endpoint:

```js
app.patch('/api/suggestions/:id/comments/:commentId/resolved', auth.requireUser, resolveSuggestionDeck(auth.supabase), requireReviewer(auth.supabase), async (req, res, next) => {
  try {
    if (!auth.supabase) fail(501, 'comments_unavailable', 'Comments require Supabase');
    const resolved = Boolean(req.body.resolved);
    const values = resolved
      ? { resolved_at: new Date().toISOString(), resolved_by: req.user.id }
      : { resolved_at: null, resolved_by: null };
    const { data, error } = await auth.supabase.from('comments')
      .update(values)
      .eq('id', req.params.commentId)
      .eq('suggestion_id', req.params.id)
      .is('parent_id', null)
      .select('id, author_id, author_name, body, parent_id, resolved_at, resolved_by, created_at, updated_at')
      .single();
    if (error) fail(500, 'comment_resolve_error', error.message);
    res.json({
      comment: {
        id: data.id,
        authorId: data.author_id,
        authorName: data.author_name,
        body: data.body,
        parentId: data.parent_id,
        resolvedAt: data.resolved_at || null,
        resolvedBy: data.resolved_by || null,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }
    });
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Update API types and methods**

In `src/api.ts`, extend `Comment`:

```ts
resolvedAt: string | null;
resolvedBy: string | null;
```

Add method:

```ts
setResolved: (suggestionId: string, commentId: string, resolved: boolean) =>
  jsonRequest<{ comment: Comment }>(`/api/suggestions/${suggestionId}/comments/${commentId}/resolved`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved })
  })
```

- [ ] **Step 4: Visually differentiate resolved threads**

In `src/SuggestionDiscussion.tsx`, pass a resolver to `CommentItem` for top-level comments:

```tsx
onToggleResolved={() => toggleResolved(comment)}
```

Add function:

```ts
async function toggleResolved(comment: Comment) {
  try {
    const { comment: updated } = await api.comments.setResolved(suggestionId, comment.id, !comment.resolvedAt);
    setComments((prev) => prev.map((item) => item.id === updated.id ? updated : item));
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Unable to update thread status');
  }
}
```

Update `CommentItem` props:

```ts
onToggleResolved?: () => void;
```

Update root class:

```tsx
<div className={`comment ${comment.authorId === currentUserId ? 'own' : ''} ${comment.resolvedAt ? 'resolved' : 'active'}`}>
```

Add status and button in `.comment-meta`:

```tsx
<span className={`comment-status ${comment.resolvedAt ? 'resolved' : 'active'}`}>
  {comment.resolvedAt ? 'Resolved' : 'Active'}
</span>
{onToggleResolved && (
  <button className="comment-resolve-btn" onClick={onToggleResolved}>
    {comment.resolvedAt ? 'Reopen' : 'Resolve'}
  </button>
)}
```

- [ ] **Step 5: Add styles**

In `src/styles.css`, add:

```css
.comment.resolved {
  opacity: 0.72;
}

.comment.resolved .comment-body {
  border: 1px solid var(--border, #e5e7eb);
  background: var(--bg-secondary, #f8fafc);
}

.comment-status {
  border-radius: 999px;
  padding: 2px 7px;
  font-size: 0.68rem;
  font-weight: 800;
}

.comment-status.active {
  background: #eef6ff;
  color: #0b62ce;
}

.comment-status.resolved {
  background: #ecfdf5;
  color: #14734f;
}

.comment-resolve-btn {
  border: 0;
  background: transparent;
  color: var(--color-primary, #4f46e5);
  cursor: pointer;
  font-size: 0.74rem;
  font-weight: 700;
  padding: 0;
}
```

- [ ] **Step 6: Verify build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit resolved threads**

Run:

```bash
git add supabase/migrations/20260507120000_comment_resolution.sql server/app.mjs server/routes.api.test.mjs src/api.ts src/SuggestionDiscussion.tsx src/styles.css
git commit -m "Show which comment threads still need attention" -m "Top-level suggestion comments now carry resolved status through the API and render active versus resolved states in the reviewer discussion UI.

Constraint: Reviewers need to scan unresolved discussion threads quickly.
Rejected: Encoding resolved state only in comment text | makes filtering and visual status brittle
Confidence: medium
Scope-risk: moderate
Tested: npm run build
Not-tested: Supabase migration applied against hosted project"
```

---

### Task 8: Conflict Resolution Resumption

**Files:**
- Modify: `src/ConflictResolution.tsx`
- Modify: `src/styles.css`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add localStorage-backed decision state**

In `src/ConflictResolution.tsx`, replace imports:

```ts
import { useMemo, useState } from 'react';
```

Add type:

```ts
type Resolution = 'local' | 'incoming' | 'skip';
```

Inside `ConflictResolution()`, add:

```ts
const storageKey = `deckbridge_conflict_resolutions_${conflicts[0]?.deckId || 'global'}`;
const [savedResolutions, setSavedResolutions] = useState<Record<string, Resolution>>(() => {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
});
const unresolvedConflicts = useMemo(
  () => conflicts.filter((item) => !savedResolutions[item.id]),
  [conflicts, savedResolutions]
);
```

Replace:

```ts
const conflict = conflicts[index];
```

with:

```ts
const safeIndex = Math.min(index, Math.max(0, unresolvedConflicts.length - 1));
const conflict = unresolvedConflicts[safeIndex];
```

Replace display progress:

```tsx
<span className="conflict-progress">Conflict {safeIndex + 1} of {unresolvedConflicts.length}</span>
```

Add resolver:

```ts
function resolveCurrent(resolution: Resolution) {
  if (!conflict) return;
  const next = { ...savedResolutions, [conflict.id]: resolution };
  setSavedResolutions(next);
  localStorage.setItem(storageKey, JSON.stringify(next));
  onResolve(conflict.id, resolution);
  if (safeIndex < unresolvedConflicts.length - 1) setIndex(safeIndex + 1);
}
```

Replace each button handler with:

```tsx
onClick={() => resolveCurrent('local')}
```

and:

```tsx
onClick={() => resolveCurrent('incoming')}
```

and:

```tsx
onClick={() => resolveCurrent('skip')}
```

- [ ] **Step 2: Add resume status and clear button**

After the conflict header small text, add:

```tsx
{Object.keys(savedResolutions).length > 0 && (
  <button
    className="conflict-clear-progress"
    onClick={() => {
      setSavedResolutions({});
      localStorage.removeItem(storageKey);
      setIndex(0);
    }}
  >
    Clear saved progress
  </button>
)}
```

If all conflicts are saved, return:

```tsx
if (!conflict) {
  return (
    <div className="conflict-panel">
      <div className="conflict-header">
        <strong>Conflict progress saved</strong>
        <small>{Object.keys(savedResolutions).length} decision(s) saved locally.</small>
      </div>
      <button
        className="button secondary"
        onClick={() => {
          setSavedResolutions({});
          localStorage.removeItem(storageKey);
          setIndex(0);
        }}
      >
        Review again
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Add styles**

In `src/styles.css`, add:

```css
.conflict-clear-progress {
  border: 0;
  background: transparent;
  color: var(--color-primary, #4f46e5);
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 700;
  padding: 0;
}

@media (max-width: 760px) {
  .conflict-panel {
    border-radius: 0;
    margin-inline: -16px;
  }

  .conflict-field {
    grid-template-columns: 1fr;
  }

  .conflict-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: Verify build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit conflict resumption**

Run:

```bash
git add src/ConflictResolution.tsx src/styles.css src/App.tsx
git commit -m "Preserve conflict decisions across tab closes" -m "Conflict triage now records local decisions per deck so reviewers can resume long conflict batches without losing progress.

Constraint: Conflict resolution can involve dozens of Anki-card conflicts.
Rejected: Server persistence for the first pass | larger schema and merge semantics than needed to prevent local tab-close data loss
Confidence: medium
Scope-risk: narrow
Tested: npm run build"
```

---

### Task 9: Extract Inline Views From App

**Files:**
- Create: `src/views/StudyPrepView.tsx`
- Create: `src/views/DeckStatsView.tsx`
- Create: `src/views/DeckSettingsView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/api.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Create StudyPrepView module**

Create `src/views/StudyPrepView.tsx`:

```tsx
interface StudyPrepViewProps {
  totalCards: number;
  studyCards: number;
  approvedCards: number;
  pendingBlocked: number;
  approvedOnly: boolean;
  onApprovedOnlyChange: (value: boolean) => void;
  onStart: () => void;
}

export function StudyPrepView({
  totalCards,
  studyCards,
  approvedCards,
  pendingBlocked,
  approvedOnly,
  onApprovedOnlyChange,
  onStart
}: StudyPrepViewProps) {
  return (
    <div className="tab-panel study-prep">
      <div>
        <h2>Study session</h2>
        <p>Start a due-card session with local SM-2 progress and server sync when authentication is available.</p>
      </div>
      <div className="stat-grid compact">
        <div><small>Available now</small><strong>{studyCards.toLocaleString()}</strong></div>
        <div><small>Approved cards</small><strong>{approvedCards.toLocaleString()}</strong></div>
        <div><small>All cards</small><strong>{totalCards.toLocaleString()}</strong></div>
        <div><small>Pending review</small><strong>{pendingBlocked.toLocaleString()}</strong></div>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={approvedOnly}
          onChange={(event) => onApprovedOnlyChange(event.target.checked)}
        />
        <span>
          <strong>Study approved cards only</strong>
          <small>Excludes suspended cards and cards with pending owner-review suggestions.</small>
        </span>
      </label>
      <div className="panel-actions">
        <button className="button primary" onClick={onStart} disabled={studyCards === 0}>Start study session</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create DeckStatsView module**

Create `src/views/DeckStatsView.tsx`:

```tsx
import type { Deck, DeckSummary } from '../types';

const statusColors: Record<string, string> = {
  New: 'blue',
  Learning: 'yellow',
  Review: 'green',
  Suspended: 'red',
  Anki: 'neutral'
};

interface DeckStatsViewProps {
  deck: Deck;
  summary?: DeckSummary;
  suggestions: { total: number; accepted: number; rejected: number; pending: number; revision: number; acceptanceRate: number };
  filteredCount: number;
}

export function DeckStatsView({ deck, summary, suggestions, filteredCount }: DeckStatsViewProps) {
  const stateCounts = deck.cards.reduce<Record<string, number>>((acc, card) => {
    acc[card.state] = (acc[card.state] || 0) + 1;
    return acc;
  }, {});
  const suspended = deck.cards.filter((card) => card.suspended).length;
  const noteTypes = summary?.noteTypes?.length ? summary.noteTypes : Array.from(new Set(deck.cards.map((card) => card.type)));

  return (
    <div className="tab-panel stats-view">
      <div>
        <h2>Deck stats</h2>
        <p>First-pass operational totals from the loaded deck state.</p>
      </div>
      <div className="stat-grid">
        <div><small>Cards</small><strong>{deck.cards.length.toLocaleString()}</strong></div>
        <div><small>Filtered cards</small><strong>{filteredCount.toLocaleString()}</strong></div>
        <div><small>Tags</small><strong>{summary?.tagCount.toLocaleString() ?? '0'}</strong></div>
        <div><small>Note types</small><strong>{noteTypes.length.toLocaleString()}</strong></div>
        <div><small>Suspended</small><strong>{suspended.toLocaleString()}</strong></div>
        <div><small>Acceptance rate</small><strong>{suggestions.acceptanceRate}%</strong></div>
      </div>
      <div className="stats-columns">
        <section>
          <h3>Card states</h3>
          <div className="state-bar-wrap">
            {Object.entries(stateCounts).map(([st, count]) => {
              const pct = deck.cards.length ? Math.round((count / deck.cards.length) * 100) : 0;
              const color = (statusColors[st] || 'neutral');
              return (
                <div className="state-bar-row" key={st}>
                  <span title={st}>{st}</span>
                  <div className="state-bar-track">
                    <div className={`state-bar-fill ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                  <strong>{count}</strong>
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <h3>Suggestion flow</h3>
          <div className="metric-row"><span>Pending</span><strong>{suggestions.pending}</strong></div>
          <div className="metric-row"><span>Accepted</span><strong>{suggestions.accepted}</strong></div>
          <div className="metric-row"><span>Rejected</span><strong>{suggestions.rejected}</strong></div>
          <div className="metric-row"><span>Needs revision</span><strong>{suggestions.revision}</strong></div>
        </section>
        <section>
          <h3>Note types</h3>
          <div className="tag-list wide">
            {noteTypes.map((type) => <em key={type}>{type}</em>)}
          </div>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create DeckSettingsView module**

Create `src/views/DeckSettingsView.tsx` by moving the existing `DeckSettingsView` function from `src/App.tsx` unchanged, then add these imports at the top:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { api, type ShareLink, type DeckInvite } from '../api';
import type { Deck } from '../types';
```

Use this exported prop type:

```tsx
interface DeckSettingsViewProps {
  deck: Deck;
  visibility: string;
  canReview: boolean;
  embedCode: string;
  copiedShare: string;
  onCopied: (value: string) => void;
  onSetVisibility: (value: 'public' | 'private' | 'unlisted') => void;
}
```

Keep these local helpers in the same file because the settings view owns share-link display:

```tsx
function shareLinkUrl(token: string) {
  return `${window.location.origin}/share/${token}`;
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}
```

Inside the moved component, replace calls to the old `copy()` helper if needed:

```ts
await copyText(value);
onCopied(label);
window.setTimeout(() => onCopied(''), 1800);
```

- [ ] **Step 4: Remove inline components and import modules**

In `src/App.tsx`, add imports:

```tsx
import { DeckSettingsView } from './views/DeckSettingsView';
import { DeckStatsView } from './views/DeckStatsView';
import { StudyPrepView } from './views/StudyPrepView';
```

Delete the inline `StudyPrepView`, `DeckStatsView`, and `DeckSettingsView` function declarations from `src/App.tsx`.

Keep `DiffBlock`, `ToastStack`, and small helpers in `src/App.tsx` for now because they are still tightly coupled to the main review panel.

- [ ] **Step 5: Run build after each extraction**

Run after extracting each file:

```bash
npm run build
```

Expected: PASS after `StudyPrepView`, PASS after `DeckStatsView`, PASS after `DeckSettingsView`.

- [ ] **Step 6: Commit extraction**

Run:

```bash
git add src/App.tsx src/views/StudyPrepView.tsx src/views/DeckStatsView.tsx src/views/DeckSettingsView.tsx src/api.ts src/types.ts
git commit -m "Move deck subviews out of App" -m "The study prep, stats, and settings panels now live in focused modules while preserving their props and rendered behavior.

Constraint: App.tsx is difficult to navigate with large inline view components.
Rejected: A broad App rewrite | unnecessary risk while extracting three self-contained components
Confidence: high
Scope-risk: narrow
Tested: npm run build"
```

---

### Task 10: Frontend SM-2 Tests

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vite.config.ts`
- Create: `src/sm2.test.ts`

- [ ] **Step 1: Install Vitest**

Run:

```bash
npm install -D vitest jsdom
```

Expected: `package.json` and `package-lock.json` update.

- [ ] **Step 2: Add test script and Vite test config**

In `package.json`, add:

```json
"test:frontend": "vitest run"
```

In `vite.config.ts`, replace the file with:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4175',
      '/downloads': 'http://localhost:4175'
    }
  },
  test: {
    environment: 'jsdom',
    globals: true
  }
});
```

- [ ] **Step 3: Write SM-2 unit tests**

Create `src/sm2.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRating, buildStudyQueue, initialProgress, loadProgress, saveProgress } from './sm2';

describe('sm2 progress scoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('resets repetitions and interval for Again without dropping below minimum ease', () => {
    const previous = {
      ...initialProgress('card-1'),
      interval: 12,
      easeFactor: 1.31,
      repetitions: 4
    };

    const next = applyRating(previous, 1);

    expect(next.interval).toBe(1);
    expect(next.repetitions).toBe(0);
    expect(next.easeFactor).toBe(1.3);
    expect(next.lastRating).toBe(1);
    expect(next.nextDue.startsWith('2026-05-08')).toBe(true);
  });

  it('advances first Good review to one day and records rating', () => {
    const next = applyRating(initialProgress('card-2'), 3);

    expect(next.interval).toBe(1);
    expect(next.repetitions).toBe(1);
    expect(next.lastRating).toBe(3);
    expect(next.nextDue.startsWith('2026-05-08')).toBe(true);
  });

  it('extends mature Easy reviews more than Good reviews', () => {
    const mature = {
      ...initialProgress('card-3'),
      interval: 10,
      easeFactor: 2.5,
      repetitions: 3
    };

    const good = applyRating(mature, 3);
    const easy = applyRating(mature, 4);

    expect(good.interval).toBe(25);
    expect(easy.interval).toBe(33);
    expect(easy.easeFactor).toBeGreaterThan(good.easeFactor);
  });

  it('builds queue from due cards sorted by due date', () => {
    const dueYesterday = { ...initialProgress('a'), nextDue: '2026-05-06T12:00:00.000Z' };
    const dueToday = { ...initialProgress('b'), nextDue: '2026-05-07T11:00:00.000Z' };
    const dueTomorrow = { ...initialProgress('c'), nextDue: '2026-05-08T12:00:00.000Z' };

    expect(buildStudyQueue(['b', 'c', 'a'], { a: dueYesterday, b: dueToday, c: dueTomorrow })).toEqual(['a', 'b']);
  });

  it('persists and loads deck progress from localStorage', () => {
    const progress = { card: applyRating(initialProgress('card'), 4) };
    saveProgress('deck-1', progress);

    expect(loadProgress('deck-1').card.lastRating).toBe(4);
  });
});
```

- [ ] **Step 4: Run frontend tests**

Run:

```bash
npm run test:frontend
```

Expected: PASS.

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit frontend tests**

Run:

```bash
git add package.json package-lock.json vite.config.ts src/sm2.test.ts
git commit -m "Lock study scoring with frontend tests" -m "Vitest now covers SM-2 rating transitions, due-card queue ordering, and local progress persistence.

Constraint: A scoring regression silently damages study quality.
Rejected: Browser-only E2E coverage for SM-2 | too indirect for pure scoring logic
Confidence: high
Scope-risk: narrow
Tested: npm run test:frontend; npm run build"
```

---

### Task 11: Accessibility Fixes For Critical Controls

**Files:**
- Modify: `src/CardEditor.tsx`
- Modify: `src/ConflictResolution.tsx`
- Modify: `src/StudyView.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Add ARIA labels to formatting toolbar**

In `src/CardEditor.tsx`, replace `FormattingToolbar` return with:

```tsx
return (
  <div className="format-toolbar" role="toolbar" aria-label="Formatting tools">
    <button type="button" aria-label="Bold selected text" title="Bold" onClick={() => wrapSelection('**', '**')}><b aria-hidden="true">B</b></button>
    <button type="button" aria-label="Italicize selected text" title="Italic" onClick={() => wrapSelection('*', '*')}><i aria-hidden="true">I</i></button>
    <button type="button" aria-label="Turn selected text into a list item" title="List" onClick={() => wrapSelection('- ', '')}>List</button>
    <button type="button" aria-label="Wrap selected text in Anki cloze markup" title="Cloze" onClick={() => wrapSelection('{{c1::', '}}')}>{'{{}}'}</button>
    <button type="button" aria-label="Wrap selected text as inline code" title="Code" onClick={() => wrapSelection('`', '`')}>{'<>'}</button>
  </div>
);
```

- [ ] **Step 2: Improve conflict diff semantics**

In `src/ConflictResolution.tsx`, change the diff container:

```tsx
<div className="conflict-diff" role="group" aria-label="Conflict field differences">
```

For each side, add labels:

```tsx
<div className="conflict-side conflict-side-local" aria-label={`Local ${key}`}>
```

and:

```tsx
<div className="conflict-side conflict-side-incoming" aria-label={`Incoming ${key}`}>
```

Add keyboard shortcuts on buttons:

```tsx
aria-label="Keep local version for this conflict"
```

```tsx
aria-label="Keep incoming Anki version for this conflict"
```

```tsx
aria-label="Skip this conflict for now"
```

- [ ] **Step 3: Strengthen StudyView dialog and live progress**

In `src/StudyView.tsx`, update overlay:

```tsx
<div className="study-overlay" role="dialog" aria-modal="true" aria-labelledby="study-title">
```

Add an offscreen heading inside `.study-panel`:

```tsx
<h2 id="study-title" className="sr-only">Study mode</h2>
```

Update progress bar:

```tsx
<div className="study-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={queue.length} aria-valuenow={queueIndex}>
```

Update the progress fraction:

```tsx
<span aria-live="polite">Card {totalSeen} of {queue.length}</span>
```

- [ ] **Step 4: Add focus-visible CSS**

In `src/styles.css`, add:

```css
.format-toolbar button:focus-visible,
.conflict-actions button:focus-visible,
.study-rate-btn:focus-visible,
.study-skip:focus-visible {
  outline: 2px solid var(--color-primary, #4f46e5);
  outline-offset: 2px;
}
```

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit accessibility fixes**

Run:

```bash
git add src/CardEditor.tsx src/ConflictResolution.tsx src/StudyView.tsx src/styles.css
git commit -m "Name critical controls for assistive tech" -m "Formatting, conflict triage, and study controls now expose labels, dialog semantics, live progress, and visible keyboard focus.

Constraint: Toolbar, diff panes, and study modal are high-frequency controls for keyboard and screen-reader users.
Rejected: Adding visual-only helper text | does not improve screen-reader semantics
Confidence: medium
Scope-risk: narrow
Tested: npm run build
Not-tested: Manual screen-reader pass"
```

---

### Task 12: Mobile Layout Hardening

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add responsive CSS for card editor, conflict panel, and study view**

Append to `src/styles.css`:

```css
@media (max-width: 760px) {
  .card-table {
    min-width: 0;
  }

  .table-row.editing {
    margin-inline: -12px;
  }

  .card-editor {
    border-radius: 0;
    border-left: 0;
    border-right: 0;
    padding: 14px;
  }

  .card-editor-header,
  .card-editor-footer,
  .card-editor-actions,
  .bulk-toolbar,
  .bulk-tag-form,
  .bulk-confirm {
    align-items: stretch;
    flex-direction: column;
  }

  .card-editor-actions,
  .card-editor-actions .btn,
  .bulk-toolbar .button,
  .bulk-tag-input {
    width: 100%;
  }

  .format-toolbar {
    overflow-x: auto;
  }

  .conflict-diff {
    gap: 10px;
  }

  .conflict-side {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .study-stats-grid {
    grid-template-columns: 1fr;
  }

  .study-rating-breakdown {
    align-items: stretch;
    flex-direction: column;
  }
}
```

- [ ] **Step 2: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Manual browser smoke**

Run the app:

```bash
npm run dev
```

Open `http://localhost:5174`, switch browser device width to `390x844`, and verify:

- Study mode fills the screen without clipped rating buttons.
- Card editor fields fit within the viewport.
- Conflict diff columns stack and remain readable.

Stop the dev server with `Ctrl+C`.

- [ ] **Step 4: Commit mobile CSS**

Run:

```bash
git add src/styles.css
git commit -m "Make study and review tools usable on phones" -m "Study mode, conflict triage, and card editing now collapse controls and panels for narrow viewports.

Constraint: Anki users commonly study from mobile-sized screens.
Rejected: A separate mobile-only UI | duplicates workflows and increases maintenance cost
Confidence: medium
Scope-risk: narrow
Tested: npm run build
Not-tested: Physical mobile device"
```

---

## Final Verification

- [ ] **Step 1: Run backend tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

```bash
npm run test:frontend
```

Expected: PASS.

- [ ] **Step 3: Run Anki add-on tests**

```bash
python -m unittest addons.deckbridge_sync.tests.test_addon
```

Expected: PASS.

- [ ] **Step 4: Run production build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Package add-on**

```bash
npm run package:anki-addon
```

Expected: `dist/deckbridge-sync.ankiaddon` is created.

- [ ] **Step 6: Inspect changed files**

```bash
git status --short
git diff --stat
```

Expected: only files from this plan are changed.

## Self-Review

**Spec coverage:**
- Security items 1-4: Tasks 1 and 2 cover scrypt password hashing, email validation tests, role allowlist, deck ID validation, and route-level tests.
- Missing features 5-8: Tasks 2, 4, 5, and 3 cover rate limiting, bulk suggestion decisions, media sync, and notification pagination.
- Study UX 9-11: Task 6 covers fraction progress, post-session breakdown persistence, and skip.
- Collaboration UX 12-13: Tasks 7 and 8 cover resolved comment status and local conflict-resolution resumption.
- Code quality 14-16: Tasks 9, 10, and Task 1/3 notes cover component extraction, frontend SM-2 tests, and analytics cache protection.
- Accessibility 17: Task 11 covers ARIA labels and keyboard/focus semantics for toolbar, conflict diff, and study dialog.
- Mobile layout 18: Task 12 covers responsive breakpoints for `CardEditor`, `ConflictResolution`, and `StudyView`.

**Placeholder scan:** No task uses open-ended implementation instructions. Each code-changing task gives exact files, snippets, commands, and expected verification.

**Type consistency:** `DemoRole` becomes `MembershipRole`, `api.bulkDecideSuggestions()` returns `AppState`, comment resolution fields are `resolvedAt` and `resolvedBy`, and media assets consistently use `{ filename, mimeType, sha256, dataBase64 }`.
