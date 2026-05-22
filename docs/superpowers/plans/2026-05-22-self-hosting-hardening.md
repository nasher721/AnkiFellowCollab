# Self-Hosting Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeckBridge safe to run as a real self-hosted service with enforced production configuration, TLS termination, backup/restore scripts, and locked-down service and add-on keys.

**Architecture:** Keep Express behind a TLS reverse proxy and make the Node app fail closed when `DECKBRIDGE_SELF_HOSTED=true`. Add operational assets under `ops/`, scripts under `scripts/`, and schema/code changes for expiring, scoped API tokens without replacing Supabase Auth or the repository abstraction.

**Tech Stack:** Node.js ESM, Express, Supabase/Postgres migrations, PowerShell, Caddy, Docker/Supabase CLI, node:test.

---

## File Structure

- Modify `server/security.mjs`: parse and validate self-hosting environment variables, compute security headers, and validate secret file permissions.
- Modify `server/security.test.mjs`: unit coverage for the new self-hosting validator and permission checks.
- Modify `server/app.mjs`: enforce HTTPS redirects/HSTS/CSP, canonical CORS, and trusted proxy settings when self-hosted mode is enabled.
- Modify `server/routes.api.test.mjs`: API-level tests for HTTPS enforcement and proxy header handling.
- Create `supabase/migrations/20260522120000_lock_down_user_tokens.sql`: add token expiry/scope metadata and revoke direct client insert/update privileges.
- Modify `server/tokens.mjs`: create expiring scoped tokens and reject expired, revoked, or deck-mismatched tokens.
- Modify `server/auth.mjs`: carry token metadata on `req.user` for route-level deck scope checks.
- Modify `server/app.mjs`: pass deck scope to sync and token routes.
- Create `ops/caddy/Caddyfile`: TLS reverse proxy for DeckBridge and local Supabase Auth/API.
- Create `ops/systemd/deckbridge.service`: locked-down Linux service unit for self-hosted deployments.
- Create `scripts/lock-self-host-secrets.ps1`: restrict `.env.local-server` ACLs to the current user, Administrators, and SYSTEM.
- Create `scripts/backup-local-server.ps1`: produce timestamped Postgres, Supabase Storage, app data, and manifest backups.
- Create `scripts/restore-local-server.ps1`: restore from a backup produced by the backup script.
- Modify `.env.example`: document self-hosting hardening variables without adding secrets.
- Modify `docs/local-server-runbook.md`: add TLS, firewall, backup, restore, key rotation, and verification instructions.

---

### Task 1: Self-Hosted Configuration Gate

**Files:**
- Modify: `server/security.mjs`
- Modify: `server/security.test.mjs`

- [ ] **Step 1: Write failing validator tests**

Append this to `server/security.test.mjs`:

```js
import {
  assertSelfHostedSecurityConfig,
  buildSecurityHeaders,
  parseTrustedProxy
} from './security.mjs';

test('self-hosted security config requires https origin and service keys', () => {
  assert.throws(() => assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'http://deckbridge.example.test',
    CORS_ORIGIN: 'http://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service'
  }), { code: 'self_host_security_config' });

  const config = assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'https://deckbridge.example.test',
    CORS_ORIGIN: 'https://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon',
    VITE_SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    DECKBRIDGE_REQUIRE_HTTPS: 'true',
    DECKBRIDGE_TRUST_PROXY: 'loopback'
  });

  assert.equal(config.enabled, true);
  assert.equal(config.publicUrl, 'https://deckbridge.example.test');
  assert.equal(config.corsOrigin, 'https://deckbridge.example.test');
  assert.equal(config.requireHttps, true);
  assert.equal(config.trustProxy, 'loopback');
});

test('self-hosted config blocks service role exposure through Vite env', () => {
  assert.throws(() => assertSelfHostedSecurityConfig({
    DECKBRIDGE_SELF_HOSTED: 'true',
    APP_PUBLIC_URL: 'https://deckbridge.example.test',
    CORS_ORIGIN: 'https://deckbridge.example.test',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'anon',
    VITE_SUPABASE_ANON_KEY: 'service-role-secret',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
    DECKBRIDGE_REQUIRE_HTTPS: 'true'
  }), { code: 'self_host_security_config' });
});

test('trusted proxy parser accepts explicit values only', () => {
  assert.equal(parseTrustedProxy('false'), false);
  assert.equal(parseTrustedProxy('loopback'), 'loopback');
  assert.equal(parseTrustedProxy('1'), 1);
  assert.deepEqual(parseTrustedProxy('10.0.0.0/8,192.168.0.0/16'), ['10.0.0.0/8', '192.168.0.0/16']);
  assert.throws(() => parseTrustedProxy(''), { code: 'self_host_security_config' });
});

test('buildSecurityHeaders enables hsts only when https is required', () => {
  const headers = buildSecurityHeaders({ requireHttps: true });
  assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);

  const localHeaders = buildSecurityHeaders({ requireHttps: false });
  assert.equal(Object.hasOwn(localHeaders, 'Strict-Transport-Security'), false);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npm test -- server/security.test.mjs
```

