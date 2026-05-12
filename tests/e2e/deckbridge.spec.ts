import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function createMinimalApkg(apkgPath: string) {
  const script = String.raw`
import json, os, sqlite3, sys, time, zipfile

apkg_path = sys.argv[1]
workdir = os.path.dirname(apkg_path)
db_path = os.path.join(workdir, 'collection.anki2')
if os.path.exists(db_path):
    os.remove(db_path)

model_id = 1607392319000
deck_id = 2059400110
note_id = 1777777777000
card_id = 1777777777001
now = int(time.time())
models = {
    str(model_id): {
        'id': model_id,
        'name': 'Basic',
        'flds': [{'name': 'Front'}, {'name': 'Back'}],
        'tmpls': [{
            'name': 'Card 1',
            'qfmt': '{{Front}}',
            'afmt': '{{FrontSide}}<hr id=answer>{{Back}}',
        }],
        'css': '.card { font-family: Arial; }',
    }
}
decks = {str(deck_id): {'id': deck_id, 'name': 'Actual Upload Deck'}}

con = sqlite3.connect(db_path)
con.execute('create table col (models text, decks text)')
con.execute('create table notes (id integer, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text)')
con.execute('create table cards (id integer, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text)')
con.execute('insert into col (models, decks) values (?, ?)', (json.dumps(models), json.dumps(decks)))
con.execute(
    'insert into notes values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    (note_id, 'actual-upload-guid', model_id, now, -1, 'Actual Upload', 'Actual APKG front\x1fActual APKG back', 'Actual APKG front', 0, 0, ''),
)
con.execute(
    'insert into cards values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    (card_id, note_id, deck_id, 0, now, -1, 0, 0, 0, 0, 2500, 0, 0, 0, 0, 0, 0, ''),
)
con.commit()
con.close()

with zipfile.ZipFile(apkg_path, 'w', compression=zipfile.ZIP_DEFLATED) as package:
    package.write(db_path, 'collection.anki2')
`;
  await execFileAsync('python3', ['-c', script, apkgPath]);
}

test.describe('Workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads the app with demo deck', async ({ page }) => {
    await expect(page.getByText('DeckBridge')).toBeVisible();
    await expect(page.getByRole('button', { name: /Zanki Step 2 CK/ })).toBeVisible();
    await expect(page.locator('.context-rail--overview').getByText('Quality Review')).toBeVisible();
    await expect(page.locator('.context-rail--overview').getByText('Owner Attention')).toBeVisible();
  });

  test('displays cards in the table', async ({ page }) => {
    await expect(page.getByRole('row', { name: /Microscopic polyangiitis/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /H\. pylori/ })).toBeVisible();
  });

  test('searches cards', async ({ page }) => {
    const search = page.getByPlaceholder('Search cards...');
    await search.fill('Vitamin');
    await expect(page.getByRole('row', { name: /subacute combined degeneration/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Microscopic polyangiitis/ })).toHaveCount(0);
  });

  test('filters by tag', async ({ page }) => {
    await page.getByLabel('Filter by tag').selectOption('Rheumatology');
    await expect(page.getByRole('row', { name: /Microscopic polyangiitis/ })).toBeVisible();
  });

  test('switches decks', async ({ page }) => {
    await expect(page.locator('.deck-item.active')).toBeVisible();
  });

  test('pagination works', async ({ page }) => {
    await expect(page.locator('.pagination-row')).toBeVisible();
  });
});

