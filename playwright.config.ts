import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  webServer: {
    command: 'DECKBRIDGE_DATA_DIR=$(mktemp -d /tmp/deckbridge-e2e.XXXXXX) DECKBRIDGE_REPOSITORY=local SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY= VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 30_000
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5174'
  }
});
