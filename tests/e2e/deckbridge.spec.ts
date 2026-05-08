import { expect, test } from '@playwright/test';

test.describe('Workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads the app with demo deck', async ({ page }) => {
    await expect(page.getByText('DeckBridge')).toBeVisible();
    await expect(page.getByRole('button', { name: /Zanki Step 2 CK/ })).toBeVisible();
    await expect(page.getByText('Review Queue')).toBeVisible();
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
  });

  test('shows pending suggestions', async ({ page }) => {
    await expect(page.getByText('1 pending')).toBeVisible();
    await expect(page.getByRole('button', { name: /Maya Patel.*pending/ })).toBeVisible();
  });

  test('filters the review queue by status and author', async ({ page }) => {
    await expect(page.getByLabel('Filter review queue by status')).toHaveValue('pending');
    await page.getByLabel('Filter review queue by author').selectOption('Maya Patel');
    await expect(page.getByRole('button', { name: /Maya Patel.*pending/ })).toBeVisible();
    await page.getByLabel('Filter review queue by status').selectOption('accepted');
    await expect(page.getByText('No suggestions match the queue filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByRole('button', { name: /Maya Patel.*pending/ })).toBeVisible();
  });

  test('displays suggestion diff', async ({ page }) => {
    await expect(page.getByText('ANCA autoantibody')).toBeVisible();
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

  test('switches to Cards tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveClass(/active/);
    await expect(page.getByRole('row', { name: /Microscopic polyangiitis/ })).toBeVisible();
  });

  test('switches to Stats tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Stats' }).click();
    await expect(page.getByText('Deck stats')).toBeVisible();
    await expect(page.getByText('Suggestion flow')).toBeVisible();
  });

  test('switches to Analytics tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Analytics' }).click();
    await expect(page.getByRole('button', { name: 'Analytics' })).toHaveClass(/active/);
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
    await expect.poll(() => listedShareLinks).toBe(true);
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
    await expect(page.getByText('Review Queue')).toBeVisible();
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