test.describe('Review Queue', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
  });

  test('shows pending suggestions', async ({ page }) => {
    await expect(page.getByText('1 pending')).toBeVisible();
    await expect(page.getByRole('button', { name: /Pending suggestion.*Maya Patel.*pending/i })).toBeVisible();
    await expect(page.getByText('Quality Review Workspace')).toBeVisible();
    await expect(page.locator('.context-rail')).toHaveCount(0);
    await expect(page.locator('.review-quality-summary').getByRole('button', { name: /Answer changed/ })).toBeVisible();
  });

  test('filters the review queue by status and author', async ({ page }) => {
    await expect(page.getByLabel('Filter review queue by status')).toHaveValue('pending');
    await page.getByLabel('Filter review queue by author').selectOption('Maya Patel');
    await expect(page.getByRole('button', { name: /Pending suggestion.*Maya Patel.*pending/i })).toBeVisible();
    await page.getByLabel('Filter review queue by status').selectOption('accepted');
    await expect(page.getByText('No quality review items match the current filters.')).toBeVisible();
    await page.getByRole('button', { name: /Reset review filters/ }).click();
    await expect(page.getByRole('button', { name: /Pending suggestion.*Maya Patel.*pending/i })).toBeVisible();
  });

  test('displays suggestion diff', async ({ page }) => {
    await expect(
      page.frameLocator('.card-preview-comparison iframe').nth(2).getByText(/ANCA autoantibody/)
    ).toBeVisible();
  });

  test('owner can accept suggestion', async ({ page }) => {
    await page.getByRole('button', { name: /Accept/ }).click();
    await expect(page.getByText(/Suggestion accepted/)).toBeVisible();
  });

  test('owner can reject suggestion', async ({ page }) => {
    await page.getByRole('button', { name: 'Contributor' }).click();
    await page.getByRole('button', { name: /Suggest edit/ }).click();
    await expect(page.getByText(/Suggestion added/)).toBeVisible();
    await page.getByRole('button', { name: 'Owner' }).click();
    await page.getByRole('button', { name: /Reject/ }).click();
    await expect(page.getByText(/Suggestion rejected/)).toBeVisible();
  });

  test('collaborator can suggest edit', async ({ page }) => {
    await page.getByRole('button', { name: 'Contributor' }).click();
    await page.getByRole('button', { name: /Suggest edit/ }).click();
    await expect(page.getByText(/Suggestion added/)).toBeVisible();
  });

  test('supports the review path on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.review-quality-summary').getByRole('button', { name: /Answer changed/ }).click();
    await page.locator('.quality-queue-main').first().click();
    await expect(page.getByRole('heading', { name: /Microscopic polyangiitis/ })).toBeVisible();
    await expect(page.getByText('Rendered HTML missing', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark checked' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Accept/ })).toBeVisible();
  });

  test('keeps source-check marks visible in the queue and inspection panel', async ({ page }) => {
    await page.locator('.review-quality-summary').getByRole('button', { name: /Answer changed/ }).click();
    await page.locator('.quality-queue-main').first().click();

    await expect(page.locator('.quality-queue-item.active').getByText('Needs source check')).toBeVisible();
    await expect(page.locator('.review-inspection-panel').getByText('Needs source check')).toBeVisible();

    await page.getByRole('button', { name: 'Mark checked' }).click();
    await expect(page.locator('.quality-queue-item.active').getByText('Source checked this session')).toBeVisible();
    await expect(page.getByText('Source check marked checked in this review session.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark needs source check' })).toBeVisible();

    await page.getByRole('button', { name: 'Mark needs source check' }).click();
    await expect(page.locator('.quality-queue-item.active').getByText('Needs source check this session')).toBeVisible();
    await expect(page.locator('.review-inspection-panel').getByText('Needs source check')).toBeVisible();
  });
});

