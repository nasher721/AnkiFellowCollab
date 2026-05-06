import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  webServer: {
    command: 'DECKBRIDGE_DATA_DIR=/tmp/deckbridge-e2e npm run dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5174'
  }
});
