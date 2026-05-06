import cors from 'cors';
import crypto, { randomUUID } from 'node:crypto';
import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import { createAuth } from './auth.mjs';
import { requireContributor, requireEditor, requireOwner, requireReviewer, resolveSuggestionDeck } from './rbac.mjs';
import { deckToCreateDeckJson, normalizeAddonSyncInput, normalizeParsedDeck, normalizeSuggestionInput } from './domain.mjs';
import { AppError, errorPayload, fail } from './errors.mjs';
import { checkAnki, pullDeck, pushDeck } from './ankiConnect.mjs';
import { createApkg, parseApkg } from './ankiPackage.mjs';
import { createRepository } from './repositories/index.mjs';
import { ensureDataDirs, loadState, paths, saveState } from './store.mjs';
import { createUserToken, listUserTokens, revokeUserToken } from './tokens.mjs';

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

  app.post('/api/decks/:deckId/suggestions', auth.requireUser, requireContributor(auth.supabase), createSuggestion);
  app.post('/api/suggestions', auth.requireUser, requireContributor(auth.supabase), createSuggestion);

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

  // --- Comments ---

  app.get('/api/suggestions/:id/comments', auth.requireUser, resolveSuggestionDeck(auth.supabase), requireContributor(auth.supabase), async (req, res, next) => {
    try {
      if (!auth.supabase) return res.json({ comments: [] });
      const { data, error } = await auth.supabase
        .from('comments')
        .select('id, author_id, author_name, body, parent_id, created_at, updated_at')
        .eq('suggestion_id', req.params.id)
        .order('created_at', { ascending: true });
      if (error) fail(500, 'comments_error', error.message);
      res.json({ comments: data });
    } catch (err) { next(err); }
  });

  app.post('/api/suggestions/:id/comments', auth.requireUser, resolveSuggestionDeck(auth.supabase), requireContributor(auth.supabase), async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'comments_unavailable', 'Comments require Supabase');
      const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
      if (!body) fail(400, 'empty_comment', 'Comment body is required');
      const deckId = req._resolvedDeckId;
      const id = crypto.randomUUID();
      const { data, error } = await auth.supabase.from('comments').insert({
        id,
        suggestion_id: req.params.id,
        deck_id: deckId,
        author_id: req.user.id,
        author_name: req.user.name,
        body,
        parent_id: req.body.parentId || null,
        created_at: new Date().toISOString()
      }).select().single();
      if (error) fail(500, 'comment_error', error.message);
      // Create notification for suggestion author
      const { data: sugg } = await auth.supabase.from('suggestions')
        .select('author_id').eq('id', req.params.id).single();
      if (sugg?.author_id && sugg.author_id !== req.user.id) {
        await auth.supabase.from('notifications').insert({
          id: crypto.randomUUID(),
          user_id: sugg.author_id,
          deck_id: deckId,
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
          deck_id: deckId,
              kind: 'mention',
              body: `${req.user.name} mentioned you in a comment`,
              ref_id: id,
              created_at: new Date().toISOString()
            });
          }
        })).then(() => undefined).catch(() => undefined);
      }
      res.status(201).json(data);
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
      if (!auth.supabase) return res.json({ notifications: [], unread: 0 });
      const { data } = await auth.supabase.from('notifications')
        .select('id, deck_id, kind, body, ref_id, read, created_at')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      const unread = (data || []).filter((n) => !n.read).length;
      res.json({ notifications: data || [], unread });
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

  function escapeCsv(value) {
    const str = String(value ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  app.get('/api/decks/:deckId/export/csv', auth.requireUser, async (req, res, next) => {
    try {
      const deckState = await repository.getDeckState(req.user, req.params.deckId);
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

  app.get('/api/decks/:deckId/export/activity', auth.requireUser, async (req, res, next) => {
    try {
      const deckState = await repository.getDeckState(req.user, req.params.deckId);
      const activities = deckState.activity || [];

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

      const decks = (data || []).map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        ownerName: d.owner_name,
        importedAt: d.imported_at,
        downloadCount: d.download_count,
        starCount: d.deck_stars?.[0]?.count ?? 0,
        forkedFrom: d.fork_of ?? null,
      }));
      res.json({ decks });
    } catch (err) { next(err); }
  });

  // Make a deck public/private/unlisted
  app.patch('/api/decks/:deckId/visibility', auth.requireUser, requireOwner(auth.supabase), async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'visibility_unavailable', 'Requires Supabase');
      const allowed = ['public', 'private', 'unlisted'];
      if (!allowed.includes(req.body.visibility)) fail(400, 'invalid_visibility', `Must be one of: ${allowed.join(', ')}`);
      const { error } = await auth.supabase.from('decks')
        .update({ visibility: req.body.visibility })
        .eq('id', req.params.deckId);
      if (error) fail(500, 'visibility_error', error.message);
      res.json({ visibility: req.body.visibility });
    } catch (err) { next(err); }
  });

  // Fork a public deck into the requester's workspace
  app.post('/api/decks/:deckId/fork', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'fork_unavailable', 'Requires Supabase');
      // Load source deck (must be public or member)
      const { data: source, error: srcErr } = await auth.supabase
        .from('decks').select('*').eq('id', req.params.deckId).single();
      if (srcErr || !source) fail(404, 'deck_not_found', 'Deck not found');
      if (source.visibility !== 'public') {
        const { data: m } = await auth.supabase.from('deck_members')
          .select('role').eq('deck_id', req.params.deckId).eq('user_id', req.user.id).single();
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
        fork_of: req.params.deckId
      });

      // Copy cards
      const { data: cards } = await auth.supabase.from('cards')
        .select('*').eq('deck_id', req.params.deckId);
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
        .eq('id', req.params.deckId);

      res.status(201).json({ deckId: forkId, name: `${source.name} (fork)` });
    } catch (err) { next(err); }
  });

  // Star / unstar a deck
  app.post('/api/decks/:deckId/star', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) fail(501, 'stars_unavailable', 'Requires Supabase');
      await auth.supabase.from('deck_stars').upsert(
        { deck_id: req.params.deckId, user_id: req.user.id, created_at: new Date().toISOString() },
        { onConflict: 'deck_id,user_id', ignoreDuplicates: true }
      );
      const { count } = await auth.supabase.from('deck_stars')
        .select('*', { count: 'exact', head: true }).eq('deck_id', req.params.deckId);
      res.json({ starred: true, count: count ?? 0 });
    } catch (err) { next(err); }
  });

  app.delete('/api/decks/:deckId/star', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) return res.status(204).end();
      await auth.supabase.from('deck_stars')
        .delete().eq('deck_id', req.params.deckId).eq('user_id', req.user.id);
      const { count } = await auth.supabase.from('deck_stars')
        .select('*', { count: 'exact', head: true }).eq('deck_id', req.params.deckId);
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

  // Deck analytics
  app.get('/api/decks/:deckId/analytics', auth.requireUser, requireEditor(auth.supabase), async (req, res, next) => {
    try {
      if (!auth.supabase) return res.json({ analytics: null });

      const [suggestionsRes, starsRes] = await Promise.all([
        auth.supabase.from('suggestions').select('status, author_id, author_name, created_at')
          .eq('deck_id', req.params.deckId),
        auth.supabase.from('deck_stars').select('user_id')
          .eq('deck_id', req.params.deckId)
      ]);

      const suggestions = suggestionsRes.data || [];
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

      res.json({
        analytics: {
          suggestions: { total, accepted, rejected, pending, acceptanceRate: total ? Math.round((accepted / total) * 100) : 0 },
          stars: starsRes.data?.length ?? 0,
          leaderboard,
        }
      });
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
      const valid = updates.filter(u => u.deckId && u.cardId).slice(0, 200);
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

  app.get('/api/study/progress/:deckId', auth.requireUser, async (req, res, next) => {
    try {
      if (!auth.supabase) { res.json({ progress: [] }); return; }
      const { data, error } = await auth.supabase.from('study_progress')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('deck_id', req.params.deckId);
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