test.describe('Review Queue conflict inspection', () => {
  test('filters sync conflicts and shows conflict-specific raw diffs with push blocked rationale', async ({ page }) => {
    const detectedAt = '2026-05-08T12:00:00.000Z';
    const buildState = () => ({
      user: { id: 'you', email: 'you@example.com', name: 'You' },
      memberships: [{ deckId: 'deck-review-conflict', userId: 'you', role: 'owner', createdAt: detectedAt }],
      decks: [{
        id: 'deck-review-conflict',
        name: 'Conflict Review Deck',
        description: 'Conflict review deck',
        owner: 'You',
        importedAt: detectedAt,
        lastSyncedAt: detectedAt,
        cards: [
          {
            id: 'card-stale-suggestion',
            ankiNoteId: null,
            type: 'Basic',
            modelName: 'Basic',
            fieldOrder: ['Front', 'Back'],
            fields: { Front: 'Stale suggestion prompt', Back: 'Stale suggestion answer' },
            tags: ['Suggestion'],
            due: null,
            state: 'Review',
            modifiedAt: detectedAt,
            modifiedBy: 'Maya Patel',
            suspended: false,
            mediaRefs: []
          },
          {
            id: 'card-review-conflict',
            ankiNoteId: null,
            type: 'Basic',
            modelName: 'Basic',
            fieldOrder: ['Front', 'Back'],
            fields: { Front: 'Conflict card prompt about cerebral salt wasting?', Back: 'Original platform answer' },
            tags: ['Neuro', 'Conflict'],
            due: null,
            state: 'Review',
            modifiedAt: detectedAt,
            modifiedBy: 'Anki',
            suspended: false,
            mediaRefs: []
          }
        ],
        media: {},
        source: { filename: 'anki', format: 'anki-addon', deckName: 'Conflict Review Deck', deckPath: 'Conflict Review Deck' }
      }],
      summaries: [{
        id: 'deck-review-conflict',
        name: 'Conflict Review Deck',
        description: 'Conflict review deck',
        cardCount: 2,
        noteCount: 2,
        tagCount: 3,
        noteTypes: ['Basic'],
        pendingSuggestions: 1,
        lastSyncedAt: detectedAt,
        importedAt: detectedAt
      }],
      activeDeckId: 'deck-review-conflict',
      role: 'owner',
      collaborators: [
        { id: 'you', name: 'You', email: 'you@example.com', role: 'owner', accepted: 0 },
        { id: 'maya', name: 'Maya Patel', email: 'maya@example.com', role: 'collaborator', accepted: 0 }
      ],
      suggestions: [{
        id: 'stale-selected-suggestion',
        deckId: 'deck-review-conflict',
        cardId: 'card-stale-suggestion',
        authorId: 'maya',
        authorName: 'Maya Patel',
        status: 'pending',
        reason: 'This suggestion must not leak into conflict inspection.',
        createdAt: detectedAt,
        proposedFields: { Back: 'Stale proposed suggestion answer' },
        proposedTags: ['Suggestion']
      }],
      activity: [],
      sync: {
        ankiConnectUrl: null,
        connected: false,
        lastCheckedAt: detectedAt,
        lastPullAt: null,
        lastPushAt: detectedAt,
        lastAddonSync: {
          syncedAt: detectedAt,
          source: 'DeckBridge Sync',
          client: { name: 'DeckBridge Sync', version: '0.1.0', fingerprint: 'test-host' },
          stats: { total: 2, created: 0, updated: 0, skipped: 1, conflicts: 1, dryRun: false }
        },
        conflicts: [{
          id: 'review-conflict-1',
          deckId: 'deck-review-conflict',
          cardId: 'card-review-conflict',
          source: 'DeckBridge Sync',
          detectedAt,
          localFields: {
            Front: 'Conflict card prompt about cerebral salt wasting?',
            Back: 'Local Anki says hypertonic saline plus volume repletion.'
          },
          incomingFields: {
            Front: 'Conflict card prompt about cerebral salt wasting?',
            Back: 'DeckBridge incoming says fluid restriction, which may be unsafe.'
          }
        }]
      }
    });

    await page.route('**/api/state', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildState())
      });
    });
    await page.route('**/api/addon/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'DeckBridge Sync',
          version: '0.1.0',
          minVersion: '23.10.0',
          package: 'deckbridge_sync',
          downloadUrl: '/api/addon/download'
        })
      });
    });
    await page.route('**/api/addon/download', async (route) => {
      if (route.request().method() === 'HEAD') {
        await route.fulfill({ status: 200 });
        return;
      }
      await route.fallback();
    });
    await page.route('**/api/anki/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: false })
      });
    });

    await page.goto('/');
    await page.locator('button').filter({ hasText: /^Review$/ }).click();
    await page.locator('.review-quality-summary').getByRole('button', { name: /Sync conflict/ }).click();
    await expect(page.getByRole('button', { name: /Conflict card prompt about cerebral salt wasting.*Sync conflict/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Conflict card prompt about cerebral salt wasting/ })).toBeVisible();
    await expect(page.getByText('Which source of truth should win?')).toBeVisible();
    await expect(page.getByText('- Local Anki says hypertonic saline plus volume repletion.')).toBeVisible();
    await expect(page.getByText('+ DeckBridge incoming says fluid restriction, which may be unsafe.')).toBeVisible();
    await expect(page.getByText(/Push to Anki is blocked because unresolved sync conflicts/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Push to Anki blocked/ })).toBeDisabled();
    await expect(page.getByText('Stale proposed suggestion answer')).toHaveCount(0);
  });

  test('saves ReviewWorkspace conflict decisions and replays them after rehydration', async ({ page }) => {
    const detectedAt = '2026-05-08T12:00:00.000Z';
    const syncConflict = {
      id: 'review-workspace-conflict-1',
      deckId: 'deck-review-workspace-conflict',
      cardId: 'card-review-workspace-conflict',
      source: 'DeckBridge Sync',
      detectedAt,
      localFields: {
        Front: 'Conflict prompt from local Anki?',
        Back: 'Local Anki answer remains source-backed.'
      },
      incomingFields: {
        Front: 'Conflict prompt from local Anki?',
        Back: 'DeckBridge answer is different and needs owner decision.'
      }
    };
    const buildState = () => ({
      user: { id: 'you', email: 'you@example.com', name: 'You' },
      memberships: [{ deckId: 'deck-review-workspace-conflict', userId: 'you', role: 'owner', createdAt: detectedAt }],
      decks: [{
        id: 'deck-review-workspace-conflict',
        name: 'Review Workspace Conflict Deck',
        description: 'Conflict review deck',
        owner: 'You',
        importedAt: detectedAt,
        lastSyncedAt: detectedAt,
        cards: [{
          id: 'card-review-workspace-conflict',
          ankiNoteId: null,
          type: 'Basic',
          modelName: 'Basic',
          fieldOrder: ['Front', 'Back'],
          fields: { Front: 'Conflict prompt from local Anki?', Back: 'Original platform answer' },
          tags: ['Neuro', 'Conflict'],
          due: null,
          state: 'Review',
          modifiedAt: detectedAt,
          modifiedBy: 'Anki',
          suspended: false,
          mediaRefs: []
        }],
        media: {},
        source: { filename: 'anki', format: 'anki-addon', deckName: 'Review Workspace Conflict Deck', deckPath: 'Review Workspace Conflict Deck' }
      }],
      summaries: [{
        id: 'deck-review-workspace-conflict',
        name: 'Review Workspace Conflict Deck',
        description: 'Conflict review deck',
        cardCount: 1,
        noteCount: 1,
        tagCount: 2,
        noteTypes: ['Basic'],
        pendingSuggestions: 0,
        lastSyncedAt: detectedAt,
        importedAt: detectedAt
      }],
      activeDeckId: 'deck-review-workspace-conflict',
      role: 'owner',
      collaborators: [{ id: 'you', name: 'You', email: 'you@example.com', role: 'owner', accepted: 0 }],
      suggestions: [],
      activity: [],
      sync: {
        ankiConnectUrl: null,
        connected: false,
        lastCheckedAt: detectedAt,
        lastPullAt: null,
        lastPushAt: detectedAt,
        lastAddonSync: {
          syncedAt: detectedAt,
          source: 'DeckBridge Sync',
          client: { name: 'DeckBridge Sync', version: '0.1.0', fingerprint: 'test-host' },
          stats: { total: 1, created: 0, updated: 0, skipped: 1, conflicts: 1, dryRun: false }
        },
        conflicts: [syncConflict]
      }
    });
    let stateRequests = 0;

    await page.route('**/api/state', async (route) => {
      stateRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildState())
      });
    });
    await page.route('**/api/addon/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'DeckBridge Sync',
          version: '0.1.0',
          minVersion: '23.10.0',
          package: 'deckbridge_sync',
          downloadUrl: '/api/addon/download'
        })
      });
    });
    await page.route('**/api/addon/download', async (route) => {
      if (route.request().method() === 'HEAD') {
        await route.fulfill({ status: 200 });
        return;
      }
      await route.fallback();
    });
    await page.route('**/api/anki/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: false })
      });
    });

    await page.goto('/');
    await page.locator('button').filter({ hasText: /^Review$/ }).click();
    await page.locator('.review-quality-summary').getByRole('button', { name: /Sync conflict/ }).click();
    await expect(page.getByRole('button', { name: /Conflict prompt from local Anki.*Sync conflict/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Push to Anki blocked/ })).toBeDisabled();

    await page.getByRole('button', { name: 'Keep local Anki' }).click();
    await expect(page.locator('.review-quality-summary').getByRole('button', { name: /Sync conflict 0/ })).toBeVisible();
    await expect(page.getByText(/Push to Anki is blocked because unresolved sync conflicts/)).toHaveCount(0);
    const savedDecision = await page.evaluate(() => (
      Object.keys(window.localStorage).some((key) => key.startsWith('deckbridge-conflict-decisions'))
    ));
    expect(savedDecision).toBe(true);

    const requestsAfterDecision = stateRequests;
    await page.locator('button[title="Check"]').click();
    await expect.poll(() => stateRequests, { timeout: 20_000 }).toBeGreaterThan(requestsAfterDecision);
    await expect(page.locator('.review-quality-summary').getByRole('button', { name: /Sync conflict 0/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Conflict prompt from local Anki.*Sync conflict/i })).toHaveCount(0);
  });
});