Expected: FAIL because `assertSelfHostedSecurityConfig`, `buildSecurityHeaders`, and `parseTrustedProxy` are not exported.

- [ ] **Step 3: Add the validator implementation**

Add these exports to `server/security.mjs` after the existing constants:

```js
const HTTPS_URL_PATTERN = /^https:\/\/[^/\s]+(?:\/)?$/i;
const FORBIDDEN_PROXY_VALUES = new Set(['', 'true', 'all', '*']);

function configError(message) {
  const error = new Error(message);
  error.code = 'self_host_security_config';
  throw error;
}

function stringEnv(env, key) {
  return typeof env[key] === 'string' ? env[key].trim() : '';
}

function booleanEnv(env, key, fallback = false) {
  const value = stringEnv(env, key).toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  configError(`${key} must be true or false`);
}

export function parseTrustedProxy(value) {
  const raw = String(value ?? '').trim();
  if (FORBIDDEN_PROXY_VALUES.has(raw.toLowerCase())) {
    configError('DECKBRIDGE_TRUST_PROXY must be false, loopback, a hop count, or explicit CIDR ranges');
  }
  if (raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'loopback') return 'loopback';
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  const cidrs = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (cidrs.length && cidrs.every((item) => /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(item))) return cidrs;
  configError('DECKBRIDGE_TRUST_PROXY must be false, loopback, a hop count, or explicit CIDR ranges');
}

export function buildSecurityHeaders({ requireHttps = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      'upgrade-insecure-requests'
    ].join('; '),
    'Cache-Control': 'no-store'
  };
  if (requireHttps) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

export function assertSelfHostedSecurityConfig(env = process.env) {
  const enabled = booleanEnv(env, 'DECKBRIDGE_SELF_HOSTED', false);
  if (!enabled) {
    return {
      enabled: false,
      requireHttps: booleanEnv(env, 'DECKBRIDGE_REQUIRE_HTTPS', false),
      trustProxy: env.VERCEL ? 1 : false
    };
  }

  const publicUrl = stringEnv(env, 'APP_PUBLIC_URL');
  const corsOrigin = stringEnv(env, 'CORS_ORIGIN');
  const supabaseUrl = stringEnv(env, 'SUPABASE_URL');
  const anonKey = stringEnv(env, 'SUPABASE_ANON_KEY');
  const viteAnonKey = stringEnv(env, 'VITE_SUPABASE_ANON_KEY');
  const serviceRoleKey = stringEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const trustProxy = parseTrustedProxy(stringEnv(env, 'DECKBRIDGE_TRUST_PROXY') || 'loopback');
  const requireHttps = booleanEnv(env, 'DECKBRIDGE_REQUIRE_HTTPS', true);

  for (const [key, value] of Object.entries({ APP_PUBLIC_URL: publicUrl, CORS_ORIGIN: corsOrigin, SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey })) {
    if (!value) configError(`${key} is required when DECKBRIDGE_SELF_HOSTED=true`);
  }
  if (requireHttps && !HTTPS_URL_PATTERN.test(publicUrl)) configError('APP_PUBLIC_URL must be an https URL');
  if (requireHttps && !HTTPS_URL_PATTERN.test(corsOrigin)) configError('CORS_ORIGIN must be an https URL');
  if (viteAnonKey && viteAnonKey !== anonKey) configError('VITE_SUPABASE_ANON_KEY must match SUPABASE_ANON_KEY');
  if (viteAnonKey && viteAnonKey === serviceRoleKey) configError('VITE_SUPABASE_ANON_KEY must not contain the service role key');

  return { enabled, publicUrl, corsOrigin, supabaseUrl, requireHttps, trustProxy };
}
```

