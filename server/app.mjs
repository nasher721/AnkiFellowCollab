import cors from 'cors';
import crypto, { randomUUID } from 'node:crypto';
import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createAuth } from './auth.mjs';
import { requireContributor, requireEditor, requireOwner, requireReviewer, resolveSuggestionDeck } from './rbac.mjs';
import { deckToCreateDeckJson, normalizeAddonDeckCreateInput, normalizeAddonSyncInput, normalizeMediaUploadFiles, normalizeParsedDeck, normalizeSuggestionInput, safeMediaMimeType } from './domain.mjs';
import { AppError, errorPayload, fail } from './errors.mjs';
import { checkAnki, pullDeck, pushDeck } from './ankiConnect.mjs';
import { createApkg, parseApkg } from './ankiPackage.mjs';
import { createRepository } from './repositories/index.mjs';
import { createRateLimiters } from './rateLimits.mjs';
import { ensureDataDirs, loadState, paths, saveState } from './store.mjs';
import { createUserToken, listUserTokens, revokeUserToken } from './tokens.mjs';
import { assertValidDeckId, assertValidEmail, assertValidSessionRole, deckIdFromRequest, hashSecret } from './security.mjs';

const ADDON_PACKAGE_FILENAME = 'deckbridge-sync.ankiaddon';
const ADDON_MANIFEST_PATH = path.resolve(process.cwd(), 'addons', 'deckbridge_sync', 'manifest.json');

function resolveManifestMinVersion(manifest) {
  if (manifest.min_version || manifest.minVersion) return manifest.min_version || manifest.minVersion;
  if (Number.isInteger(manifest.min_point_version)) {
    const major = Math.floor(manifest.min_point_version / 10000);
    const minor = Math.floor((manifest.min_point_version % 10000) / 100);
    const patch = manifest.min_point_version % 100;
    return `${major}.${minor}.${patch}`;
  }
  return '0.1.0';
}

function parseMentions(body) {
  const regex = /@(\w[\w.-]*)/g;
  const matches = new Set();
  let match;
  while ((match = regex.exec(body)) !== null) {
    matches.add(match[1]);
  }
  return [...matches];
}

function legacyErrorMessage(body) {
  return body.error?.message || body.error || 'Unexpected server error';
}

function toBoundedInt(value, fallback = 0, max = 100000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 0), max);
}

function cleanShortText(value, fallback, maxLength = 120) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maxLength);
}

function cleanIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function encodeNotificationCursor(row) {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64url');
}

function notificationRowToApi(row) {
  return {
    id: row.id,
    deckId: row.deck_id ?? null,
    kind: row.kind,
    body: row.body,
    refId: row.ref_id ?? null,
    read: Boolean(row.read),
    createdAt: row.created_at
  };
}

function parseNotificationCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) fail(400, 'invalid_cursor', 'Invalid notification cursor');
  const cursor = value.trim();
  const legacyIso = cleanIsoOrNull(cursor);
  if (legacyIso) return { createdAt: legacyIso, id: null };
  if (cursor.includes('|')) {
    const [createdAtValue, id] = cursor.split('|');
    const createdAt = cleanIsoOrNull(createdAtValue);
    if (createdAt && id) return { createdAt, id };
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const createdAt = cleanIsoOrNull(parsed?.created_at || parsed?.createdAt);
    if (createdAt && typeof parsed?.id === 'string' && parsed.id) return { createdAt, id: parsed.id };
  } catch {
    // fall through to a typed API error below
  }
  fail(400, 'invalid_cursor', 'Invalid notification cursor');
}

function encodePostgrestValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(',', '\\,').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

async function loadDiscoverPreview(supabase, deckId) {
  const [{ count, error: countError }, { data: noteRows, error: noteError }, { data: sampleRows, error: sampleError }] = await Promise.all([
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('deck_id', deckId),
    supabase.from('cards').select('note_type').eq('deck_id', deckId),
    supabase.from('cards').select('fields').eq('deck_id', deckId).order('created_at').limit(3)
  ]);
  if (countError) throw countError;
  if (noteError) throw noteError;
  if (sampleError) throw sampleError;
  return {
    cardCount: count ?? noteRows?.length ?? 0,
    noteTypes: Array.from(new Set((noteRows || []).map((row) => row.note_type || 'Basic'))),
    sampleCards: (sampleRows || []).map((row) => row.fields || {})
  };
}

function normalizeStudySessionBody(user, body = {}) {
  const deckId = assertValidDeckId(body.deckId);
  const startedAt = cleanIsoOrNull(body.startedAt) || new Date().toISOString();
  const endedAt = cleanIsoOrNull(body.endedAt);
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : {};
  return {
    id: typeof body.id === 'string' && body.id.trim() ? body.id.trim().slice(0, 200) : undefined,
    userId: user.id,
    deckId,
    startedAt,
    endedAt,
    durationSeconds: toBoundedInt(body.durationSeconds, endedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)) : 0),
    cardsStudied: toBoundedInt(body.cardsStudied),
    cardsCorrect: toBoundedInt(body.cardsCorrect),
    newCards: toBoundedInt(body.newCards),
    reviewCards: toBoundedInt(body.reviewCards),
    metadata
  };
}