test.describe('Conflict Resolution', () => {
  test('replays saved conflict decisions when polling rehydrates pending conflicts', async ({ page }) => {
    const detectedAt = '2026-05-08T12:00:00.000Z';
    const syncConflict = {
      id: 'conflict-replay-1',
      deckId: 'deck-replay',
      cardId: 'card-replay',
      source: 'DeckBridge Sync',
      detectedAt,
      incomingFields: { Front: 'Incoming front', Back: 'Incoming answer' },
      localFields: { Front: 'Local front', Back: 'Local answer' }
    };
    let serverConflicts = [syncConflict];
    const buildState = () => ({
      user: { id: 'you', email: 'you@example.com', name: 'You' },
      memberships: [{ deckId: 'deck-replay', userId: 'you', role: 'owner', createdAt: detectedAt }],
      decks: [{
        id: 'deck-replay',
        name: 'Replay Deck',
        description: 'Conflict replay deck',
        owner: 'You',
        importedAt: detectedAt,
        lastSyncedAt: detectedAt,
        cards: [{ id: 'card-replay', fields: { Front: 'Local front', Back: 'Local answer' }, tags: [], noteType: 'Basic', modifiedAt: detectedAt, modifiedBy: 'Anki', suspended: false }],
        media: {},
        source: { filename: 'anki', format: 'anki-addon', deckName: 'Replay Deck', deckPath: 'Replay Deck' }
      }],
      summaries: [{
        id: 'deck-replay',
        name: 'Replay Deck',
        description: 'Conflict replay deck',
        cardCount: 1,
        noteCount: 1,
        tagCount: 0,
        noteTypes: ['Basic'],
        pendingSuggestions: 0,
        lastSyncedAt: detectedAt,
        importedAt: detectedAt
      }],
      activeDeckId: 'deck-replay',
      role: 'owner',
      collaborators: [{ id: 'you', name: 'You', email: 'you@example.com', role: 'owner', accepted: 0 }],
      suggestions: [],
      activity: [],
      sync: {
        ankiConnectUrl: null,
        connected: false,
        lastCheckedAt: detectedAt,
        lastPullAt: null,
        lastPushAt: detectedAt,
        lastAddonSync: {
          syncedAt: detectedAt,
          source: 'DeckBridge Sync',
          client: { name: 'DeckBridge Sync', version: '0.1.0', fingerprint: 'test-host' },
          stats: { total: 1, created: 0, updated: 0, skipped: 0, conflicts: 1, dryRun: false }
        },
        conflicts: serverConflicts
      }
    });
    let stateRequests = 0;
    await page.route('**/api/state', async (route) => {
      stateRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildState())
      });
    });
    await page.route('**/api/addon/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'DeckBridge Sync',
          version: '0.1.0',
          minVersion: '23.10.0',
          package: 'deckbridge_sync',
          downloadUrl: '/api/addon/download'
        })
      });
    });
    await page.route('**/api/addon/download', async (route) => {
      if (route.request().method() === 'HEAD') {
        await route.fulfill({ status: 200 });
        return;
      }
      await route.fallback();
    });
    await page.route('**/api/anki/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: false })
      });
    });

    await page.goto('/');
    await expect(page.getByText('Conflicts need review')).toBeVisible();
    await page.getByRole('button', { name: 'Keep Local' }).click();
    await expect(page.getByText('Conflicts need review')).toHaveCount(0);
    await expect(page.getByText('No unresolved conflicts in this saved review.')).toBeVisible();

    const requestsAfterDecision = stateRequests;
    await page.locator('button[title="Check"]').click();
    await expect.poll(() => stateRequests, { timeout: 20_000 }).toBeGreaterThan(requestsAfterDecision);
    await expect(page.getByText('Conflicts need review')).toHaveCount(0);
    await expect(page.getByText('No unresolved conflicts in this saved review.')).toBeVisible();

    serverConflicts = [];
    const requestsAfterRehydration = stateRequests;
    await page.locator('button[title="Check"]').click();
    await expect.poll(() => stateRequests).toBeGreaterThan(requestsAfterRehydration);
    await expect(page.getByText('No unresolved conflicts in this saved review.')).toHaveCount(0);
  });
});