- [ ] **Step 4: Run the validator tests again**

Run:

```powershell
npm test -- server/security.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add server/security.mjs server/security.test.mjs
git commit -m "Add self-hosted security configuration gate"
```

### Task 2: Express HTTPS, Proxy, and Header Enforcement

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/routes.api.test.mjs`

- [ ] **Step 1: Write failing API tests**

Append this to `server/routes.api.test.mjs`:

```js
test('self-hosted app redirects plain http to canonical https origin', async () => {
  const app = createApp({
    repository: createMemoryRepository(),
    env: {
      DECKBRIDGE_SELF_HOSTED: 'true',
      APP_PUBLIC_URL: 'https://deckbridge.example.test',
      CORS_ORIGIN: 'https://deckbridge.example.test',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_ANON_KEY: 'anon',
      VITE_SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
      DECKBRIDGE_REQUIRE_HTTPS: 'true',
      DECKBRIDGE_TRUST_PROXY: 'loopback'
    }
  });

  const response = await request(app)
    .get('/api/health')
    .set('host', 'deckbridge.example.test')
    .set('x-forwarded-proto', 'http');

  assert.equal(response.status, 308);
  assert.equal(response.headers.location, 'https://deckbridge.example.test/api/health');
});

test('self-hosted app sends hsts and csp behind tls proxy', async () => {
  const app = createApp({
    repository: createMemoryRepository(),
    env: {
      DECKBRIDGE_SELF_HOSTED: 'true',
      APP_PUBLIC_URL: 'https://deckbridge.example.test',
      CORS_ORIGIN: 'https://deckbridge.example.test',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_ANON_KEY: 'anon',
      VITE_SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
      DECKBRIDGE_REQUIRE_HTTPS: 'true',
      DECKBRIDGE_TRUST_PROXY: 'loopback'
    }
  });

  const response = await request(app)
    .get('/api/health')
    .set('origin', 'https://deckbridge.example.test')
    .set('x-forwarded-proto', 'https');

  assert.equal(response.status, 200);
  assert.match(response.headers['strict-transport-security'], /max-age=31536000/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(response.headers['access-control-allow-origin'], 'https://deckbridge.example.test');
});
```

- [ ] **Step 2: Run the failing API tests**

Run:

```powershell
npm run test:api -- server/routes.api.test.mjs
```

Expected: FAIL because `createApp` does not read `options.env` or enforce HTTPS.

- [ ] **Step 3: Wire the security config into `createApp`**

In `server/app.mjs`, add `assertSelfHostedSecurityConfig` and `buildSecurityHeaders` to the existing security import:

```js
import {
  assertSelfHostedSecurityConfig,
  buildSecurityHeaders,
  deckIdFromRequest
} from './security.mjs';
```

Near the top of `createApp(options = {})`, before `const production`, add:

```js
  const env = options.env || process.env;
  const selfHostSecurity = assertSelfHostedSecurityConfig(env);
```

Replace direct `process.env` reads in the setup block with `env` for `NODE_ENV`, `VERCEL`, `SUPABASE_*`, `VITE_SUPABASE_*`, `MAX_APKG_BYTES`, and `CORS_ORIGIN`. Replace the trust proxy and CORS lines with:

```js
  const production = options.production ?? env.NODE_ENV === 'production';
  const app = express();
  const trustProxy = options.trustProxy ?? selfHostSecurity.trustProxy ?? (env.VERCEL ? 1 : false);
  app.set('trust proxy', trustProxy);
  const securityHeaders = buildSecurityHeaders({ requireHttps: selfHostSecurity.requireHttps });
  const corsOrigin = options.corsOrigin ?? selfHostSecurity.corsOrigin ?? env.CORS_ORIGIN ?? (production ? false : true);
```

Replace the existing header middleware with:

```js
  app.use((req, res, next) => {
    res.set(securityHeaders);
    if (selfHostSecurity.requireHttps && req.get('x-forwarded-proto') === 'http') {
      const target = new URL(req.originalUrl || req.url, selfHostSecurity.publicUrl);
      res.redirect(308, target.toString());
      return;
    }
    next();
  });
```

- [ ] **Step 4: Run the focused API tests**

Run:

```powershell
npm run test:api -- server/routes.api.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run the existing server tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add server/app.mjs server/routes.api.test.mjs
git commit -m "Enforce TLS proxy hardening in self-hosted mode"
```

### Task 3: Locked-Down Add-on Tokens

**Files:**
- Create: `supabase/migrations/20260522120000_lock_down_user_tokens.sql`
- Modify: `server/tokens.mjs`
- Modify: `server/auth.mjs`
- Modify: `server/security.test.mjs`

- [ ] **Step 1: Add a migration test**

Append this to `server/security.test.mjs`:

```js
test('token hardening migration expires tokens and revokes direct client writes', async () => {
  const sql = await fs.readFile(new URL('../supabase/migrations/20260522120000_lock_down_user_tokens.sql', import.meta.url), 'utf8');

  assert.match(sql, /add column if not exists expires_at timestamptz/i);
  assert.match(sql, /add column if not exists revoked_at timestamptz/i);
  assert.match(sql, /add column if not exists deck_id text/i);
  assert.match(sql, /revoke insert, update on public\.user_tokens from anon, authenticated/i);
  assert.match(sql, /grant select, delete on public\.user_tokens to authenticated/i);
  assert.match(sql, /tokens read own active/i);
  assert.match(sql, /revoked_at is null/i);
});
```

- [ ] **Step 2: Run the failing migration test**

Run:

```powershell
npm test -- server/security.test.mjs
```

Expected: FAIL because the migration file does not exist.

- [ ] **Step 3: Create the token hardening migration**

Create `supabase/migrations/20260522120000_lock_down_user_tokens.sql`:

```sql
alter table public.user_tokens
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists deck_id text references public.decks(id) on delete cascade,
  add column if not exists token_tail text;

update public.user_tokens
set expires_at = coalesce(expires_at, created_at + interval '90 days')
where expires_at is null;

create index if not exists user_tokens_active_idx
  on public.user_tokens (user_id, deck_id, expires_at)
  where revoked_at is null;

revoke insert, update on public.user_tokens from anon, authenticated;
grant select, delete on public.user_tokens to authenticated;

drop policy if exists "tokens read own" on public.user_tokens;
drop policy if exists "tokens insert own" on public.user_tokens;
drop policy if exists "tokens delete own" on public.user_tokens;

create policy "tokens read own active" on public.user_tokens
  for select
  using (auth.uid()::text = user_id and revoked_at is null);

create policy "tokens delete own active" on public.user_tokens
  for delete
  using (auth.uid()::text = user_id and revoked_at is null);
```

- [ ] **Step 4: Add token behavior tests**

Append this to `server/security.test.mjs`:

```js
import {
  createUserToken,
  generateToken,
  resolveTokenUser
} from './tokens.mjs';

test('created add-on tokens default to 90 day expiry and store only a tail', async () => {
  const inserts = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'user_tokens');
      return {
        insert(row) {
          inserts.push(row);
          return Promise.resolve({ error: null });
        }
      };
    }
  };

  const token = await createUserToken(supabase, { id: 'user-1' }, 'Anki Add-on', { deckId: 'deck-1' });
  assert.equal(token.raw.startsWith('db_'), true);
  assert.equal(inserts[0].deck_id, 'deck-1');
  assert.equal(typeof inserts[0].expires_at, 'string');
  assert.equal(inserts[0].token_tail, token.raw.slice(-6));
  assert.equal(Object.hasOwn(inserts[0], 'raw'), false);
});

