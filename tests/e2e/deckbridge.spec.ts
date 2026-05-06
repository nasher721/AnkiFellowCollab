import { expect, test } from '@playwright/test';

test('owner can load the shared deck workspace', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('DeckBridge')).toBeVisible();
  await expect(page.getByText('Review Queue')).toBeVisible();
});
