import { scrypt as scryptCallback, timingSafeEqual, randomBytes } from 'node:crypto';
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

export const VALID_SESSION_ROLES = Object.freeze(['owner', 'editor', 'reviewer', 'contributor', 'viewer']);

function parseScryptSecretHash(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('$');
  if (parts.length !== 4) return null;
  const [algorithm, params, salt, derived] = parts;
  if (algorithm !== 'scrypt' || params !== `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`) return null;
  if (!salt || !derived) return null;
  return { salt, derived };
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
  const expected = Buffer.from(parsed.derived, 'base64url');
  const actual = await scrypt(String(value), parsed.salt, expected.length, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
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
