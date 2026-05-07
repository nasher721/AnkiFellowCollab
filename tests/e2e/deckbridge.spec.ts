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
    await expect(page.getByText('1 pending suggestions')).toBeVisible();
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
    await page.getByRole('button', { name: 'Collaborator' }).click();
    await page.getByRole('button', { name: /Suggest edit/ }).click();
    await expect(page.getByText(/Suggestion added/)).toBeVisible();
    await page.getByRole('button', { name: 'Owner' }).click();
    await page.getByRole('button', { name: /Reject/ }).click();
    await expect(page.getByText(/Suggestion rejected/)).toBeVisible();
  });

  test('collaborator can suggest edit', async ({ page }) => {
    await page.getByRole('button', { name: 'Collaborator' }).click();
    await page.getByRole('button', { name: /Suggest edit/ }).click();
    await expect(page.getByText(/Suggestion added/)).toBeVisible();
  });
});

test.describe('Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('switches to Study tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Study' }).click();
    await expect(page.locator('.study-overlay')).toBeVisible();
  });

  test('switches to Analytics tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Analytics' }).click();
    await expect(page.getByRole('button', { name: 'Analytics' })).toHaveClass(/active/);
  });

  test('switches to Activity tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.locator('.activity-timeline')).toBeVisible();
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
    await expect(page.getByText('Step 2: Generate Your Token')).toBeVisible();
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
    await page.getByRole('button', { name: 'Generate Token' }).click();

    await expect(page.getByText('Step 3: Connect the Add-on')).toBeVisible();
    await expect(page.getByText('db_test_token')).toBeVisible();
    await expect(page.getByRole('link', { name: /Auto-Configure/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Test / Refresh' }).click();
    await expect(page.getByText(/Connected as You/)).toBeVisible();

    await page.getByRole('button', { name: 'Next →' }).click();
    await expect(page.getByLabel('DeckBridge Deck')).toHaveValue('deck-visible');
    await expect(page.getByRole('link', { name: /Auto-Configure with Mapping/ })).toHaveCount(0);
    await page.getByLabel('Conflict Policy').selectOption('overwrite-platform');
    await page.getByLabel('Local Anki Deck').fill('Zanki Step 2 CK::Cardiology');
    await expect(page.getByText('DeckBridge deck ID: deck-visible')).toBeVisible();
    await expect(page.getByText('Local Anki deck: Zanki Step 2 CK::Cardiology')).toBeVisible();
    await expect(page.getByText('Conflict policy: overwrite-platform')).toBeVisible();
    await expect(page.getByRole('link', { name: /Auto-Configure with Mapping/ })).toHaveAttribute(
      'href',
      'anki://deckbridge?url=http%3A%2F%2F127.0.0.1%3A5174&token=db_test_token&deckId=deck-visible&localDeck=Zanki%20Step%202%20CK%3A%3ACardiology&conflictPolicy=overwrite-platform'
    );
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
    await page.getByRole('button', { name: 'Generate Token' }).click();
    await page.getByRole('button', { name: 'Test / Refresh' }).click();
    await expect(page.getByText(/0 DeckBridge decks visible/)).toBeVisible();

    await page.getByRole('button', { name: 'Next →' }).click();
    const wizard = page.getByRole('dialog', { name: 'Connect Anki Add-on' });
    await expect(wizard.getByText('No DeckBridge decks are visible to this token.')).toBeVisible();
    await expect(wizard.getByLabel('DeckBridge Deck')).toHaveCount(0);
    await expect(wizard.getByText('DeckBridge deck ID: Select a deck')).toBeVisible();
  });
});
