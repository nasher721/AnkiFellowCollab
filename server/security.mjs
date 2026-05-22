import { scrypt as scryptCallback, timingSafeEqual, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { fail } from './errors.mjs';

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_PREFIX = `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`;
const DECK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_PROXY_VALUES = new Set(['', 'true', 'all', '*']);
const TRUSTED_PROXY_ERROR = 'DECKBRIDGE_TRUST_PROXY must be false, loopback, a positive hop count, or explicit CIDR ranges';

export const VALID_SESSION_ROLES = Object.freeze(['owner', 'editor', 'reviewer', 'contributor', 'viewer']);

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

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isCidrRange(value) {
  const [address, prefix, extra] = value.split('/');
  if (!address || !prefix || extra !== undefined || !/^\d{1,3}$/.test(prefix)) return false;
  const ipVersion = isIP(address);
  if (!ipVersion) return false;
  const prefixLength = Number(prefix);
  const maxPrefixLength = ipVersion === 6 ? 128 : 32;
  return prefixLength >= 0 && prefixLength <= maxPrefixLength;
}

export function parseTrustedProxy(value) {
  const raw = String(value ?? '').trim();
  const normalized = raw.toLowerCase();
  if (FORBIDDEN_PROXY_VALUES.has(normalized)) configError(TRUSTED_PROXY_ERROR);
  if (normalized === 'false') return false;
  if (normalized === 'loopback') return 'loopback';
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);

  const ranges = raw.split(',').map((item) => item.trim());
  if (ranges.length > 0 && ranges.every((range) => range && isCidrRange(range))) return ranges;
  configError(TRUSTED_PROXY_ERROR);
}

export function buildSecurityHeaders({ requireHttps = false } = {}) {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'"
  ];
  if (requireHttps) csp.push('upgrade-insecure-requests');

  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': csp.join('; '),
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
  const requireHttps = booleanEnv(env, 'DECKBRIDGE_REQUIRE_HTTPS', true);
  const trustProxy = parseTrustedProxy(stringEnv(env, 'DECKBRIDGE_TRUST_PROXY') || 'loopback');

  const requiredValues = {
    APP_PUBLIC_URL: publicUrl,
    CORS_ORIGIN: corsOrigin,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey
  };
  for (const [key, value] of Object.entries(requiredValues)) {
    if (!value) configError(`${key} is required when DECKBRIDGE_SELF_HOSTED=true`);
  }

  if (requireHttps && !isHttpsOrigin(publicUrl)) configError('APP_PUBLIC_URL must be an https origin');
  if (requireHttps && !isHttpsOrigin(corsOrigin)) configError('CORS_ORIGIN must be an https origin');
  if (viteAnonKey && viteAnonKey !== anonKey) configError('VITE_SUPABASE_ANON_KEY must match SUPABASE_ANON_KEY');

  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('VITE_') && typeof value === 'string' && value.trim() === serviceRoleKey) {
      configError(`${key} must not expose SUPABASE_SERVICE_ROLE_KEY`);
    }
  }

  return { enabled, publicUrl, corsOrigin, supabaseUrl, requireHttps, trustProxy };
}

function parseScryptSecretHash(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('$');
  if (parts.length !== 4) return null;
  const [algorithm, params, salt, derived] = parts;
  if (algorithm !== 'scrypt' || params !== `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`) return null;
  if (!BASE64URL_PATTERN.test(salt) || !BASE64URL_PATTERN.test(derived)) return null;
  const expected = Buffer.from(derived, 'base64url');
  if (expected.length !== SCRYPT_KEY_LENGTH) return null;
  return { salt, expected };
}

export async function hashSecret(value) {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(String(value), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return `${SCRYPT_PREFIX}$${salt}$${Buffer.from(derived).toString('base64url')}`;
}

export function isScryptSecretHash(value) {
  return Boolean(parseScryptSecretHash(value));
}

export async function verifySecret(value, hash) {
  const parsed = parseScryptSecretHash(hash);
  if (!parsed) return false;
  const actual = await scrypt(String(value), parsed.salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return actual.length === SCRYPT_KEY_LENGTH && timingSafeEqual(parsed.expected, actual);
}

export function assertValidEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    fail(400, 'invalid_email', 'A valid email address is required');
  }
  return email;
}

export function assertValidSessionRole(value) {
  if (typeof value !== 'string' || !VALID_SESSION_ROLES.includes(value)) {
    fail(400, 'invalid_role', `Role must be one of: ${VALID_SESSION_ROLES.join(', ')}`);
  }
  return value;
}

export function assertValidDeckId(value) {
  const deckId = typeof value === 'string' ? value.trim() : '';
  if (!DECK_ID_PATTERN.test(deckId)) {
    fail(400, 'invalid_deck_id', 'Deck ID must contain only letters, numbers, underscores, or dashes');
  }
  return deckId;
}

export function deckIdFromRequest(req) {
  return assertValidDeckId(req.params?.deckId || req.body?.deckId || req.query?.deckId);
}
