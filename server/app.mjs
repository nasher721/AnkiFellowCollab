import cors from 'cors';
import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import { createAuth } from './auth.mjs';
import { deckToCreateDeckJson, normalizeAddonSyncInput, normalizeParsedDeck, normalizeSuggestionInput } from './domain.mjs';
import { AppError, errorPayload, fail } from './errors.mjs';
import { checkAnki, pullDeck, pushDeck } from './ankiConnect.mjs';
import { createApkg, parseApkg } from './ankiPackage.mjs';
import { createRepository } from './repositories/index.mjs';
import { ensureDataDirs, loadState, paths, saveState } from './store.mjs';
import { createUserToken, listUserTokens, revokeUserToken } from './tokens.mjs';

function legacyErrorMessage(body) {
  return body.error?.message || body.error || 'Unexpected server error';
}

export function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const app = express();
  const repository = options.repository || createRepository(options);
  const auth = options.auth || createAuth({ ...options, production });
  const parsePackage = options.parseApkg || parseApkg;
  const createPackage = options.createApkg || createApkg;
  const upload = multer({
    dest: paths().uploadsDir,
    limits: { fileSize: Number(process.env.MAX_APKG_BYTES || 250 * 1024 * 1024), files: 1 },
    fileFilter: (_req, file, cb) => {
      if (/\.apkg$/i.test(file.originalname)) cb(null, true);
      else cb(new AppError(400, 'invalid_upload_type', 'Only .apkg uploads are supported'));
    }
  });
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? (production ? false : true);

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
      res.json(await repository.getMe(req.user));
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
      const token = await createUserToken(auth.supabase, req.user.id, label);
      res.status(201).json(token);
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

  app.get('/api/addon/version', (_req, res) => {
    res.json({ version: '0.2.0', minVersion: '0.1.0' });
  });

  app.get('/api/addon/download', async (_req, res, next) => {
    try {
      const addonPath = path.resolve(process.cwd(), 'dist', 'deckbridge-sync.ankiaddon');
      try {
        await fs.access(addonPath);
      } catch {
        fail(404, 'addon_not_built', 'Add-on package not found. Run npm run package:anki-addon first.');
      }
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="deckbridge-sync.ankiaddon"',
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

  app.get('/api/decks/:deckId', auth.requireUser, async (req, res, next) => {
    try {
      res.json(await repository.getDeckState(req.user, req.params.deckId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/state', auth.requireUser, async (req, res, next) => {
    try {
      res.json(await repository.getDeckState(req.user, req.query.deckId));
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/session', auth.requireUser, async (req, res, next) => {
    try {
      if (production) fail(404, 'not_found', 'Demo session controls are not available in production');
      if (req.body.activeDeckId && repository.setActiveDeck) {
        res.json(await repository.setActiveDeck(req.user, req.body.activeDeckId));
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

  async function createSuggestion(req, res, next) {
    try {
      const deckState = await repository.getDeckState(req.user, req.params.deckId || req.body.deckId);
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

  app.post('/api/decks/:deckId/suggestions', auth.requireUser, createSuggestion);
  app.post('/api/suggestions', auth.requireUser, createSuggestion);

  app.post('/api/suggestions/:id/decision', auth.requireUser, async (req, res, next) => {
    try {
      if (!['accepted', 'rejected', 'revision'].includes(req.body.decision)) {
        fail(400, 'invalid_decision', 'Decision must be accepted, rejected, or revision');
      }
      res.json(await repository.decideSuggestion(req.user, req.params.id, req.body.decision));
    } catch (error) {
      next(error);
    }
  });

  async function createExport(req, res, next) {
    try {
      const deckId = req.params.deckId || req.body.deckId;
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

  app.post('/api/decks/:deckId/export', auth.requireUser, createExport);
  app.post('/api/decks/export', auth.requireUser, createExport);

  app.post('/api/decks/:deckId/sync/conflicts', auth.requireUser, async (req, res, next) => {
    try {
      const conflicts = Array.isArray(req.body.conflicts) ? req.body.conflicts : [];
      res.json(await repository.recordSyncConflicts(req.user, req.params.deckId, conflicts));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/decks/:deckId/sync/cards', auth.requireUser, async (req, res, next) => {
    try {
      let syncInput;
      try {
        syncInput = normalizeAddonSyncInput(req.body);
      } catch (error) {
        fail(400, 'invalid_sync_payload', error.message);
      }
      if (!repository.syncCardsFromAddon) fail(501, 'sync_unavailable', 'Card sync is not available for this repository');
      res.json(await repository.syncCardsFromAddon(req.user, req.params.deckId, syncInput));
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
      const deck = state.decks.find((item) => item.id === (req.body.deckId || state.activeDeckId));
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
      const deck = state.decks.find((item) => item.id === (req.body.deckId || state.activeDeckId));
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