test.describe('Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('switches to Study tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Study' }).click();
    await expect(page.getByRole('heading', { name: 'Study session' })).toBeVisible();
    await expect(page.getByLabel('Study approved cards only')).toBeChecked();
    await page.getByRole('button', { name: 'Start study session' }).click();
    await expect(page.locator('.study-overlay')).toBeVisible();
  });

  test('renders study card front and back content inside Anki iframes', async ({ page }) => {
    await page.getByRole('button', { name: 'Study' }).click();
    await page.getByRole('button', { name: 'Start study session' }).click();
    await expect(page.locator('.study-overlay')).toBeVisible();

    const frontFrame = page.frameLocator('.study-card-front iframe');
    const frontText = await frontFrame.locator('body').innerText();
    expect(frontText).toMatch(/First-line treatment for H\. pylori infection\?|Vitamin B12/);
    await expect(page.locator('.study-card-front iframe')).toHaveCSS('pointer-events', 'auto');

    await page.locator('.study-flip-hint').click();

    const backFrame = page.frameLocator('.study-card-back iframe');
    const backText = await backFrame.locator('body').innerText();
    if (frontText.includes('H. pylori')) {
      expect(backText).toContain('Bismuth quadruple therapy or clarithromycin triple therapy depending on resistance patterns.');
    } else {
      expect(backText).toContain('Dorsal columns and lateral corticospinal tracts are affected.');
    }
  });

  test('contains focus inside study dialog and restores focus after close', async ({ page }) => {
    await page.getByRole('button', { name: 'Study' }).click();
    await page.getByRole('button', { name: 'Start study session' }).click();
    const dialog = page.locator('.study-overlay');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement;
      return active !== document.body && Boolean(active?.closest('.study-overlay'));
    })).toBe(true);

    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      await expect.poll(() => page.evaluate(() => {
        const active = document.activeElement;
        return active !== document.body && Boolean(active?.closest('.study-overlay'));
      })).toBe(true);
    }

    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+Tab');
      await expect.poll(() => page.evaluate(() => {
        const active = document.activeElement;
        return active !== document.body && Boolean(active?.closest('.study-overlay'));
      })).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Overview' })).toBeFocused();
  });

  test('rating button Enter activation is not overridden by global shortcuts', async ({ page }) => {
    await page.getByRole('button', { name: 'Study' }).click();
    await page.getByRole('button', { name: 'Start study session' }).click();
    await expect(page.locator('.study-overlay')).toBeVisible();

    await page.locator('.study-card').click();
    const againButton = page.getByRole('button', { name: 'Rate Again' });
    await expect(againButton).toBeVisible();
    await againButton.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByText(/Card 2 of/)).toBeVisible();
    await expect(page.getByText('0% accuracy')).toBeVisible();
  });

  test('study card keeps rating shortcuts after click reveal focus', async ({ page }) => {
    await page.getByRole('button', { name: 'Study' }).click();
    await page.getByRole('button', { name: 'Start study session' }).click();
    await expect(page.locator('.study-overlay')).toBeVisible();

    await page.locator('.study-card').click();
    await page.keyboard.press('1');

    await expect(page.getByText(/Card 2 of/)).toBeVisible();
    await expect(page.getByText('0% accuracy')).toBeVisible();
  });

  test('switches to Cards tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveClass(/active/);
    await expect(page.getByRole('row', { name: /Microscopic polyangiitis/ })).toBeVisible();
    await expect(page.locator('.context-rail--card').getByText('Card Context')).toBeVisible();
    await expect(page.locator('.context-rail--card').getByText('Rendered preview')).toBeVisible();
    await expect(page.locator('.context-rail--card').getByText('Quality Review')).toHaveCount(0);
  });

  test('switches to Stats tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Stats' }).click();
    await expect(page.getByText('Deck stats')).toBeVisible();
    await expect(page.getByText('Suggestion flow')).toBeVisible();
  });

  test('switches to Analytics tab', async ({ page }) => {
    let requestedAnalytics = false;
    await page.route('**/api/decks/deck-demo-zanki/analytics', async (route) => {
      requestedAnalytics = true;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          analytics: {
            suggestions: { total: 4, accepted: 2, rejected: 1, pending: 1, acceptanceRate: 50 },
            stars: 3,
            leaderboard: [{ name: 'Maya Patel', total: 3, accepted: 2 }],
            cards: { total: 12, byState: { New: 7, Review: 5 } },
            study: {
              sessions: { total: 1, durationSeconds: 180, cardsStudied: 12, cardsCorrect: 9, accuracyRate: 75 },
              weeklyTrend: [{ date: '2026-05-08', count: 12 }],
              strugglingCards: []
            }
          }
        })
      });
    });

    await page.getByRole('button', { name: 'Analytics' }).click();
    await expect(page.getByRole('button', { name: 'Analytics' })).toHaveClass(/active/);
    await expect(page.locator('[aria-label="Loading analytics"]')).toBeVisible();
    await expect.poll(() => requestedAnalytics).toBe(true);
    await expect(page.locator('[aria-label="Loading analytics"]')).toHaveCount(0);
    await expect(page.getByText('Acceptance rate')).toBeVisible();
    await expect(page.locator('.leaderboard-name', { hasText: 'Maya Patel' })).toBeVisible();
  });

  test('switches to Activity tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.locator('.activity-timeline')).toBeVisible();
  });

  test('switches to Settings tab', async ({ page }) => {
    let listedShareLinks = false;
    let createdShareLink = false;
    await page.route('**/api/decks/deck-demo-zanki/share-links', async (route) => {
      if (route.request().method() === 'GET') {
        listedShareLinks = true;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ shareLinks: [] })
        });
        return;
      }
      if (route.request().method() === 'POST') {
        createdShareLink = true;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            shareLink: {
              id: 'share-link-1',
              deckId: 'deck-demo-zanki',
              token: 'share-token-abc',
              label: 'Zanki share link',
              passwordProtected: false,
              expiresAt: null,
              disabledAt: null,
              createdBy: 'you',
              createdAt: new Date().toISOString()
            }
          })
        });
        return;
      }
      await route.fallback();
    });

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Deck settings')).toBeVisible();
    await expect(page.locator('.context-rail')).toHaveCount(0);
    await expect(page.locator('.settings-note[role="status"]')).toHaveText('Checking share links...');
    await expect.poll(() => listedShareLinks).toBe(true);
    await expect(page.locator('.settings-note[role="status"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Create share link' }).click();
    await expect.poll(() => createdShareLink).toBe(true);
    await expect(page.getByLabel('Deck share link')).toHaveValue(/\/share\/share-token-abc/);
    await expect(page.getByLabel('Deck embed code')).toHaveValue(/\/embed\/decks\/deck-demo-zanki/);
  });
});

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('switches to Discover view', async ({ page }) => {
    await page.getByRole('button', { name: /Discover/ }).click();
    await expect(page.locator('.discover-view')).toBeVisible();
  });

  test('shows discover deck preview fields when the API provides them', async ({ page }) => {
    await page.route('**/api/discover?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          decks: [{
            id: 'public-preview',
            name: 'Public Preview Deck',
            description: 'Previewable deck',
            ownerName: 'You',
            importedAt: new Date().toISOString(),
            downloadCount: 3,
            starCount: 7,
            forkedFrom: null,
            cardCount: 2,
            noteTypes: ['Basic'],
            sampleCards: [{ Front: 'Preview front', Back: 'Preview back' }]
          }]
        })
      });
    });
    await page.getByRole('button', { name: /Discover/ }).click();
    await expect(page.getByText('Public Preview Deck')).toBeVisible();
    await expect(page.getByText('2 cards')).toBeVisible();
    await expect(page.getByText('Preview front')).toBeVisible();
  });

  test('switches to Templates view', async ({ page }) => {
    await page.getByRole('button', { name: /Templates/ }).click();
    await expect(page.locator('.template-gallery')).toBeVisible();
  });

  test('returns to Workspace from Discover', async ({ page }) => {
    await page.getByRole('button', { name: /Discover/ }).click();
    await page.getByRole('button', { name: /Workspace/ }).click();
    await expect(page.getByText('Quality Review')).toBeVisible();
  });
});