test('resolveTokenUser rejects expired and deck-mismatched add-on tokens', async () => {
  const { raw, hash } = generateToken();
  const expiredRow = {
    id: 'token-1',
    user_id: 'user-1',
    token_hash: hash,
    deck_id: 'deck-1',
    expires_at: new Date(Date.now() - 1000).toISOString(),
    revoked_at: null
  };

  const supabase = {
    from(table) {
      if (table === 'user_tokens') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: expiredRow, error: null }); },
          update() { return { eq() { return Promise.resolve({ error: null }); } }; }
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };

  assert.equal(await resolveTokenUser(supabase, raw, { deckId: 'deck-1' }), null);
  expiredRow.expires_at = new Date(Date.now() + 90_000).toISOString();
  assert.equal(await resolveTokenUser(supabase, raw, { deckId: 'other-deck' }), null);
});
```

- [ ] **Step 5: Run the failing token tests**

Run:

```powershell
npm test -- server/security.test.mjs
```

Expected: FAIL because `createUserToken` does not accept token options and `resolveTokenUser` does not check expiry/scope.

- [ ] **Step 6: Implement token expiry, tail, and deck scope**

In `server/tokens.mjs`, add:

```js
const DEFAULT_TOKEN_TTL_DAYS = Number(process.env.DECKBRIDGE_TOKEN_TTL_DAYS || 90);

