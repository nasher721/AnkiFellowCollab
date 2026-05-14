export const DEFAULT_PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 500;

export function encodeCursor(card) {
  const payload = { v: 1, c: card.createdAt || card.modifiedAt, i: card.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 1 && parsed.i) return { createdAt: parsed.c, id: parsed.i };
    return null;
  } catch { return null; }
}