test.describe('Connect Anki Wizard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('opens wizard', async ({ page }) => {
    await page.getByRole('button', { name: /Connect Anki/ }).click();
    await expect(page.getByText('Step 1: Install the Add-on')).toBeVisible();
  });

  test('surfaces missing add-on package while preserving download link', async ({ page }) => {
    await page.route('**/api/addon/version', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'DeckBridge Sync',
          version: '0.1.0',
          minVersion: '23.10.0',
          package: 'deckbridge_sync',
          downloadUrl: '/api/addon/download'
        })
      });
    });
    await page.route('**/api/addon/download', async (route) => {
      if (route.request().method() !== 'HEAD') return route.fallback();
      await route.fulfill({ status: 404 });
    });

    await page.getByRole('button', { name: /Connect Anki/ }).click();
    const wizard = page.getByRole('dialog', { name: 'Connect Anki Add-on' });
    await expect(wizard.getByText(/addon_not_built/)).toBeVisible();
    await expect(wizard.getByRole('link', { name: /Download Add-on/ })).toHaveAttribute('href', '/api/addon/download');
  });

  test('navigates wizard steps', async ({ page }) => {
    await page.getByRole('button', { name: /Connect Anki/ }).click();
    await page.getByRole('button', { name: /Already installed/ }).click();
    await expect(page.getByText('Step 2: Authorize Anki')).toBeVisible();
  });

  test('closes wizard', async ({ page }) => {
    await page.getByRole('button', { name: /Connect Anki/ }).click();
    await page.getByRole('button', { name: /Close/ }).click();
    await expect(page.getByText('Step 1')).not.toBeVisible();
  });

  test('generates token, tests access, and shows deck mapping contract', async ({ page }) => {
    await page.route('**/api/tokens', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'token-1',
          raw: 'db_test_token',
          label: 'Anki Add-on',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        })
      });
    });
    await page.route('**/api/me', async (route) => {
      if (route.request().headers().authorization !== 'Bearer db_test_token') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'you', email: 'you@example.com', name: 'You' },
          memberships: [],
          decks: [{
            id: 'deck-visible',
            name: 'Visible Deck',
            description: 'Token-visible deck',
            cardCount: 12,
            noteCount: 10,
            tagCount: 3,
            noteTypes: ['Basic'],
            pendingSuggestions: 0,
            lastSyncedAt: null,
            importedAt: new Date().toISOString()
          }]
        })
      });
    });

    await page.getByRole('button', { name: /Connect Anki/ }).click();
    await page.getByRole('button', { name: /Already installed/ }).click();
    await page.getByRole('button', { name: 'Create connection link' }).click();

    await expect(page.getByText('Step 3: Map Your Deck')).toBeVisible();
    await expect(page.getByText(/Connected as You/)).toBeVisible();
    await expect(page.getByLabel('DeckBridge Deck')).toHaveValue('deck-visible');
    await expect(page.getByRole('link', { name: /Open connection link/ })).toHaveAttribute(
      'href',
      'anki://deckbridge?url=http%3A%2F%2F127.0.0.1%3A5174&token=db_test_token&deckId=deck-visible&conflictPolicy=detect'
    );
    await page.getByRole('button', { name: 'Show manual token fallback' }).click();
    await expect(page.getByText('db_test_token')).toBeVisible();
    await page.getByLabel('Conflict Policy').selectOption('overwrite-platform');
    await page.getByLabel('Local Anki Deck').fill('Zanki Step 2 CK::Cardiology');
    await expect(page.getByText('DeckBridge deck ID: deck-visible')).toBeVisible();
    await expect(page.getByText('Local Anki deck: Zanki Step 2 CK::Cardiology')).toBeVisible();
    await expect(page.getByText('Conflict policy: overwrite-platform')).toBeVisible();
    await expect(page.getByRole('link', { name: /Open connection link/ })).toHaveAttribute(
      'href',
      'anki://deckbridge?url=http%3A%2F%2F127.0.0.1%3A5174&token=db_test_token&deckId=deck-visible&localDeck=Zanki%20Step%202%20CK%3A%3ACardiology&conflictPolicy=overwrite-platform'
    );

    await page.getByRole('button', { name: 'Manual setup' }).click();
    await expect(page.getByRole('heading', { name: 'Manual setup' })).toBeVisible();
    await expect(page.getByText('Platform URL')).toBeVisible();
    await expect(page.getByText('API Token')).toBeVisible();
    await expect(page.getByText('db_test_token')).toBeVisible();
    await page.getByRole('button', { name: /Prove sync/ }).click();
    await expect(page.getByText('Step 4: Prove Sync')).toBeVisible();
    await expect(page.getByText('Waiting for add-on proof')).toBeVisible();
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(page.getByText('Step 3: Map Your Deck')).toBeVisible();
  });

  test('continues from mapping into first sync proof', async ({ page }) => {
    await page.route('**/api/tokens', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'token-proof',
          raw: 'db_proof_token',
          label: 'Anki Add-on',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        })
      });
    });
    await page.route('**/api/me', async (route) => {
      if (route.request().headers().authorization !== 'Bearer db_proof_token') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'you', email: 'you@example.com', name: 'You' },
          memberships: [],
          decks: [{
            id: 'deck-visible',
            name: 'Visible Deck',
            description: 'Token-visible deck',
            cardCount: 12,
            noteCount: 10,
            tagCount: 3,
            noteTypes: ['Basic'],
            pendingSuggestions: 0,
            lastSyncedAt: null,
            importedAt: new Date().toISOString()
          }]
        })
      });
    });
    await page.route('**/api/state', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'you', email: 'you@example.com', name: 'You' },
          memberships: [{ deckId: 'deck-visible', userId: 'you', role: 'owner', createdAt: new Date().toISOString() }],
          decks: [{
            id: 'deck-visible',
            name: 'Visible Deck',
            description: 'Token-visible deck',
            owner: 'You',
            importedAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
            cards: [],
            media: {},
            source: { filename: 'anki', format: 'anki-addon', deckName: 'Local Boards', deckPath: 'Local Boards' }
          }],
          summaries: [{
            id: 'deck-visible',
            name: 'Visible Deck',
            description: 'Token-visible deck',
            cardCount: 12,
            noteCount: 10,
            tagCount: 3,
            noteTypes: ['Basic'],
            pendingSuggestions: 0,
            lastSyncedAt: new Date().toISOString(),
            importedAt: new Date().toISOString()
          }],
          activeDeckId: 'deck-visible',
          role: 'owner',
          collaborators: [{ id: 'you', name: 'You', email: 'you@example.com', role: 'owner', accepted: 0 }],
          suggestions: [],
          activity: [],
          sync: {
            ankiConnectUrl: null,
            connected: false,
            lastCheckedAt: new Date().toISOString(),
            lastPullAt: null,
            lastPushAt: new Date().toISOString(),
            lastAddonSync: {
              syncedAt: new Date().toISOString(),
              source: 'DeckBridge Sync',
              client: { name: 'DeckBridge Sync', version: '0.1.0', fingerprint: 'test-host' },
              stats: { total: 12, created: 2, updated: 1, skipped: 9, conflicts: 0, dryRun: true }
            },
            conflicts: []
          }
        })
      });
    });

    await page.getByRole('button', { name: /Connect Anki/ }).click();
    await page.getByRole('button', { name: /Already installed/ }).click();
    await page.getByRole('button', { name: 'Create connection link' }).click();
    await page.getByRole('button', { name: /Prove sync/ }).click();
    await expect(page.getByText('Step 4: Prove Sync')).toBeVisible();
    await page.getByRole('button', { name: 'Check for sync result' }).click();
    await expect(page.getByText('Sync proof captured')).toBeVisible();
    await expect(page.getByText('12 cards scanned by DeckBridge Sync.')).toBeVisible();
    await expect(page.getByText('2 new · 1 updated · 9 unchanged.')).toBeVisible();
  });

  test('shows true empty mapping state when token-visible decks are empty', async ({ page }) => {
    await page.route('**/api/tokens', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'token-empty',
          raw: 'db_empty_token',
          label: 'Anki Add-on',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        })
      });
    });
    await page.route('**/api/me', async (route) => {
      if (route.request().headers().authorization !== 'Bearer db_empty_token') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'you', email: 'you@example.com', name: 'You' },
          memberships: [],
          decks: []
        })
      });
    });

    await page.getByRole('button', { name: /Connect Anki/ }).click();
    await page.getByRole('button', { name: /Already installed/ }).click();
    await page.getByRole('button', { name: 'Create connection link' }).click();
    await expect(page.getByText(/0 DeckBridge decks visible/)).toBeVisible();

    const wizard = page.getByRole('dialog', { name: 'Connect Anki Add-on' });
    await expect(wizard.getByText('No DeckBridge decks are visible to this token.')).toBeVisible();
    await expect(wizard.getByLabel('DeckBridge Deck')).toHaveCount(0);
    await expect(wizard.getByText('DeckBridge deck ID: Select a deck')).toBeVisible();
  });
});

test.describe('Deck upload', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('uploads an actual .apkg file through the Upload button', async ({ page }) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deckbridge-apkg-'));
    const apkgPath = path.join(tempDir, 'actual-upload.apkg');

    try {
      await createMinimalApkg(apkgPath);
      await page.setInputFiles('#deck-upload', apkgPath);

      await expect(page.getByText('Imported actual-upload.apkg')).toBeVisible();
      await expect(page.getByRole('button', { name: /Actual Upload Deck/ })).toBeVisible();
      await expect(page.getByRole('row', { name: /Actual APKG front/ })).toBeVisible();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