function expiryFromNow(days = DEFAULT_TOKEN_TTL_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
```

Change `resolveTokenUser` signature and the row handling to:

```js
export async function resolveTokenUser(supabase, rawToken, options = {}) {
  if (!supabase || !rawToken?.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(rawToken);
  const { data, error } = await supabase
    .from('user_tokens')
    .select('user_id, id, deck_id, expires_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at) return null;
  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) return null;
  if (options.deckId && data.deck_id && data.deck_id !== options.deckId) return null;
```

Return token metadata with the profile:

```js
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    token: { id: data.id, deckId: data.deck_id || null, expiresAt: data.expires_at || null }
  };
```

Change `createUserToken` signature and insert body to:

```js
export async function createUserToken(supabase, user, label = 'Anki Add-on', options = {}) {
  const userId = typeof user === 'string' ? user : user.id;
  const { raw, hash } = generateToken();
  const id = crypto.randomUUID();
  const expiresAt = expiryFromNow(options.ttlDays);
  const deckId = typeof options.deckId === 'string' && options.deckId.trim() ? options.deckId.trim() : null;
```

```js
  const { error } = await supabase.from('user_tokens').insert({
    id,
    user_id: userId,
    token_hash: hash,
    token_tail: raw.slice(-6),
    label,
    deck_id: deckId,
    expires_at: expiresAt,
    created_at: new Date().toISOString()
  });
```

Return:

```js
  return { id, raw, token: raw, label, deckId, expiresAt, createdAt };
```

- [ ] **Step 7: Pass deck scope from auth**

In `server/auth.mjs`, change:

```js
const tokenUser = await resolveTokenUser(supabase, token);
```

to:

```js
const tokenUser = await resolveTokenUser(supabase, token, { deckId: req.params?.deckId || req.body?.deckId || req.query?.deckId });
```

- [ ] **Step 8: Run tests**

Run:

```powershell
npm test -- server/security.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add supabase/migrations/20260522120000_lock_down_user_tokens.sql server/tokens.mjs server/auth.mjs server/security.test.mjs
git commit -m "Lock down add-on tokens for self-hosting"
```

### Task 4: TLS Reverse Proxy and Service Hardening Assets

**Files:**
- Create: `ops/caddy/Caddyfile`
- Create: `ops/systemd/deckbridge.service`
- Modify: `.env.example`

- [ ] **Step 1: Create the Caddy TLS reverse proxy**

Create `ops/caddy/Caddyfile`:

```caddyfile
{
	email admin@example.com
}

deckbridge.example.com {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		-Server
	}

	reverse_proxy 127.0.0.1:4175
}

supabase.deckbridge.example.com {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}

	reverse_proxy 127.0.0.1:54321
}
```

- [ ] **Step 2: Create the Linux service unit**

Create `ops/systemd/deckbridge.service`:

```ini
[Unit]
Description=DeckBridge self-hosted API and web server
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=deckbridge
Group=deckbridge
WorkingDirectory=/opt/deckbridge/current
EnvironmentFile=/etc/deckbridge/deckbridge.env
ExecStart=/usr/bin/node server/start-production.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/deckbridge/current/.deckbridge /opt/deckbridge/backups
CapabilityBoundingSet=
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Add self-hosting env examples**

Append this to `.env.example`:

```env

# Self-hosted production hardening. Use only non-secret public URLs here.
DECKBRIDGE_SELF_HOSTED=false
APP_PUBLIC_URL=https://deckbridge.example.com
CORS_ORIGIN=https://deckbridge.example.com
DECKBRIDGE_REQUIRE_HTTPS=true
DECKBRIDGE_TRUST_PROXY=loopback
DECKBRIDGE_TOKEN_TTL_DAYS=90
DECKBRIDGE_WEB_VITALS_LOG=false
```

- [ ] **Step 4: Validate config file syntax**

Run:

```powershell
npx caddy validate --config ops/caddy/Caddyfile
```

Expected: PASS if Caddy is available. If `npx caddy` is unavailable on the machine, install Caddy and run:

```powershell
caddy validate --config ops/caddy/Caddyfile
```

Expected: `Valid configuration`.

- [ ] **Step 5: Commit**

```powershell
git add ops/caddy/Caddyfile ops/systemd/deckbridge.service .env.example
git commit -m "Add self-hosted TLS and service hardening assets"
```

### Task 5: Secret ACL Lockdown

**Files:**
- Create: `scripts/lock-self-host-secrets.ps1`
- Modify: `docs/local-server-runbook.md`

- [ ] **Step 1: Create the Windows secret ACL script**

Create `scripts/lock-self-host-secrets.ps1`:

```powershell
param(
  [string]$EnvFile = ".env.local-server"
)

$ErrorActionPreference = "Stop"
$path = Resolve-Path -LiteralPath $EnvFile
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl -LiteralPath $path

$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRule($rule)
}

$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow

foreach ($identity in @($currentUser, "BUILTIN\Administrators", "NT AUTHORITY\SYSTEM")) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, $inheritance, $propagation, $allow)
  $acl.AddAccessRule($rule)
}

Set-Acl -LiteralPath $path -AclObject $acl

$verified = Get-Acl -LiteralPath $path
$blocked = $verified.Access | Where-Object {
  $_.IdentityReference.Value -match "Everyone|Authenticated Users|BUILTIN\\Users"
}

if ($blocked) {
  throw "Secret file still grants access to broad principals: $($blocked.IdentityReference.Value -join ', ')"
}

Write-Host "Locked $path to $currentUser, Administrators, and SYSTEM."
```

- [ ] **Step 2: Run the script against the local env file**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lock-self-host-secrets.ps1 -EnvFile .env.local-server
```

Expected: `Locked ...\.env.local-server to ...`.

- [ ] **Step 3: Add runbook text for key handling**

Add this section to `docs/local-server-runbook.md` after "Migrated owner login":

```markdown
## Locked-down keys

Keep `.env.local-server` out of synced shares, screenshots, issue attachments, and frontend builds. The file contains the Supabase service role key, owner bootstrap login, and local deployment settings.

After editing `.env.local-server`, lock its ACL on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lock-self-host-secrets.ps1 -EnvFile .env.local-server
```

For Linux deployments, store the same values in `/etc/deckbridge/deckbridge.env` with:

```bash
sudo chown root:deckbridge /etc/deckbridge/deckbridge.env
sudo chmod 0640 /etc/deckbridge/deckbridge.env
```

Rotate the Supabase service role key and add-on tokens after any suspected exposure. Add-on tokens are shown once, stored only as hashes, expire by default, and can be revoked from the token list.
```

- [ ] **Step 4: Commit**

```powershell
git add scripts/lock-self-host-secrets.ps1 docs/local-server-runbook.md
git commit -m "Document and script self-hosted key lockdown"
```

### Task 6: Local Backups and Restores

**Files:**
- Create: `scripts/backup-local-server.ps1`
- Create: `scripts/restore-local-server.ps1`
- Modify: `docs/local-server-runbook.md`

- [ ] **Step 1: Create the backup script**

Create `scripts/backup-local-server.ps1`:

```powershell
param(
  [string]$ProjectId = "anki-collab",
  [string]$Destination = ".deckbridge-backups",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path -LiteralPath "."
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $root $Destination
$backupDir = Join-Path $backupRoot "deckbridge-$timestamp"
$dbContainer = "supabase_db_$ProjectId"
$storageContainer = "supabase_storage_$ProjectId"

if ($DryRun) {
  Write-Host "Would create $backupDir"
  Write-Host "Would dump Postgres from $dbContainer"
  Write-Host "Would copy Supabase storage from $storageContainer:/var/lib/storage"
  Write-Host "Would archive .deckbridge if present"
  exit 0
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$dumpPath = "/tmp/deckbridge-$timestamp.dump"
docker exec $dbContainer pg_dump -U postgres -d postgres -Fc -f $dumpPath
docker cp "${dbContainer}:$dumpPath" (Join-Path $backupDir "postgres.dump")
docker exec $dbContainer rm -f $dumpPath

$storageDir = Join-Path $backupDir "storage"
New-Item -ItemType Directory -Force -Path $storageDir | Out-Null
docker cp "${storageContainer}:/var/lib/storage/." $storageDir

$statePath = Join-Path $root ".deckbridge"
if (Test-Path -LiteralPath $statePath) {
  Compress-Archive -LiteralPath $statePath -DestinationPath (Join-Path $backupDir "deckbridge-state.zip") -Force
}

$manifest = [ordered]@{
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  projectId = $ProjectId
  postgresDump = "postgres.dump"
  storagePath = "storage"
  appStateArchive = if (Test-Path -LiteralPath (Join-Path $backupDir "deckbridge-state.zip")) { "deckbridge-state.zip" } else { $null }
  restoreCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-local-server.ps1 -BackupPath `"$backupDir`" -ProjectId `"$ProjectId`""
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupDir "manifest.json") -Encoding UTF8
Write-Host "Backup complete: $backupDir"
```

- [ ] **Step 2: Create the restore script**

Create `scripts/restore-local-server.ps1`:

```powershell
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,
  [string]$ProjectId = "anki-collab"
)