function normalizeActivityFilters(query = {}) {
  const kinds = String(query.kind || query.kinds || '')
    .split(',')
    .map((kind) => kind.trim())
    .filter(Boolean)
    .slice(0, 20);
  return {
    kinds,
    since: cleanIsoOrNull(query.since),
    until: cleanIsoOrNull(query.until),
    limit: toBoundedInt(query.limit, 50, 200) || 50
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapePdfText(value) {
  return String(value ?? '').replace(/[\\()]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function createDeckSummaryLines(deck) {
  const stateCounts = {};
  const tagCounts = {};
  const typeCounts = {};
  for (const card of deck.cards || []) {
    stateCounts[card.state || 'Unknown'] = (stateCounts[card.state || 'Unknown'] || 0) + 1;
    typeCounts[card.type || card.modelName || 'Unknown'] = (typeCounts[card.type || card.modelName || 'Unknown'] || 0) + 1;
    for (const tag of card.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return [
    `DeckBridge summary: ${deck.name}`,
    deck.description ? `Description: ${deck.description}` : null,
    `Cards: ${(deck.cards || []).length}`,
    `Imported: ${deck.importedAt || 'unknown'}`,
    `Last synced: ${deck.lastSyncedAt || 'never'}`,
    `States: ${Object.entries(stateCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `Note types: ${Object.entries(typeCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `Top tags: ${topTags.map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`
  ].filter(Boolean);
}

function createSimplePdf(lines) {
  const safeLines = lines.flatMap((line) => {
    const text = String(line || '');
    const chunks = [];
    for (let index = 0; index < text.length; index += 88) chunks.push(text.slice(index, index + 88));
    return chunks.length ? chunks : [''];
  }).slice(0, 42);
  const content = [
    'BT',
    '/F1 12 Tf',
    '50 760 Td',
    '16 TL',
    ...safeLines.map((line) => `(${escapePdfText(line)}) Tj T*`),
    'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

export function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const app = express();
  const trustProxy = options.trustProxy ?? (process.env.VERCEL ? 1 : false);
  app.set('trust proxy', trustProxy);
  const repository = options.repository || createRepository(options);
  const auth = options.auth || createAuth({ ...options, production });
  const parsePackage = options.parseApkg || parseApkg;
  const createPackage = options.createApkg || createApkg;
  const anonKey = options.supabaseAnonKey || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const loginClient = options.authLoginClient || ((options.supabaseUrl || process.env.SUPABASE_URL) && anonKey
    ? createClient(options.supabaseUrl || process.env.SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
    : null);
  const upload = multer({
    dest: paths().uploadsDir,
    limits: { fileSize: Number(process.env.MAX_APKG_BYTES || 250 * 1024 * 1024), files: 1 },
    fileFilter: (_req, file, cb) => {
      if (/\.apkg$/i.test(file.originalname)) cb(null, true);
      else cb(new AppError(400, 'invalid_upload_type', 'Only .apkg uploads are supported'));
    }
  });
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? (production ? false : true);
  const rateLimiters = createRateLimiters(options.rateLimits);

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '20mb' }));
  app.use('/downloads', express.static(paths().exportsDir, {
    dotfiles: 'deny',
    fallthrough: false,
    setHeaders(res) {
      res.set('Cache-Control', 'private, max-age=300');
    }
  }));
  app.use('/api/decks/upload', rateLimiters.upload);
  app.use('/api/decks/:deckId/media/uploads', rateLimiters.upload);
  app.use('/api/decks/:deckId/sync/cards', rateLimiters.sync);
  app.use('/api/decks/:deckId/analytics', rateLimiters.analytics);
  app.use('/api/notifications', rateLimiters.read);
  app.use('/api/decks', rateLimiters.read);

  function validateDeckIdParam(req, _res, next) {
    try {
      req.params.deckId = deckIdFromRequest(req);
      next();
    } catch (error) {
      next(error);
    }
  }

  app.get('/api/health', async (_req, res, next) => {
    try {
      await ensureDataDirs();
      res.json({
        ok: true,
        repository: repository.constructor?.name || 'DeckBridgeRepository',
        dataDir: paths().dataDir
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/me', auth.requireUser, async (req, res, next) => {
    try {
      const me = await repository.getMe(req.user);
      const decks = typeof repository.listDecks === 'function'
        ? await repository.listDecks(req.user)
        : [];
      res.json({ ...me, decks });
    } catch (error) {
      next(error);
    }
  });

  // --- API Token management (for Anki add-on setup) ---

  app.get('/api/tokens', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) return res.json({ tokens: [] });
      res.json({ tokens: await listUserTokens(auth.supabase, req.user.id) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/tokens', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'tokens_unavailable', 'Token management requires Supabase');
      const label = typeof req.body.label === 'string' && req.body.label.trim()
        ? req.body.label.trim()
        : 'Anki Add-on';
      const token = await createUserToken(auth.supabase, req.user, label);
      res.status(201).json(token);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/anki/login', async (req, res, next) => {
    try {
      if (!auth.supabase || !loginClient) fail(501, 'anki_login_unavailable', 'Anki login requires Supabase auth');
      const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      if (!email || !password) fail(400, 'missing_credentials', 'Email and password are required');

      const { data, error } = await loginClient.auth.signInWithPassword({ email, password });
      if (error || !data.user) fail(401, 'invalid_credentials', 'Invalid DeckBridge email or password');
      const user = {
        id: data.user.id,
        email: data.user.email || email,
        name: data.user.user_metadata?.name || data.user.email || email
      };
      const token = await createUserToken(auth.supabase, user, 'Anki Add-on login');
      const decks = typeof repository.listDecks === 'function' ? await repository.listDecks(user) : [];
      res.json({ user, token, decks });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/tokens/:tokenId', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'tokens_unavailable', 'Token management requires Supabase');
      await revokeUserToken(auth.supabase, req.user.id, req.params.tokenId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // --- Add-on distribution ---

  app.get('/api/addon/version', async (_req, res, next) => {
    try {
      const manifest = JSON.parse(await fs.readFile(ADDON_MANIFEST_PATH, 'utf8'));
      res.json({
        version: manifest.version || '0.0.0',
        minVersion: resolveManifestMinVersion(manifest),
        package: manifest.package,
        name: manifest.name,
        downloadUrl: '/api/addon/download'
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/addon/download', async (_req, res, next) => {
    try {
      const addonPath = path.resolve(process.cwd(), 'dist', ADDON_PACKAGE_FILENAME);
      try {
        await fs.access(addonPath);
      } catch {
        fail(404, 'addon_not_built', 'Add-on package not found. Run npm run package:anki-addon first.');
      }
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${ADDON_PACKAGE_FILENAME}"`,
        'Cache-Control': 'public, max-age=3600'
      });
      res.sendFile(addonPath);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/decks', auth.requireUser, async (req, res, next) => {
    try {
      res.json({ decks: await repository.listDecks(req.user) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/decks/:deckId', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      res.json(await repository.getDeckState(req.user, deckId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/state', auth.requireUser, async (req, res, next) => {
    try {
      const deckId = req.query.deckId ? assertValidDeckId(req.query.deckId) : undefined;
      res.json(await repository.getDeckState(req.user, deckId));
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/session', auth.requireUser, async (req, res, next) => {
    try {
      if (production) fail(404, 'not_found', 'Demo session controls are not available in production');
      if (req.body.activeDeckId && repository.setActiveDeck) {
        const activeDeckId = assertValidDeckId(req.body.activeDeckId);
        res.json(await repository.setActiveDeck(req.user, activeDeckId));
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

  app.post('/api/decks/upload', auth.requireUser, upload.single('deck'), async (req, res, next) => {
    try {
      if (!req.file) fail(400, 'missing_upload', 'Missing .apkg upload');
      const parsed = await parsePackage(req.file.path);
      const deck = normalizeParsedDeck(parsed, req.file.originalname);
      res.status(201).json(await repository.uploadDeck(req.user, deck));
    } catch (error) {
      next(error);
    } finally {
      if (req.file?.path) {
        await fs.rm(req.file.path, { force: true }).catch(() => undefined);
      }
    }
  });

  app.post('/api/decks/sync/from-anki', auth.requireUser, async (req, res, next) => {
    try {
      if (!repository.uploadDeck) fail(501, 'deck_create_unavailable', 'Deck creation is not available for this repository');
      const { deck, result } = normalizeAddonDeckCreateInput(req.body, req.user);
      const state = await repository.uploadDeck(req.user, deck);
      res.status(201).json({
        deck: {
          id: deck.id,
          name: deck.name,
          cardCount: deck.cards.length
        },
        result,
        state
      });
    } catch (error) {
      next(error);
    }
  });

  async function createSuggestion(req, res, next) {
    try {
      const deckId = deckIdFromRequest(req);
      const deckState = await repository.getDeckState(req.user, deckId);
      const deck = deckState.decks[0];
      const card = deck.cards.find((item) => item.id === req.body.cardId);
      if (!card) fail(404, 'card_not_found', 'Card not found');
      const input = normalizeSuggestionInput(req.body, card);
      res.status(201).json(await repository.createSuggestion(req.user, {
        deckId: deck.id,
        cardId: card.id,
        authorId: req.user.id,
        ...input
      }));
    } catch (error) {
      next(error);
    }
  }

  app.post('/api/decks/:deckId/suggestions', validateDeckIdParam, auth.requireUser, requireContributor(auth.supabase), createSuggestion);
  app.post('/api/suggestions', validateDeckIdParam, auth.requireUser, requireContributor(auth.supabase), createSuggestion);

  app.post('/api/suggestions/:id/decision', auth.requireUser, resolveSuggestionDeck(auth.supabase), requireReviewer(auth.supabase), async (req, res, next) => {
    try {
      if (!['accepted', 'rejected', 'revision'].includes(req.body.decision)) {
        fail(400, 'invalid_decision', 'Decision must be accepted, rejected, or revision');
      }
      res.json(await repository.decideSuggestion(req.user, req.params.id, req.body.decision));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/decks/:deckId/suggestions/bulk-decision', validateDeckIdParam, auth.requireUser, requireReviewer(auth.supabase), async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!['accepted', 'rejected', 'revision'].includes(req.body.decision)) {
        fail(400, 'invalid_decision', 'Decision must be accepted, rejected, or revision');
      }
      if (!Array.isArray(req.body.suggestionIds)) {
        fail(400, 'missing_suggestion_ids', 'suggestionIds array is required');
      }
      if (req.body.suggestionIds.length > 100) fail(400, 'too_many_suggestion_ids', 'Bulk decisions support up to 100 suggestions');
      const suggestionIds = req.body.suggestionIds.map((id) => {
        if (typeof id !== 'string') fail(400, 'invalid_suggestion_id', 'Each suggestion ID must be a non-empty string up to 200 characters');
        const trimmed = id.trim();
        if (!trimmed || trimmed.length > 200) fail(400, 'invalid_suggestion_id', 'Each suggestion ID must be a non-empty string up to 200 characters');
        return cleanShortText(trimmed, '', 200);
      });
      if (!suggestionIds.length) fail(400, 'missing_suggestion_ids', 'suggestionIds array is required');
      if (new Set(suggestionIds).size !== suggestionIds.length) fail(400, 'duplicate_suggestion_ids', 'suggestionIds must be unique');
      if (!repository.bulkDecideSuggestions) fail(501, 'bulk_decision_unavailable', 'Bulk suggestion decisions are unavailable');
      res.json(await repository.bulkDecideSuggestions(req.user, deckId, suggestionIds, req.body.decision));
    } catch (error) {
      next(error);
    }
  });

  // Bulk delete cards (owner only)
  app.delete('/api/decks/:deckId/cards', validateDeckIdParam, auth.requireUser, requireOwner(auth.supabase), async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const ids = Array.isArray(req.body.cardIds) ? req.body.cardIds.slice(0, 500) : [];
      if (!ids.length) fail(400, 'missing_card_ids', 'cardIds array is required');
      if (repository.deleteCards) {
        return res.json(await repository.deleteCards(req.user, deckId, ids));
      }
      if (!auth.supabase) fail(501, 'delete_unavailable', 'Card deletion requires Supabase');
      await auth.supabase.from('cards').delete().in('id', ids).eq('deck_id', deckId);
      res.json({ deleted: ids.length });
    } catch (err) { next(err); }
  });

  // --- Comments ---

  app.get('/api/suggestions/:id/comments', auth.requireUser, resolveSuggestionDeck(auth.supabase), requireContributor(auth.supabase), async (req, res, next) => {
    try {
      if (!repository.listSuggestionComments) fail(501, 'comments_unavailable', 'Comments are unavailable');
      const comments = await repository.listSuggestionComments(req.user, req.params.id);
      res.json({ comments });
    } catch (err) { next(err); }
  });

  app.post('/api/suggestions/:id/comments', auth.requireUser, resolveSuggestionDeck(auth.supabase), requireContributor(auth.supabase), async (req, res, next) => {
    try {
      if (!repository.createSuggestionComment) fail(501, 'comments_unavailable', 'Comments are unavailable');
      const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
      if (!body) fail(400, 'empty_comment', 'Comment body is required');
      const parentId = typeof req.body.parentId === 'string' && req.body.parentId.trim()
        ? cleanShortText(req.body.parentId, '', 200)
        : null;
      const comment = await repository.createSuggestionComment(req.user, req.params.id, { body, parentId });
      // Create notification for suggestion author
      if (auth.supabase) {
        const { data: sugg } = await auth.supabase.from('suggestions')
          .select('author_id').eq('id', req.params.id).single();
        if (sugg?.author_id && sugg.author_id !== req.user.id) {
          await auth.supabase.from('notifications').insert({
            id: crypto.randomUUID(),
            user_id: sugg.author_id,
            deck_id: comment.deckId,
            kind: 'comment',
            body: `${req.user.name} commented on your suggestion`,
            ref_id: req.params.id,
            created_at: new Date().toISOString()
          }).then(() => undefined).catch(() => undefined);
        }
        const mentions = parseMentions(body);
        if (mentions.length) {
          Promise.all(mentions.map(async (name) => {
            const { data: profile } = await auth.supabase.from('profiles')
              .select('id').ilike('name', name).single();
            if (profile?.id && profile.id !== req.user.id) {
              await auth.supabase.from('notifications').insert({
                id: crypto.randomUUID(),
                user_id: profile.id,
                deck_id: comment.deckId,
                kind: 'mention',
                body: `${req.user.name} mentioned you in a comment`,
                ref_id: comment.id,
                created_at: new Date().toISOString()
              });
            }
          })).then(() => undefined).catch(() => undefined);
        }
      }
      res.status(201).json(comment);
    } catch (err) { next(err); }
  });

  app.patch('/api/suggestions/:id/comments/:commentId/resolved', auth.requireUser, resolveSuggestionDeck(auth.supabase), requireReviewer(auth.supabase), async (req, res, next) => {
    try {
      if (!repository.setSuggestionCommentResolved) fail(501, 'comments_unavailable', 'Comments are unavailable');
      const resolved = typeof req.body.resolved === 'boolean' ? req.body.resolved : undefined;
      const comment = await repository.setSuggestionCommentResolved(req.user, req.params.id, req.params.commentId, resolved);
      res.json(comment);
    } catch (err) { next(err); }
  });

  // --- Reactions ---

  app.post('/api/suggestions/:id/reactions', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'reactions_unavailable', 'Reactions require Supabase');
      const allowed = ['👍', '❓', '✅'];
      if (!allowed.includes(req.body.emoji)) fail(400, 'invalid_emoji', `Emoji must be one of: ${allowed.join(' ')}`);
      const { data: suggestion } = await auth.supabase
        .from('suggestions').select('deck_id').eq('id', req.params.id).single();
      if (!suggestion) fail(404, 'suggestion_not_found', 'Suggestion not found');
      const { error } = await auth.supabase.from('reactions').upsert({
        id: crypto.randomUUID(),
        suggestion_id: req.params.id,
        user_id: req.user.id,
        emoji: req.body.emoji,
        created_at: new Date().toISOString()
      }, { onConflict: 'suggestion_id,user_id,emoji', ignoreDuplicates: true });
      if (error) fail(500, 'reaction_error', error.message);
      const { data: counts } = await auth.supabase.from('reactions')
        .select('emoji').eq('suggestion_id', req.params.id);
      const tally = allowed.reduce((acc, e) => ({ ...acc, [e]: 0 }), {});
      (counts || []).forEach((r) => { tally[r.emoji] = (tally[r.emoji] || 0) + 1; });
      res.json({ reactions: tally });
    } catch (err) { next(err); }
  });

  app.delete('/api/suggestions/:id/reactions/:emoji', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'reactions_unavailable', 'Reactions require Supabase');
      await auth.supabase.from('reactions')
        .delete()
        .eq('suggestion_id', req.params.id)
        .eq('user_id', req.user.id)
        .eq('emoji', decodeURIComponent(req.params.emoji));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // --- Notifications ---

  app.get('/api/notifications', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) return res.json({ notifications: [], unread: 0, nextCursor: null });
      const parsedLimit = Number(req.query.limit);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 100)
        : 50;
      const cursor = parseNotificationCursor(req.query.cursor);
      let query = auth.supabase.from('notifications')
        .select('id, deck_id, kind, body, ref_id, read, created_at')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
      if (cursor?.id) {
        const createdAt = encodePostgrestValue(cursor.createdAt);
        const id = encodePostgrestValue(cursor.id);
        query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
      } else if (cursor) {
        query = query.lt('created_at', cursor.createdAt);
      }
      const unreadQuery = auth.supabase.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.user.id)
        .eq('read', false);
      const [{ data, error: pageError }, { count, error: unreadError }] = await Promise.all([query.limit(limit + 1), unreadQuery]);
      if (pageError) fail(500, 'notifications_error', pageError.message || 'Unable to load notifications');
      if (unreadError) fail(500, 'notifications_error', unreadError.message || 'Unable to load notifications');
      const rows = data || [];
      const page = rows.slice(0, limit);
      const unread = count ?? rows.filter((n) => !n.read).length;
      const nextCursor = rows.length > limit ? encodeNotificationCursor(page[page.length - 1]) : null;
      res.json({ notifications: page.map(notificationRowToApi), unread, nextCursor });
    } catch (err) { next(err); }
  });

  app.post('/api/notifications/read-all', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) return res.status(204).end();
      await auth.supabase.from('notifications')
        .update({ read: true })
        .eq('user_id', req.user.id)
        .eq('read', false);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  async function createExport(req, res, next) {
    try {
      const deckId = deckIdFromRequest(req);
      const deck = await repository.getExportDeck(req.user, deckId);
      const base = `${deck.name.replace(/[^a-z0-9_-]+/gi, '-')}-${Date.now()}`;
      const jsonPath = path.join(paths().exportsDir, `${base}.json`);
      const apkgPath = path.join(paths().exportsDir, `${base}.apkg`);
      await fs.writeFile(jsonPath, JSON.stringify(deckToCreateDeckJson(deck), null, 2), 'utf8');
      await createPackage(jsonPath, apkgPath);
      const filename = `${base}.apkg`;
      const localDownload = {
        filename,
        url: `/downloads/${filename}`,
        expiresAt: null
      };
      const download = repository.storeExport
        ? await repository.storeExport(req.user, deck.id, apkgPath, filename)
        : localDownload;
      const result = await repository.recordExport(req.user, deck.id, download);
      if (req.path === '/api/decks/export') {
        const packageBytes = await fs.readFile(apkgPath);
        res
          .status(200)
          .set({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`
          })
          .send(packageBytes);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  app.post('/api/decks/:deckId/export', validateDeckIdParam, auth.requireUser, createExport);
  app.post('/api/decks/export', auth.requireUser, createExport);
  const rejectMalformedDeckExport = (_req, _res, next) => {
    next(new AppError(400, 'invalid_deck_id', 'Deck ID must contain only letters, numbers, underscores, or dashes'));
  };
  app.post('/api/state/export', auth.requireUser, rejectMalformedDeckExport);
  app.post('/state/export', auth.requireUser, rejectMalformedDeckExport);

  function escapeCsv(value) {
    const str = String(value ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  app.get('/api/decks/:deckId/export/csv', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const deckState = await repository.getDeckState(req.user, deckId);
      const deck = deckState.decks[0];
      if (!deck) fail(404, 'deck_not_found', 'Deck not found');

      const allFields = new Set();
      for (const card of deck.cards) {
        for (const key of Object.keys(card.fields)) allFields.add(key);
      }
      const fieldNames = [...allFields];

      const header = ['Card ID', 'Note Type', 'State', 'Tags', ...fieldNames].map(escapeCsv).join(',');
      const rows = deck.cards.map((card) => [
        card.id,
        card.type,
        card.state,
        card.tags.join('; '),
        ...fieldNames.map((f) => card.fields[f] || '')
      ].map(escapeCsv).join(','));

      const csv = [header, ...rows].join('\n');
      const filename = `${deck.name.replace(/[^a-z0-9_-]+/gi, '-')}-cards.csv`;

      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, max-age=60'
      });
      res.send(csv);
    } catch (err) { next(err); }
  });

  app.get('/api/decks/:deckId/export/activity', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const deckState = await repository.getDeckState(req.user, deckId);
      const activities = repository.listActivity
        ? await repository.listActivity(req.user, deckId, normalizeActivityFilters(req.query))
        : (deckState.activity || []);

      const header = ['ID', 'Kind', 'Text', 'Timestamp'].map(escapeCsv).join(',');
      const rows = activities.map((a) => [a.id, a.kind, a.text, a.at].map(escapeCsv).join(','));
      const csv = [header, ...rows].join('\n');
      const deck = deckState.decks[0];
      const filename = `${(deck?.name || 'deck').replace(/[^a-z0-9_-]+/gi, '-')}-activity.csv`;

      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, max-age=60'
      });
      res.send(csv);
    } catch (err) { next(err); }
  });

  app.get('/api/decks/:deckId/media/:filename', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const rawFilename = typeof req.params.filename === 'string' ? req.params.filename.trim() : '';
      const filename = cleanShortText(rawFilename, '', 240);
      if (!filename || rawFilename.length > 240 || filename.includes('/') || filename.includes('\\')) {
        fail(400, 'invalid_media_filename', 'Media filename is required');
      }
      const deckState = await repository.getDeckState(req.user, deckId);
      const deck = deckState.decks[0];
      const asset = deck?.media?.[filename];
      if (!asset?.dataBase64 && !asset?.storagePath) fail(404, 'media_not_found', 'Media asset not found');
      const mimeType = safeMediaMimeType(asset.mimeType);
      if (asset.storagePath) {
        if (!repository.createMediaDownload) fail(404, 'media_not_found', 'Media asset not found');
        const download = await repository.createMediaDownload(req.user, deckId, asset);
        res.redirect(302, download.url);
        return;
      }
      const headers = {
        'Content-Type': mimeType,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      };
      if (mimeType === 'application/octet-stream') {
        headers['Content-Disposition'] = `attachment; filename="${filename.replace(/"/g, '')}"`;
      }
      res.set({
        ...headers
      });
      res.send(Buffer.from(asset.dataBase64, 'base64'));
    } catch (err) { next(err); }
  });

  app.post('/api/decks/:deckId/media/uploads', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!repository.createMediaUploadTargets) {
        fail(501, 'media_upload_unavailable', 'Large media upload is not available for this repository');
      }
      const files = normalizeMediaUploadFiles(req.body.files);
      if (!files.length) fail(400, 'invalid_media_upload', 'At least one valid media file is required');
      res.status(201).json({
        uploads: await repository.createMediaUploadTargets(req.user, deckId, files)
      });
    } catch (err) { next(err); }
  });

  app.get('/api/decks/:deckId/activity', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const filters = normalizeActivityFilters(req.query);
      const deckState = await repository.getDeckState(req.user, deckId);
      const activities = repository.listActivity
        ? await repository.listActivity(req.user, deckId, filters)
        : (deckState.activity || []).slice(0, filters.limit);
      res.json({ activity: activities });
    } catch (err) { next(err); }
  });

  app.get('/api/decks/:deckId/export/summary', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const deckState = await repository.getDeckState(req.user, deckId);
      const deck = deckState.decks[0];
      if (!deck) fail(404, 'deck_not_found', 'Deck not found');
      const format = String(req.query.format || 'pdf').toLowerCase();
      const filenameBase = `${deck.name.replace(/[^a-z0-9_-]+/gi, '-')}-summary`;
      const lines = createDeckSummaryLines(deck);
      if (format === 'html') {
        res.set({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.html"`,
          'Cache-Control': 'private, max-age=60'
        });
        res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(deck.name)} summary</title></head><body><h1>${escapeHtml(deck.name)}</h1><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></body></html>`);
        return;
      }
      const pdf = createSimplePdf(lines);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filenameBase}.pdf"`,
        'Cache-Control': 'private, max-age=60'
      });
      res.send(pdf);
    } catch (err) { next(err); }
  });

  // ─── Phase 4: Discovery, Stars, Profiles, Analytics, Templates ───────────

  // Public deck discovery gallery
  app.get('/api/discover', async (req, res, next) => {
    try {
      if (!auth.supabase) return res.json({ decks: [] });
      const { q, category, sort = 'stars', page = '1' } = req.query;
      const limit = 24;
      const offset = (Math.max(1, Number(page)) - 1) * limit;

      let query = auth.supabase
        .from('decks')
        .select(`
          id, name, description, owner_id, owner_name,
          imported_at, visibility, download_count, fork_of,
          deck_stars(count)
        `)
        .eq('visibility', 'public')
        .range(offset, offset + limit - 1);

      if (q) query = query.ilike('name', `%${q}%`);
      if (sort === 'stars') query = query.order('download_count', { ascending: false });
      else if (sort === 'newest') query = query.order('imported_at', { ascending: false });

      const { data, error } = await query;
      if (error) fail(500, 'discover_error', error.message);

      const previewByDeck = new Map(await Promise.all((data || []).map(async (deck) => [
        deck.id,
        await loadDiscoverPreview(auth.supabase, deck.id)
      ])));

      const decks = (data || []).map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        ownerName: d.owner_name,
        importedAt: d.imported_at,
        downloadCount: d.download_count,
        starCount: d.deck_stars?.[0]?.count ?? 0,
        forkedFrom: d.fork_of ?? null,
        cardCount: previewByDeck.get(d.id)?.cardCount ?? 0,
        noteTypes: previewByDeck.get(d.id)?.noteTypes ?? [],
        sampleCards: previewByDeck.get(d.id)?.sampleCards ?? [],
      }));
      res.json({ decks });
    } catch (err) { next(err); }
  });

  // Make a deck public/private/unlisted
  app.patch('/api/decks/:deckId/visibility', validateDeckIdParam, auth.requireUser, requireOwner(auth.supabase), async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!auth.supabase) fail(501, 'visibility_unavailable', 'Requires Supabase');
      const allowed = ['public', 'private', 'unlisted'];
      if (!allowed.includes(req.body.visibility)) fail(400, 'invalid_visibility', `Must be one of: ${allowed.join(', ')}`);
      const { error } = await auth.supabase.from('decks')
        .update({ visibility: req.body.visibility })
        .eq('id', deckId);
      if (error) fail(500, 'visibility_error', error.message);
      res.json({ visibility: req.body.visibility });
    } catch (err) { next(err); }
  });

  app.get('/api/decks/:deckId/share-links', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!repository.listShareLinks) fail(501, 'share_links_unavailable', 'Share links are not available for this repository');
      res.json({ shareLinks: await repository.listShareLinks(req.user, deckId) });
    } catch (err) { next(err); }
  });

  app.post('/api/decks/:deckId/share-links', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!repository.createShareLink) fail(501, 'share_links_unavailable', 'Share links are not available for this repository');
      if (Object.hasOwn(req.body, 'passwordHash')) fail(400, 'password_hash_not_allowed', 'Send password, not passwordHash');
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

  // --- Collaborator Invitations ---

  function toInviteResponse(row) {
    return {
      id: row.id,
      deckId: row.deck_id || row.deckId,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expires_at || row.expiresAt || null,
      createdAt: row.created_at || row.createdAt,
      respondedAt: row.responded_at || row.respondedAt || null
    };
  }

  // Create invite (editor+)
  app.post('/api/decks/:deckId/invites', validateDeckIdParam, auth.requireUser, requireEditor(auth.supabase), async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const email = assertValidEmail(req.body.email);
      const allowedRoles = ['viewer', 'contributor', 'reviewer', 'editor'];
      const role = allowedRoles.includes(req.body.role) ? req.body.role : 'contributor';
      if (repository.createInvite) {
        const invite = await repository.createInvite(req.user, deckId, { email, role });
        return res.status(201).json({ invite });
      }
      if (!auth.supabase) fail(501, 'invites_unavailable', 'Invites require Supabase');
      const token = crypto.randomBytes(20).toString('base64url');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await auth.supabase.from('deck_invites').insert({
        id: randomUUID(), deck_id: deckId, invited_by: req.user.id,
        email, role, token, status: 'pending', expires_at: expiresAt, created_at: new Date().toISOString()
      }).select().single();
      if (error) fail(500, 'invite_error', error.message);
      res.status(201).json({ invite: toInviteResponse(data) });
    } catch (err) { next(err); }
  });

  // List invites for a deck (editor+)
  app.get('/api/decks/:deckId/invites', validateDeckIdParam, auth.requireUser, requireEditor(auth.supabase), async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (repository.listInvites) {
        return res.json({ invites: await repository.listInvites(req.user, deckId) });
      }
      if (!auth.supabase) return res.json({ invites: [] });
      const { data, error } = await auth.supabase.from('deck_invites')
        .select('*').eq('deck_id', deckId)
        .order('created_at', { ascending: false });
      if (error) fail(500, 'invites_error', error.message);
      res.json({ invites: (data || []).map(toInviteResponse) });
    } catch (err) { next(err); }
  });

  // Revoke invite (owner only)
  app.delete('/api/decks/:deckId/invites/:inviteId', validateDeckIdParam, auth.requireUser, requireOwner(auth.supabase), async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (repository.revokeInvite) {
        await repository.revokeInvite(req.user, deckId, req.params.inviteId);
        return res.status(204).end();
      }
      if (!auth.supabase) fail(501, 'invites_unavailable', 'Invites require Supabase');
      const { error } = await auth.supabase.from('deck_invites')
        .delete().eq('id', req.params.inviteId).eq('deck_id', deckId);
      if (error) fail(500, 'revoke_error', error.message);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // Preview invite metadata (public, no auth)
  app.get('/api/invites/:token', async (req, res, next) => {
    try {
      if (repository.previewInvite) {
        const preview = await repository.previewInvite(req.params.token);
        return res.json({ invite: preview });
      }
      if (!auth.supabase) fail(501, 'invites_unavailable', 'Invites require Supabase');
      const { data: invite } = await auth.supabase
        .from('deck_invites')
        .select('id, email, role, status, expires_at, deck_id, decks(name)')
        .eq('token', req.params.token).single();
      if (!invite) fail(404, 'invite_not_found', 'Invite not found');
      res.json({
        invite: {
          deckId: invite.deck_id,
          deckName: invite.decks?.name || null,
          role: invite.role,
          email: invite.email,
          status: invite.status,
          expiresAt: invite.expires_at
        }
      });
    } catch (err) { next(err); }
  });

  // Accept invite (requires auth)
  app.post('/api/invites/:token/accept', auth.requireUser, async (req, res, next) => {
    try {
      if (repository.acceptInvite) {
        const result = await repository.acceptInvite(req.user, req.params.token);
        return res.json(result);
      }
      if (!auth.supabase) fail(501, 'invites_unavailable', 'Invites require Supabase');
      const { data: invite, error: inviteErr } = await auth.supabase
        .from('deck_invites').select('*').eq('token', req.params.token).single();
      if (inviteErr || !invite) fail(404, 'invite_not_found', 'Invite not found or already used');
      if (invite.status !== 'pending') fail(409, 'invite_used', `Invite has already been ${invite.status}`);
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        await auth.supabase.from('deck_invites').update({ status: 'expired' }).eq('id', invite.id);
        fail(410, 'invite_expired', 'This invite link has expired');
      }
      if (invite.email.toLowerCase() !== req.user.email.toLowerCase()) {
        fail(403, 'invite_email_mismatch', 'This invite was sent to a different email address');
      }
      const now = new Date().toISOString();
      await auth.supabase.from('profiles')
        .upsert({ id: req.user.id, email: req.user.email, name: req.user.name }, { onConflict: 'id', ignoreDuplicates: true });
      await auth.supabase.from('deck_members').upsert(
        { deck_id: invite.deck_id, user_id: req.user.id, role: invite.role, created_at: now },
        { onConflict: 'deck_id,user_id' }
      );
      await auth.supabase.from('deck_invites')
        .update({ status: 'accepted', responded_at: now }).eq('id', invite.id);
      res.json({ deckId: invite.deck_id, role: invite.role });
    } catch (err) { next(err); }
  });

  // Fork a public deck into the requester's workspace
  app.post('/api/decks/:deckId/fork', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const sourceDeckId = deckIdFromRequest(req);
      if (!auth.supabase) fail(501, 'fork_unavailable', 'Requires Supabase');
      // Load source deck (must be public or member)
      const { data: source, error: srcErr } = await auth.supabase
        .from('decks').select('*').eq('id', sourceDeckId).single();
      if (srcErr || !source) fail(404, 'deck_not_found', 'Deck not found');
      if (source.visibility !== 'public') {
        const { data: m } = await auth.supabase.from('deck_members')
          .select('role').eq('deck_id', sourceDeckId).eq('user_id', req.user.id).single();
        if (!m) fail(403, 'forbidden', 'Cannot fork a private deck you are not a member of');
      }
      // Ensure profile exists
      await auth.supabase.from('profiles').upsert({
        id: req.user.id, email: req.user.email, name: req.user.name
      }, { onConflict: 'id', ignoreDuplicates: true });

      const forkId = randomUUID();
      const now = new Date().toISOString();

      // Copy deck row
      await auth.supabase.from('decks').insert({
        id: forkId,
        owner_id: req.user.id,
        owner_name: req.user.name,
        name: `${source.name} (fork)`,
        description: source.description,
        imported_at: now,
        last_synced_at: null,
        media: source.media,
        models: source.models,
        source: source.source,
        visibility: 'private',
        fork_of: sourceDeckId
      });

      // Copy cards
      const { data: cards } = await auth.supabase.from('cards')
        .select('*').eq('deck_id', sourceDeckId);
      if (cards?.length) {
        const forkedCards = cards.map((c) => ({
          ...c,
          id: randomUUID(),
          deck_id: forkId,
          created_at: now,
          modified_at: now
        }));
        await auth.supabase.from('cards').insert(forkedCards);
      }

      // Add owner membership
      await auth.supabase.from('deck_members').insert({
        deck_id: forkId, user_id: req.user.id, role: 'owner', created_at: now
      });

      // Increment source download count
      await auth.supabase.from('decks')
        .update({ download_count: (source.download_count || 0) + 1 })
        .eq('id', sourceDeckId);

      res.status(201).json({ deckId: forkId, name: `${source.name} (fork)` });
    } catch (err) { next(err); }
  });

  // Star / unstar a deck
  app.post('/api/decks/:deckId/star', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!auth.supabase) fail(501, 'stars_unavailable', 'Requires Supabase');
      await auth.supabase.from('deck_stars').upsert(
        { deck_id: deckId, user_id: req.user.id, created_at: new Date().toISOString() },
        { onConflict: 'deck_id,user_id', ignoreDuplicates: true }
      );
      const { count } = await auth.supabase.from('deck_stars')
        .select('*', { count: 'exact', head: true }).eq('deck_id', deckId);
      res.json({ starred: true, count: count ?? 0 });
    } catch (err) { next(err); }
  });

  app.delete('/api/decks/:deckId/star', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!auth.supabase) return res.status(204).end();
      await auth.supabase.from('deck_stars')
        .delete().eq('deck_id', deckId).eq('user_id', req.user.id);
      const { count } = await auth.supabase.from('deck_stars')
        .select('*', { count: 'exact', head: true }).eq('deck_id', deckId);
      res.json({ starred: false, count: count ?? 0 });
    } catch (err) { next(err); }
  });

  // Public user profile
  app.get('/api/profiles/:userId', async (req, res, next) => {
    try {
      if (!auth.supabase) return res.json({ profile: null, decks: [] });
      const { data: profile } = await auth.supabase.from('profiles')
        .select('id, name, email').eq('id', req.params.userId).single();
      if (!profile) fail(404, 'profile_not_found', 'User not found');
      const { data: decks } = await auth.supabase.from('decks')
        .select('id, name, description, imported_at, download_count')
        .eq('owner_id', req.params.userId)
        .eq('visibility', 'public')
        .order('imported_at', { ascending: false });
      res.json({ profile: { id: profile.id, name: profile.name }, decks: decks || [] });
    } catch (err) { next(err); }
  });

  // Deck analytics — 60-second in-memory cache keyed by deckId
  const analyticsCache = new Map();
  const ANALYTICS_CACHE_TTL_MS = 60_000;

  app.get('/api/decks/:deckId/analytics', validateDeckIdParam, auth.requireUser, requireEditor(auth.supabase), async (req, res, next) => {
    try {
      const cacheKey = deckIdFromRequest(req);

      if (repository.getAnalytics) {
        const cached = analyticsCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return res.json({ analytics: cached.data });
        const data = await repository.getAnalytics(req.user, cacheKey);
        analyticsCache.set(cacheKey, { data, expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS });
        return res.json({ analytics: data });
      }
      if (!auth.supabase) return res.json({ analytics: null });

      const cached = analyticsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return res.json({ analytics: cached.data });

      const [suggestionsRes, starsRes, cardsRes, progressRes, sessionsRes] = await Promise.all([
        auth.supabase.from('suggestions').select('status, author_id, author_name, created_at')
          .eq('deck_id', cacheKey),
        auth.supabase.from('deck_stars').select('user_id')
          .eq('deck_id', cacheKey),
        auth.supabase.from('cards').select('id, state, due, suspended, fields')
          .eq('deck_id', cacheKey),
        auth.supabase.from('study_progress').select('card_id, interval_days, ease_factor, repetitions, next_due, last_rating, updated_at')
          .eq('deck_id', cacheKey),
        auth.supabase.from('study_sessions').select('duration_seconds, cards_studied, cards_correct, started_at')
          .eq('deck_id', cacheKey)
          .then((result) => result, () => ({ data: [], error: null }))
      ]);

      const suggestions = suggestionsRes.data || [];
      const cards = cardsRes.data || [];
      const progress = progressRes.data || [];
      const sessions = sessionsRes.error ? [] : (sessionsRes.data || []);
      const total = suggestions.length;
      const accepted = suggestions.filter((s) => s.status === 'accepted').length;
      const rejected = suggestions.filter((s) => s.status === 'rejected').length;
      const pending = suggestions.filter((s) => s.status === 'pending').length;

      // Contributor leaderboard
      const byAuthor = {};
      for (const s of suggestions) {
        if (!byAuthor[s.author_id]) byAuthor[s.author_id] = { name: s.author_name, total: 0, accepted: 0 };
        byAuthor[s.author_id].total++;
        if (s.status === 'accepted') byAuthor[s.author_id].accepted++;
      }
      const leaderboard = Object.values(byAuthor)
        .sort((a, b) => b.accepted - a.accepted)
        .slice(0, 10);

      const byState = {};
      const byDifficulty = { dueNow: 0, soon: 0, later: 0, suspended: 0, unknown: 0 };
      const cardFieldsMap = new Map(cards.map((c) => [c.id, c.fields || {}]));
      for (const card of cards) {
        const state = card.state || 'Unknown';
        byState[state] = (byState[state] || 0) + 1;
        if (card.suspended) byDifficulty.suspended += 1;
        else if (card.due == null) byDifficulty.unknown += 1;
        else if (Number(card.due) <= 0) byDifficulty.dueNow += 1;
        else if (Number(card.due) <= 7) byDifficulty.soon += 1;
        else byDifficulty.later += 1;
      }

      const progressByCard = new Map(progress.map((item) => [item.card_id, item]));
      const strugglingCards = [...progressByCard.entries()]
        .map(([cardId, item]) => {
          const fields = cardFieldsMap.get(cardId) || {};
          const rawFront = fields.Front || fields.front || Object.values(fields)[0] || '';
          const rawBack = fields.Back || fields.back || Object.values(fields)[1] || '';
          return {
            cardId,
            easeFactor: Number(item.ease_factor),
            repetitions: item.repetitions,
            lastRating: item.last_rating,
            nextDue: item.next_due,
            updatedAt: item.updated_at,
            front: String(rawFront).slice(0, 120),
            back: String(rawBack).slice(0, 120),
          };
        })
        .filter((item) => (item.lastRating != null && Number(item.lastRating) <= 2) || item.easeFactor < 2.2)
        .sort((a, b) => (a.easeFactor - b.easeFactor) || ((a.lastRating ?? 5) - (b.lastRating ?? 5)))
        .slice(0, 10);

      const sessionTotals = sessions.reduce((acc, session) => {
        acc.total += 1;
        acc.durationSeconds += Number(session.duration_seconds) || 0;
        acc.cardsStudied += Number(session.cards_studied) || 0;
        acc.cardsCorrect += Number(session.cards_correct) || 0;
        return acc;
      }, { total: 0, durationSeconds: 0, cardsStudied: 0, cardsCorrect: 0 });

      const dayMap = {};
      for (const s of sessions) {
        const day = String(s.started_at || '').slice(0, 10);
        if (day) dayMap[day] = (dayMap[day] || 0) + (Number(s.cards_studied) || 0);
      }
      const weeklyTrend = Object.entries(dayMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-8)
        .map(([date, count]) => ({ date, count }));

      const analyticsResult = {
        suggestions: { total, accepted, rejected, pending, acceptanceRate: total ? Math.round((accepted / total) * 100) : 0 },
        stars: starsRes.data?.length ?? 0,
        leaderboard,
        cards: {
          total: cards.length,
          byState,
          byDifficulty
        },
        study: {
          sessions: {
            ...sessionTotals,
            accuracyRate: sessionTotals.cardsStudied ? Math.round((sessionTotals.cardsCorrect / sessionTotals.cardsStudied) * 100) : 0
          },
          weeklyTrend,
          strugglingCards
        }
      };

      analyticsCache.set(cacheKey, { data: analyticsResult, expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS });
      res.json({ analytics: analyticsResult });
    } catch (err) { next(err); }
  });

  // Templates
  app.get('/api/templates', async (req, res, next) => {
    try {
      if (!auth.supabase) return res.json({ templates: [] });
      const { category } = req.query;
      let query = auth.supabase.from('templates')
        .select('id, name, description, category, author_name, tags, star_count, is_featured, fields, sample_cards, created_at')
        .order('is_featured', { ascending: false })
        .order('star_count', { ascending: false });
      if (category && category !== 'all') query = query.eq('category', category);
      const { data, error } = await query;
      if (error) fail(500, 'templates_error', error.message);
      res.json({ templates: data || [] });
    } catch (err) { next(err); }
  });

  // Create deck from template
  app.post('/api/templates/:templateId/use', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'templates_unavailable', 'Requires Supabase');
      const { data: tpl } = await auth.supabase.from('templates')
        .select('*').eq('id', req.params.templateId).single();
      if (!tpl) fail(404, 'template_not_found', 'Template not found');

      await auth.supabase.from('profiles').upsert(
        { id: req.user.id, email: req.user.email, name: req.user.name },
        { onConflict: 'id', ignoreDuplicates: true }
      );

      const deckId = randomUUID();
      const now = new Date().toISOString();
      const deckName = req.body.name || tpl.name;

      await auth.supabase.from('decks').insert({
        id: deckId,
        owner_id: req.user.id,
        owner_name: req.user.name,
        name: deckName,
        description: tpl.description,
        imported_at: now,
        last_synced_at: null,
        media: {},
        models: [],
        source: { filename: 'template', format: 'template', templateId: tpl.id },
        visibility: 'private'
      });

      // Seed sample cards from template
      const sampleCards = Array.isArray(tpl.sample_cards) ? tpl.sample_cards : [];
      if (sampleCards.length) {
        const cards = sampleCards.map((fields) => ({
          id: randomUUID(),
          deck_id: deckId,
          anki_note_id: null,
          note_type: 'Basic',
          model_name: tpl.name,
          field_order: (tpl.fields || []).map((f) => f.name),
          fields,
          tags: tpl.tags || [],
          due: null,
          state: 'New',
          modified_at: now,
          modified_by: 'Template',
          suspended: false,
          media_refs: [],
          created_at: now
        }));
        await auth.supabase.from('cards').insert(cards);
      }

      await auth.supabase.from('deck_members').insert({
        deck_id: deckId, user_id: req.user.id, role: 'owner', created_at: now
      });

      res.status(201).json({ deckId, name: deckName });
    } catch (err) { next(err); }
  });

  app.post('/api/study/progress', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) { res.json({ ok: true }); return; }
      const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
      if (!updates.length) { res.json({ ok: true, synced: 0 }); return; }
      const valid = updates
        .filter(u => u.deckId && u.cardId)
        .slice(0, 200)
        .map((u) => ({ ...u, deckId: assertValidDeckId(u.deckId) }));
      let synced = 0;
      for (const u of valid) {
        const id = crypto.randomUUID();
        const { error } = await auth.supabase.from('study_progress').upsert({
          id,
          user_id: req.user.id,
          deck_id: u.deckId,
          card_id: u.cardId,
          interval_days: u.intervalDays ?? 1,
          ease_factor: u.easeFactor ?? 2.5,
          repetitions: u.repetitions ?? 0,
          next_due: u.nextDue ?? new Date().toISOString(),
          last_rating: u.lastRating ?? null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,deck_id,card_id', ignoreDuplicates: false });
        if (!error) synced++;
      }
      res.json({ ok: true, synced });
    } catch (err) { next(err); }
  });

  app.post('/api/study/sessions', auth.requireUser, async (req, res, next) => {
    try {
      if (!repository.createStudySession) fail(501, 'study_sessions_unavailable', 'Study sessions are not available for this repository');
      const session = await repository.createStudySession(req.user, normalizeStudySessionBody(req.user, req.body));
      res.status(201).json({ session });
    } catch (err) { next(err); }
  });

  app.get('/api/study/sessions', auth.requireUser, async (req, res, next) => {
    try {
      if (!repository.listStudySessions) fail(501, 'study_sessions_unavailable', 'Study sessions are not available for this repository');
      const deckId = typeof req.query.deckId === 'string' && req.query.deckId.trim() ? assertValidDeckId(req.query.deckId) : null;
      const sessions = await repository.listStudySessions(req.user, deckId, { limit: req.query.limit });
      res.json({ sessions });
    } catch (err) { next(err); }
  });

  app.get('/api/study/sessions/:deckId', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      if (!repository.listStudySessions) fail(501, 'study_sessions_unavailable', 'Study sessions are not available for this repository');
      const deckId = deckIdFromRequest(req);
      const sessions = await repository.listStudySessions(req.user, deckId, { limit: req.query.limit });
      res.json({ sessions });
    } catch (err) { next(err); }
  });

  app.get('/api/study/progress/:deckId', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      if (!auth.supabase) { res.json({ progress: [] }); return; }
      const { data, error } = await auth.supabase.from('study_progress')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('deck_id', deckId);
      if (error) fail(500, 'progress_error', error.message);
      res.json({ progress: (data || []).map(p => ({
        cardId: p.card_id,
        intervalDays: p.interval_days,
        easeFactor: Number(p.ease_factor),
        repetitions: p.repetitions,
        nextDue: p.next_due,
        lastRating: p.last_rating,
        updatedAt: p.updated_at
      })) });
    } catch (err) { next(err); }
  });

  app.post('/api/decks/:deckId/sync/conflicts', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      const conflicts = Array.isArray(req.body.conflicts) ? req.body.conflicts : [];
      res.json(await repository.recordSyncConflicts(req.user, deckId, conflicts));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/decks/:deckId/sync/cards', validateDeckIdParam, auth.requireUser, async (req, res, next) => {
    try {
      const deckId = deckIdFromRequest(req);
      let syncInput;
      try {
        syncInput = normalizeAddonSyncInput(req.body);
      } catch (error) {
        fail(400, 'invalid_sync_payload', error.message);
      }
      if (!repository.syncCardsFromAddon) fail(501, 'sync_unavailable', 'Card sync is not available for this repository');
      res.json(await repository.syncCardsFromAddon(req.user, deckId, syncInput));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/anki/status', auth.requireUser, async (_req, res, next) => {
    try {
      if (production) {
        res.json({ connected: false, version: null, error: 'Use the per-user local bridge for AnkiConnect sync.' });
        return;
      }
      const state = await loadState();
      const status = await checkAnki(state.sync.ankiConnectUrl);
      state.sync.connected = status.connected;
      state.sync.lastCheckedAt = new Date().toISOString();
      state.sync.lastError = status.error;
      await saveState(state);
      res.json({ ...status, sync: state.sync });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/anki/pull', auth.requireUser, async (req, res, next) => {
    try {
      if (production) fail(410, 'local_bridge_required', 'Hosted production uses the per-user local bridge for Anki pull.');
      const state = await loadState();
      const requestedDeckId = req.body.deckId ? assertValidDeckId(req.body.deckId) : state.activeDeckId;
      const deck = state.decks.find((item) => item.id === requestedDeckId);
      if (!deck) fail(404, 'deck_not_found', 'Deck not found');
      const pulledCards = await pullDeck(deck.name, state.sync.ankiConnectUrl);
      const conflicts = [];
      for (const pulled of pulledCards) {
        const local = deck.cards.find((card) => card.ankiNoteId && card.ankiNoteId === pulled.ankiNoteId);
        if (!local) {
          deck.cards.push(pulled);
        } else if (JSON.stringify(local.fields) !== JSON.stringify(pulled.fields)) {
          conflicts.push({
            cardId: local.id,
            source: 'Anki',
            incomingFields: pulled.fields,
            localFields: local.fields
          });
        }
      }
      await repository.recordSyncConflicts(req.user, deck.id, conflicts);
      res.json(await repository.getDeckState(req.user, deck.id));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/anki/push', auth.requireUser, async (req, res, next) => {
    try {
      if (production) fail(410, 'local_bridge_required', 'Hosted production uses the per-user local bridge for Anki push.');
      const state = await loadState();
      const requestedDeckId = req.body.deckId ? assertValidDeckId(req.body.deckId) : state.activeDeckId;
      const deck = state.decks.find((item) => item.id === requestedDeckId);
      if (!deck) fail(404, 'deck_not_found', 'Deck not found');
      if (state.sync.conflicts.length) fail(409, 'sync_conflicts', 'Resolve Anki pull conflicts before pushing');
      const result = await pushDeck(deck, state.sync.ankiConnectUrl);
      res.json({ result, state: await repository.getDeckState(req.user, deck.id) });
    } catch (error) {
      next(error);
    }
  });

  if (production) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, {
      dotfiles: 'deny',
      index: false,
      setHeaders(res) {
        res.set('Cache-Control', 'public, max-age=3600');
      }
    }));
    app.get(/.*/, async (_req, res, next) => {
      try {
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(distDir, 'index.html'));
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((error, _req, res, _next) => {
    const uploadClientErrors = new Set(['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT']);
    const normalized = uploadClientErrors.has(error.code)
      ? new AppError(400, error.code.toLowerCase(), error.message)
      : error;
    const { status, body } = errorPayload(normalized, production);
    if (status >= 500) console.error(error);
    res.status(status).json({
      ...body,
      legacyError: legacyErrorMessage(body)
    });
  });

  return app;
}
