import { expect, test } from '@playwright/test';

test.describe('Workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads the app with demo deck', async ({ page }) => {
    await expect(page.getByText('DeckBridge')).toBeVisible();
    await expect(page.getByText('Zanki Step 2 CK')).toBeVisible();
    await expect(page.getByText('Review Queue')).toBeVisible();
  });

  test('displays cards in the table', async ({ page }) => {
    await expect(page.getByText('Microscopic polyangiitis')).toBeVisible();
    await expect(page.getByText('H. pylori')).toBeVisible();
  });

  test('searches cards', async ({ page }) => {
    const search = page.getByPlaceholder('Search cards...');
    await search.fill('Vitamin');
    await expect(page.getByText('subacute combined degeneration')).toBeVisible();
    await expect(page.getByText('Microscopic polyangiitis')).not.toBeVisible();
  });

  test('filters by tag', async ({ page }) => {
    await page.getByLabel('Filter by tag').selectOption('Rheumatology');
    await expect(page.getByText('Microscopic polyangiitis')).toBeVisible();
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
    await expect(page.getByText('Maya Patel')).toBeVisible();
  });

  test('displays suggestion diff', async ({ page }) => {
    await expect(page.getByText('ANCA autoantibody')).toBeVisible();
  });

  test('owner can accept suggestion', async ({ page }) => {
    await page.getByRole('button', { name: /Accept/ }).click();
    await expect(page.getByText(/Suggestion accepted/)).toBeVisible();
  });

  test('owner can reject suggestion', async ({ page }) => {
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
});