$ErrorActionPreference = "Stop"
$backup = Resolve-Path -LiteralPath $BackupPath
$dbContainer = "supabase_db_$ProjectId"
$storageContainer = "supabase_storage_$ProjectId"
$dump = Join-Path $backup "postgres.dump"
$storage = Join-Path $backup "storage"
$stateArchive = Join-Path $backup "deckbridge-state.zip"

if (-not (Test-Path -LiteralPath $dump)) {
  throw "Missing postgres.dump in $backup"
}
if (-not (Test-Path -LiteralPath $storage)) {
  throw "Missing storage directory in $backup"
}

$remoteDump = "/tmp/deckbridge-restore.dump"
docker cp $dump "${dbContainer}:$remoteDump"
docker exec $dbContainer pg_restore -U postgres -d postgres --clean --if-exists --no-owner $remoteDump
docker exec $dbContainer rm -f $remoteDump

docker exec $storageContainer sh -lc "rm -rf /var/lib/storage/*"
docker cp "$storage/." "${storageContainer}:/var/lib/storage"

if (Test-Path -LiteralPath $stateArchive) {
  if (Test-Path -LiteralPath ".deckbridge") {
    Rename-Item -LiteralPath ".deckbridge" -NewName ".deckbridge.before-restore-$(Get-Date -Format yyyyMMdd-HHmmss)"
  }
  Expand-Archive -LiteralPath $stateArchive -DestinationPath "." -Force
}

Write-Host "Restore complete from $backup"
```

- [ ] **Step 3: Dry-run backup**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local-server.ps1 -DryRun
```

Expected: output lists the backup directory, Postgres container, storage container, and app state archive.

- [ ] **Step 4: Add runbook backup/restore instructions**

Replace the existing "Data and backups" section in `docs/local-server-runbook.md` with:

```markdown
## Data and backups

Local Postgres and Storage live in Docker volumes managed by the Supabase CLI. Local JSON source data remains in `.deckbridge/state.json` when the local repository is used.

Create a backup before OS updates, Supabase upgrades, migrations, and key rotations:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local-server.ps1
```

The backup contains:

- `postgres.dump`: custom-format `pg_dump` from the local Supabase Postgres container.
- `storage/`: Supabase Storage object files copied from the storage container.
- `deckbridge-state.zip`: local JSON repository state when `.deckbridge/` exists.
- `manifest.json`: creation time, project id, and restore command.

Restore only after stopping DeckBridge and confirming the target Supabase stack is disposable:

```powershell
npx supabase stop
npx supabase start
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-local-server.ps1 -BackupPath ".deckbridge-backups\deckbridge-YYYYMMDD-HHMMSS"
```

After restore, run the verification commands in this runbook and perform one add-on dry run before accepting new edits.
```

- [ ] **Step 5: Commit**

```powershell
git add scripts/backup-local-server.ps1 scripts/restore-local-server.ps1 docs/local-server-runbook.md
git commit -m "Add self-hosted backup and restore workflow"
```

### Task 7: TLS and Firewall Runbook

**Files:**
- Modify: `docs/local-server-runbook.md`

- [ ] **Step 1: Add TLS deployment instructions**

Add this section after "Current local endpoints":

```markdown
## TLS and network boundary

For a real self-hosted deployment, publish only the TLS reverse proxy on ports 80 and 443. Keep DeckBridge (`127.0.0.1:4175`) and local Supabase (`127.0.0.1:54321`) bound to loopback or blocked by the host firewall.

Use Caddy as the TLS terminator:

```bash
sudo cp ops/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Set these values in the production environment file:

```env
DECKBRIDGE_SELF_HOSTED=true
APP_PUBLIC_URL=https://deckbridge.example.com
CORS_ORIGIN=https://deckbridge.example.com
DECKBRIDGE_REQUIRE_HTTPS=true
DECKBRIDGE_TRUST_PROXY=loopback
SUPABASE_URL=https://supabase.deckbridge.example.com
VITE_SUPABASE_URL=https://supabase.deckbridge.example.com
```

Windows firewall example for a LAN-only host:

```powershell
New-NetFirewallRule -DisplayName "DeckBridge HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
New-NetFirewallRule -DisplayName "DeckBridge HTTP ACME" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
New-NetFirewallRule -DisplayName "Block direct DeckBridge API" -Direction Inbound -Protocol TCP -LocalPort 4175 -Action Block
New-NetFirewallRule -DisplayName "Block direct Supabase API" -Direction Inbound -Protocol TCP -LocalPort 54321 -Action Block
```
```

- [ ] **Step 2: Add TLS verification commands**

Add this to the "Verify" section:

```markdown
For self-hosted TLS, also verify:

```powershell
Invoke-WebRequest https://deckbridge.example.com/api/health
Invoke-WebRequest http://deckbridge.example.com/api/health -MaximumRedirection 0
```

Expected: HTTPS health returns `200`; HTTP returns a `308` redirect to the HTTPS URL.
```

- [ ] **Step 3: Commit**

```powershell
git add docs/local-server-runbook.md
git commit -m "Document self-hosted TLS and firewall verification"
```

### Task 8: Full Verification

**Files:**
- No source changes

- [ ] **Step 1: Run all server tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 2: Run API tests**

Run:

```powershell
npm run test:api
```

Expected: PASS.

- [ ] **Step 3: Build frontend**

Run:

```powershell
npm run build
```

Expected: PASS and `dist/` is rebuilt.

- [ ] **Step 4: Dry-run backup script**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-local-server.ps1 -DryRun
```

Expected: PASS with no filesystem changes outside normal PowerShell startup state.

- [ ] **Step 5: Final commit**

```powershell
git status --short
```

Expected: clean working tree after previous task commits.

## Self-Review

- Spec coverage: The plan adds real self-hosting hardening through fail-closed config, HTTPS redirect/HSTS/CSP, trusted proxy parsing, Caddy TLS, firewall guidance, systemd hardening, backup/restore scripts, ACL lockdown, and expiring scoped API tokens.
- Placeholder scan: The plan contains concrete paths, commands, code, SQL, scripts, and expected results.
- Type consistency: `assertSelfHostedSecurityConfig`, `buildSecurityHeaders`, `parseTrustedProxy`, `createUserToken`, and `resolveTokenUser` are named consistently across tests and implementation steps.
